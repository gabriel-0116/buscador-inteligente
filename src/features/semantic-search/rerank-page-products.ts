import type { ImageQueryProfile } from "@/features/visual-search/query-image-analyzer";

// ── Commercial reranker ─────────────────────────────────────────────────────
//
// pgvector gives us neighbours by *textual* similarity. That's necessary but
// not sufficient. The reranker compares structured fields in this order of
// priority (per PAGE_LEVEL_SEARCH_REFACTOR.md):
//
//   1. function group
//   2. main product
//   3. category
//   4. technical attributes
//   5. visual attributes
//   6. color
//   7. general appearance
//
// Color and appearance never beat function group.

export type RerankMatchType =
  | "exact"
  | "equivalent"
  | "variant"
  | "kit_contains"
  | "accessory"
  | "related_but_not_match"
  | "rejected";

export type RerankConfidence = "high" | "medium" | "low";

export type PageProductMentionLike = {
  id: string;
  catalogId: string;
  pageId: string;
  pageNumber: number;
  namePt: string;
  originalName: string | null;
  brand: string | null;
  modelCodes: string[];
  aliases: string[];
  category: string | null;
  functionGroup: string | null;
  commercialUse: string | null;
  colors: string[];
  visualAttributes: string[];
  technicalAttributes: string[];
  isKit: boolean;
  kitContains: string[];
  notConfuseWith: string[];
  descriptionPt: string | null;
  evidenceText: string | null;
  // Cosine similarity (1 - distance) coming from pgvector.
  similarity: number;
};

export type RerankedMention = {
  mention: PageProductMentionLike;
  matchType: RerankMatchType;
  confidence: RerankConfidence;
  score: number;
  reason: string;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Model-code identity: collapse case + punctuation + diacritics so
// "KM-7103" == "KM7103" == "km7103". The bare normalization (3+ alphanum)
// is reused for *typing* — `isStrongModelCode` adds the strict rules a
// real SKU has to meet before we let it win the fast path.
function normalizeModelCode(value: string): string {
  const n = value
    .toUpperCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Z0-9]/g, "");
  return n.length >= 3 ? n : "";
}

// Generic terms that often appear OCR'd next to a real code but ARE NOT
// product identifiers. If we let "USB" or "5W" win, every USB charger row
// becomes "the same product as the query". All entries are stored
// pre-normalized (uppercase, no punctuation) so the lookup is O(1).
const GENERIC_CODE_DENYLIST = new Set<string>([
  "USB",
  "USBC",
  "USBA",
  "TYPEC",
  "TYPEA",
  "TYPEB",
  "LIGHTNING",
  "MICROUSB",
  "MINIUSB",
  "IPX4",
  "IPX5",
  "IPX6",
  "IPX7",
  "IPX8",
  "RPM",
  "5W",
  "10W",
  "15W",
  "18W",
  "20W",
  "25W",
  "30W",
  "33W",
  "45W",
  "65W",
  "100W",
  "7500RPM",
  "FAST",
  "CHARGE",
  "CHARGER",
  "FASTCHARGE",
  "FASTCHARGING",
  "PD",
  "QC",
  "QC3",
  "QC30",
  "QC4",
  "BT",
  "BLE",
  "WIFI",
  "OEM",
  "ODM",
  "NEW",
  "MODEL",
  "SKU",
  "ID",
  "REF",
]);

// A *strong* model code:
//   1) normalized length >= 5,
//   2) contains at least one letter AND one digit,
//   3) is not a generic term ("USB", "5W", "FASTCHARGE", …).
// We never base exact/high decisions on anything that fails this check.
export function isStrongModelCode(value: string): boolean {
  const n = normalizeModelCode(value);
  if (n.length < 5) return false;
  if (GENERIC_CODE_DENYLIST.has(n)) return false;
  const hasLetter = /[A-Z]/.test(n);
  const hasDigit = /[0-9]/.test(n);
  return hasLetter && hasDigit;
}

