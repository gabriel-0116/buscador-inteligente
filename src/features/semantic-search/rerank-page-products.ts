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
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

  // 1) Hard guard: mustNotMatch.
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

  if (sameFg) reasons.push("mesma função comercial");
  else if (relatedFg) reasons.push("função comercial próxima");
  if (mainOk) reasons.push("produto principal compatível");
  if (colors > 0) reasons.push(`cor em comum (${colors})`);
  if (attrs.visual + attrs.technical > 0)
    reasons.push(
      `atributos compatíveis (${attrs.visual + attrs.technical})`
    );

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
        confidence: similarity >= 0.7 ? "high" : "medium",
        score: 0.92 * similarity + 0.08,
        reason: reasons.join(", ") || "produto equivalente",
      };
    }

    if (mainOk) {
      return {
        mention: candidate,
        matchType: "equivalent",
        confidence: similarity >= 0.62 ? "medium" : "low",
        score: 0.85 * similarity + 0.05,
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
      score: 0.7 * similarity,
      reason: reasons.join(", ") || "mesma função comercial",
    };
  }

  // 4) Related function group → variant / related.
  if (relatedFg) {
    return {
      mention: candidate,
      matchType: "variant",
      confidence: similarity >= 0.7 ? "medium" : "low",
      score: 0.55 * similarity,
      reason: reasons.join(", ") || "função comercial próxima",
    };
  }

  // 5) Otherwise: related but not match (or rejected for very low similarity).
  if (similarity < 0.35) {
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
    score: 0.35 * similarity,
    reason: "Função comercial diferente, mas algum sinal textual em comum.",
  };
}
