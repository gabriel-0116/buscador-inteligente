// ── Product signal extraction ────────────────────────────────────────────────
//
// Generic, color-agnostic text signals that tell us "this is product content"
// and, crucially, *how many distinct products* a chunk of text covers. Used by
// the page classifier, the grid detector, and per-crop validation.
//
// Calibration note: a single product's description can contain several
// code-like tokens (e.g. "X200儿童相机/ 包好/ DQ-226" has both `X200` and
// `DQ-226`). So product *codes* are a weak per-product counter. The packaging
// lines (`PCS/CX`, `Unid.CX`) and `R$` prices appear exactly once per product
// and are the reliable counters — see `looksMultiProduct`.

export type ProductSignals = {
  /** Distinct product-code-like tokens (deduped, uppercased). */
  productCodes: string[];
  /** Count of `R$` prices. */
  priceCount: number;
  /** Count of `PCS/CX` markers. */
  pcsCxCount: number;
  /** Count of `UNID.CX` / `Unid.CX` markers. */
  unitCxCount: number;
  /** Count of bullet / numbered-list lines. */
  bulletCount: number;
  /** Left-hand side of "Category … <pageNumber>" lines (summary/index hints). */
  categoryWords: string[];
};

// EL-1108, EL-4043-CC, EL-1407-5G, DSZJ-800, DQ-226, TX-3008, X200, J-60 …
// The optional suffix requires a hyphen so the match can't swallow an adjacent
// space-separated quantity / word (e.g. "DSZJ-800 PCS" or "EL-1177 60").
const CODE_RE = /\b[A-Z]{1,4}[-\s]?\d{2,5}(?:-[A-Z0-9]{1,5})?\b/g;
// R$ 15,9 · R$ 1133 · R$15.90
const PRICE_RE = /R\$\s?\d{1,4}(?:[.,]\d{1,3})?/g;
const PCS_CX_RE = /PCS\s*\/\s*CX/gi;
const UNIT_CX_RE = /UNID\.?\s*CX/gi;
const BULLET_LINE_RE = /^\s*(?:[•▪◦‣·\-–]|\d+[.)])\s+\S/;
// "Caixa de Som 6", "Rádio 18", "Memória e Pendrive 60" — a category followed
// by a page number. Many of these on one page ⇒ summary/index.
const SUMMARY_ENTRY_RE = /^\s*(.{2,40}?)\s+\d{1,3}\s*$/;

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export function extractProductSignals(args: { text: string }): ProductSignals {
  const text = args.text ?? "";

  const rawCodes = text.match(CODE_RE) ?? [];
  const productCodes = [
    ...new Set(rawCodes.map((c) => c.replace(/\s+/g, "").toUpperCase())),
  ];

  let bulletCount = 0;
  const categoryWords: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (BULLET_LINE_RE.test(line)) bulletCount++;
    const summary = SUMMARY_ENTRY_RE.exec(line);
    if (summary) {
      const label = summary[1].trim();
      // Reject lines that are themselves product signals (price / packaging).
      if (!/R\$|PCS\s*\/\s*CX|UNID/i.test(label) && /[A-Za-zÀ-ÿ]/.test(label)) {
        categoryWords.push(label);
      }
    }
  }

  return {
    productCodes,
    priceCount: countMatches(text, PRICE_RE),
    pcsCxCount: countMatches(text, PCS_CX_RE),
    unitCxCount: countMatches(text, UNIT_CX_RE),
    bulletCount,
    categoryWords,
  };
}

/** True when the text has at least one strong product marker. */
export function hasProductSignal(s: ProductSignals): boolean {
  return (
    s.productCodes.length > 0 ||
    s.priceCount > 0 ||
    s.pcsCxCount > 0 ||
    s.unitCxCount > 0
  );
}

/**
 * True when the text almost certainly covers more than one product. Driven by
 * the per-product counters (price / PCS-CX / UNID-CX appear once per product);
 * codes only flag multi when there are ≥3 (a single product can legitimately
 * show 2 code-like tokens).
 */
export function looksMultiProduct(s: ProductSignals): boolean {
  return (
    s.priceCount >= 2 ||
    s.pcsCxCount >= 2 ||
    s.unitCxCount >= 2 ||
    s.productCodes.length >= 3
  );
}

/**
 * Rough product count for a page, from the reliable per-product counters.
 * Falls back to distinct codes when there's no price/packaging info.
 */
export function estimateProductCount(s: ProductSignals): number {
  return Math.max(
    s.priceCount,
    s.pcsCxCount,
    s.unitCxCount,
    s.productCodes.length
  );
}