// Normalize + accept only strong codes. Returns "" for anything else so we
// never accidentally match a weak code against a strong one in a Set.
function strongCodeKey(value: string): string {
  return isStrongModelCode(value) ? normalizeModelCode(value) : "";
}

// Both sides must explicitly list the code in `modelCodes` AND it must be
// a strong code. This is the only path that beats `mustNotMatch`.
function explicitStrongCodeMatches(
  queryCodes: string[],
  candidateCodes: string[]
): string[] {
  if (queryCodes.length === 0 || candidateCodes.length === 0) return [];
  const qSet = new Set(queryCodes.map(strongCodeKey).filter((s) => s.length > 0));
  if (qSet.size === 0) return [];
  const hits: string[] = [];
  for (const c of candidateCodes) {
    const key = strongCodeKey(c);
    if (key && qSet.has(key)) hits.push(c);
  }
  return hits;
}

// Looser path: a visibleText entry (typically OCR from the user's image)
// that *looks* like a strong code and matches one of the candidate's
// strong codes. Never enough alone to beat mustNotMatch or functionGroup
// — only a bonus.
function strongVisibleTextCodeHints(
  visibleText: string[],
  candidateCodes: string[]
): string[] {
  if (visibleText.length === 0 || candidateCodes.length === 0) return [];
  const cSet = new Set(
    candidateCodes.map(strongCodeKey).filter((s) => s.length > 0)
  );
  if (cSet.size === 0) return [];
  const hits: string[] = [];
  for (const v of visibleText) {
    const key = strongCodeKey(v);
    if (key && cSet.has(key)) hits.push(v);
  }
  return hits;
}

function sameBrand(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  if (!query.brand || !candidate.brand) return false;
  return normalize(query.brand) === normalize(candidate.brand);
}

// Loose substring/word overlap of visibleText vs the candidate's strong
// fields (brand / aliases / originalName / evidenceText). Each hit gives a
// tiny score bump — never enough alone to upgrade match type.
function visibleTextOverlap(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): number {
  if (query.visibleText.length === 0) return 0;
  const haystack = " " + normalize(
    [
      candidate.brand ?? "",
      candidate.originalName ?? "",
      candidate.evidenceText ?? "",
      ...candidate.aliases,
      ...candidate.modelCodes,
    ]
      .filter(Boolean)
      .join(" ")
  ) + " ";
  let hits = 0;
  for (const term of query.visibleText) {
    const n = normalize(term);
    if (n.length < 3) continue;
    if (haystack.includes(" " + n + " ") || haystack.includes(n)) {
      hits++;
    }
  }
  return hits;
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ").filter((t) => t.length > 0);
}

function tokenSet(values: Array<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    for (const t of tokenize(v)) set.add(t);
  }
  return set;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function containsAny(haystack: string, needles: Iterable<string>): boolean {
  const norm = " " + normalize(haystack) + " ";
  for (const n of needles) {
    const nn = normalize(n);
    if (!nn) continue;
    if (norm.includes(" " + nn + " ")) return true;
    if (nn.length >= 4 && norm.includes(nn)) return true;
  }
  return false;
}

function violatesMustNotMatch(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  if (query.mustNotMatch.length === 0) return false;
  const haystackParts = [
    candidate.namePt,
    candidate.functionGroup ?? "",
    candidate.category ?? "",
    candidate.commercialUse ?? "",
    candidate.descriptionPt ?? "",
    ...candidate.visualAttributes,
    ...candidate.technicalAttributes,
  ];
  const haystack = haystackParts.filter(Boolean).join(" ");
  return containsAny(haystack, query.mustNotMatch);
}

function sameFunctionGroup(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  if (!candidate.functionGroup) return false;
  const q = normalize(query.functionGroup);
  const c = normalize(candidate.functionGroup);
  if (!q || !c) return false;
  return q === c || c.includes(q) || q.includes(c);
}

function relatedFunctionGroup(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  if (!candidate.functionGroup) return false;
  // First token equality — e.g. camera_infantil vs camera_action.
  const [qHead] = normalize(query.functionGroup).split(" ");
  const [cHead] = normalize(candidate.functionGroup).split(" ");
  return Boolean(qHead) && qHead === cHead;
}

// ── Powered vs manual incompatibility ───────────────────────────────────────
//
// Same head, opposite operating principle: barbeador_eletrico vs
// barbeador_manual is the canonical case. They share the head "barbeador"
// so `relatedFunctionGroup` returns true, but they are NOT interchangeable
// commercially — a search for an electric shaver should never surface a
// manual razor as a public "variant".
//
// We capture this with two opposing token sets. Anything in
// POWERED_QUALIFIER_TOKENS implies "needs electricity / battery"; anything
// in MANUAL_QUALIFIER_TOKENS implies "no battery, no plug". If one fg has
// tokens from one set and the other has tokens from the opposite set,
// they're incompatible.

const POWERED_QUALIFIER_TOKENS = new Set<string>([
  "eletrico",
  "eletrica",
  "eletronico",
  "eletronica",
  "recarregavel",
  "automatico",
  "automatica",
  "digital",
  "smart",
  "wireless",
  "bluetooth",
]);

const MANUAL_QUALIFIER_TOKENS = new Set<string>([
  "manual",
  "navalha",
  "lamina",
  "laminas",
  "descartavel",
  "descartaveis",
]);

function fgTokens(fg: string | null | undefined): string[] {
  if (!fg) return [];
  return normalize(fg).split(" ").filter(Boolean);
}

function hasAny(tokens: string[], set: Set<string>): boolean {
  return tokens.some((t) => set.has(t));
}

function fgIsPowered(fg: string | null | undefined): boolean {
  return hasAny(fgTokens(fg), POWERED_QUALIFIER_TOKENS);
}

function fgIsManual(fg: string | null | undefined): boolean {
  return hasAny(fgTokens(fg), MANUAL_QUALIFIER_TOKENS);
}

// Returns `null` when compatible, or a side hint ("query_powered" /
// "query_manual") so the caller can phrase the reason directionally.
function poweredManualConflict(
  queryFg: string,
  candidateFg: string | null
): "query_powered" | "query_manual" | null {
  if (!candidateFg) return null;
  const qP = fgIsPowered(queryFg);
  const qM = fgIsManual(queryFg);
  const cP = fgIsPowered(candidateFg);
  const cM = fgIsManual(candidateFg);
  if (qP && cM) return "query_powered";
  if (qM && cP) return "query_manual";
  return null;
}

function mainProductCompatible(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  const queryTokens = tokenSet([
    query.mainProductNamePt,
    ...query.possibleSynonyms,
  ]);
  const candidateTokens = tokenSet([
    candidate.namePt,
    candidate.functionGroup ?? null,
    candidate.descriptionPt ?? null,
  ]);
  // At least one substantive token (length ≥ 4) must overlap.
  for (const t of queryTokens) {
    if (t.length >= 4 && candidateTokens.has(t)) return true;
  }
  return false;
}

function colorOverlap(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): number {
  if (query.colors.length === 0 || candidate.colors.length === 0) return 0;
  const q = tokenSet(query.colors);
  const c = tokenSet(candidate.colors);
  return intersectionSize(q, c);
}

function attributeOverlap(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): { visual: number; technical: number } {
  return {
    visual: intersectionSize(
      tokenSet(query.visualAttributes),
      tokenSet(candidate.visualAttributes)
    ),
    technical: intersectionSize(
      tokenSet(query.technicalAttributes),
      tokenSet(candidate.technicalAttributes)
    ),
  };
}

function kitContainsQuery(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): boolean {
  if (!candidate.isKit || candidate.kitContains.length === 0) return false;
  const haystack = candidate.kitContains.join(" ");
  return (
    containsAny(haystack, [
      query.mainProductNamePt,
      query.functionGroup,
      ...query.possibleSynonyms,
    ])
  );
}

// ── Main entry point ────────────────────────────────────────────────────────

export function rerankPageProductMentions(args: {
  queryProfile: ImageQueryProfile;
  candidates: PageProductMentionLike[];
}): RerankedMention[] {
  const out: RerankedMention[] = [];
  for (const candidate of args.candidates) {
    out.push(rerankSingle(args.queryProfile, candidate));
  }
  // Sort by score desc (rejected naturally falls to the bottom).
  out.sort((a, b) => b.score - a.score);
  return out;
}

function rerankSingle(
  query: ImageQueryProfile,
  candidate: PageProductMentionLike
): RerankedMention {
  const similarity = Math.max(0, Math.min(1, candidate.similarity));
  const reasons: string[] = [];

  // 0) Hardest evidence: same EXPLICIT strong code on both sides.
  //    Only when query.modelCodes and candidate.modelCodes independently
  //    list the same strong SKU. This is the only path allowed to beat
  //    `mustNotMatch` — at this point, they're literally the same product.
  const explicitCodeHits = explicitStrongCodeMatches(
    query.modelCodes,
    candidate.modelCodes
  );
  if (explicitCodeHits.length > 0) {
    return {
      mention: candidate,
      matchType: "exact",
      confidence: "high",
      score: 0.98,
      reason: `mesmo código/modelo: ${explicitCodeHits.join(", ")}`,
    };
  }

  // VisibleText → candidate.modelCodes is a *strong hint* but not a fast
  // path. We collect it now and apply as a score+confidence bonus later,
  // after `mustNotMatch` and `functionGroup` gates have run.
  const visibleCodeHints = strongVisibleTextCodeHints(
    query.visibleText,
    candidate.modelCodes
  );

  // 1) Hard guard: mustNotMatch. visibleCodeHints do NOT override this —
  //    OCR'd codes are noisy and a hard reject still wins.
  if (violatesMustNotMatch(query, candidate)) {
    return {
      mention: candidate,
      matchType: "rejected",
      confidence: "low",
      score: 0.05 + similarity * 0.05, // keep a tiny ordering signal
      reason:
        "Combina visualmente mas a função comercial está na lista mustNotMatch.",
    };
  }

  // 2) Kit case: query item is inside the candidate kit.
  if (kitContainsQuery(query, candidate)) {
    return {
      mention: candidate,
      matchType: "kit_contains",
      confidence:
        sameFunctionGroup(query, candidate) || similarity > 0.78
          ? "high"
          : "medium",
      score: 0.7 + similarity * 0.2,
      reason: `Kit contém ${query.mainProductNamePt}.`,
    };
  }

  const sameFg = sameFunctionGroup(query, candidate);
  const relatedFg = relatedFunctionGroup(query, candidate);
  const mainOk = mainProductCompatible(query, candidate);
  const colors = colorOverlap(query, candidate);
  const attrs = attributeOverlap(query, candidate);
  const brandOk = sameBrand(query, candidate);
  const visText = visibleTextOverlap(query, candidate);
  const hasVisibleCodeHint = visibleCodeHints.length > 0;

  if (sameFg) reasons.push("mesma função comercial");
  else if (relatedFg) reasons.push("função comercial próxima");
  if (mainOk) reasons.push("produto principal compatível");
  if (brandOk) reasons.push(`marca compatível (${candidate.brand})`);
  if (hasVisibleCodeHint)
    reasons.push(
      `texto visível sugere código/modelo (${visibleCodeHints.join(", ")})`
    );
  if (visText > 0) reasons.push(`texto visível compatível (${visText})`);
  if (colors > 0) reasons.push(`cor em comum (${colors})`);
  if (attrs.visual + attrs.technical > 0)
    reasons.push(
      `atributos compatíveis (${attrs.visual + attrs.technical})`
    );

  // Bonuses applied to score, never enough alone to flip match type.
  // Brand alone is intentionally weak — Kemei makes shavers AND trimmers
  // AND clippers. Brand + same functionGroup is the real signal.
  const brandBonus = brandOk && sameFg ? 0.06 : brandOk ? 0.02 : 0;
  const visTextBonus = Math.min(visText, 4) * 0.02;
  // OCR'd code matching a real catalog SKU is the strongest non-explicit
  // signal we have — sizable bump, but still gated by `sameFg` for the
  // confidence promotion below.
  const visibleCodeBonus = hasVisibleCodeHint ? 0.2 : 0;
  const totalBonus = brandBonus + visTextBonus + visibleCodeBonus;

  // 3) Same function group → exact / equivalent / variant.
  if (sameFg) {
    const allColorsMatch =
      query.colors.length === 0 ||
      candidate.colors.length === 0 ||
      colors >= Math.min(query.colors.length, candidate.colors.length);

    if (mainOk && allColorsMatch && similarity >= 0.6) {
      return {
        mention: candidate,
        matchType: "exact",
        confidence:
          similarity >= 0.7 || brandOk || hasVisibleCodeHint ? "high" : "medium",
        score: 0.92 * similarity + 0.08 + totalBonus,
        reason: reasons.join(", ") || "produto equivalente",
      };
    }

    if (mainOk) {
      return {
        mention: candidate,
        matchType: "equivalent",
        confidence:
          similarity >= 0.62 ||
          hasVisibleCodeHint ||
          (brandOk && visText > 0)
            ? "medium"
            : "low",
        score: 0.85 * similarity + 0.05 + totalBonus,
        reason: reasons.join(", ") || "mesma função, produto compatível",
      };
    }

    return {
      mention: candidate,
      matchType: "variant",
      confidence:
        similarity >= 0.7 && (colors > 0 || attrs.visual + attrs.technical > 0)
          ? "medium"
          : "low",
      score: 0.7 * similarity + totalBonus,
      reason: reasons.join(", ") || "mesma função comercial",
    };
  }

  // 4) Related function group → variant / related.
  if (relatedFg) {
    // Powered vs manual within the same head (barbeador_eletrico vs
    // barbeador_manual) is NOT a public-grade variant. Drop to
    // related_but_not_match so it's filtered out of the UI but stays
    // available in --debug.
    const conflict = poweredManualConflict(
      query.functionGroup,
      candidate.functionGroup
    );
    if (conflict) {
      const reason =
        conflict === "query_powered"
          ? "função parecida, mas produto manual não é equivalente ao produto elétrico"
          : "função parecida, mas produto elétrico não é equivalente ao produto manual";
      return {
        mention: candidate,
        matchType: "related_but_not_match",
        confidence: "low",
        score: 0.2 * similarity + totalBonus * 0.3,
        reason,
      };
    }

    return {
      mention: candidate,
      matchType: "variant",
      confidence: similarity >= 0.7 ? "medium" : "low",
      score: 0.55 * similarity + totalBonus * 0.5,
      reason: reasons.join(", ") || "função comercial próxima",
    };
  }

  // 5) Otherwise: function group differs and no code match. Hard rule from
  //    atualizacao.md Part 3: never high/medium confidence here, brand alone
  //    can NOT promote — at most related_but_not_match.
  if (similarity < 0.35 && !brandOk && visText === 0) {
    return {
      mention: candidate,
      matchType: "rejected",
      confidence: "low",
      score: 0.05 + similarity * 0.05,
      reason: "Função comercial diferente e baixa similaridade textual.",
    };
  }

  return {
    mention: candidate,
    matchType: "related_but_not_match",
    confidence: "low",
    score: 0.35 * similarity + totalBonus * 0.5,
    reason:
      reasons.length > 0
        ? `Função diferente; sinais fracos: ${reasons.join(", ")}.`
        : "Função comercial diferente, mas algum sinal textual em comum.",
  };
}
