import type { PdfLayoutPage } from "./pdf-layout-extractor";
import {
  estimateProductCount,
  extractProductSignals,
  type ProductSignals,
} from "./product-signals";

// ── Page-type classification ─────────────────────────────────────────────────
//
// Generic, color-agnostic. Decides what a catalog page *is* from its extracted
// text and layout, so the detector can skip non-product pages (cover, summary,
// index) and pick the right strategy for product pages. Never keys on a
// specific supplier or color.

export type CatalogPageType =
  | "cover"
  | "summary"
  | "category_grid"
  | "partial_grid"
  | "single_product"
  | "non_product"
  | "unknown";

// A page with at least this many products is treated as a full grid.
const FULL_GRID_MIN = 6;
// "Category … pageNumber" lines that mark a summary/index.
const SUMMARY_MIN_ENTRIES = 5;
// A single image covering this fraction of the page is cover art / background.
const COVER_IMAGE_FRAC = 0.35;
const COVER_KEYWORDS =
  /\b(cat[aá]logo|novidades|produtos|cole[cç][aã]o|institucional)\b/i;
const SUMMARY_KEYWORDS = /\b(sum[aá]rio|[ií]ndice|index|conte[uú]do)\b/i;

function largestImageFraction(pageLayout: PdfLayoutPage): number {
  const pageArea = pageLayout.width * pageLayout.height;
  if (pageArea <= 0) return 0;
  let max = 0;
  for (const b of pageLayout.blocks) {
    if (b.type !== "image") continue;
    const frac = (b.width * b.height) / pageArea;
    if (frac > max) max = frac;
  }
  return max;
}

function imageCount(pageLayout: PdfLayoutPage): number {
  return pageLayout.blocks.filter((b) => b.type === "image").length;
}

export function classifyCatalogPage(args: {
  pageNumber: number;
  pageText: string;
  pageLayout?: PdfLayoutPage;
  renderedWidth: number;
  renderedHeight: number;
}): CatalogPageType {
  const { pageText, pageLayout } = args;

  // Without structure we can't classify — let the cascade try its detectors.
  if (!pageLayout) return "unknown";

  const signals: ProductSignals = extractProductSignals({ text: pageText });
  const products = estimateProductCount(signals);
  const imgFrac = largestImageFraction(pageLayout);
  const imgs = imageCount(pageLayout);

  // ── Summary / index ─────────────────────────────────────────────────────
  // Many "Category … pageNumber" entries and almost no product markers.
  const isSummaryShape =
    signals.categoryWords.length >= SUMMARY_MIN_ENTRIES && products <= 2;
  if (isSummaryShape || (SUMMARY_KEYWORDS.test(pageText) && products <= 2)) {
    return "summary";
  }

  // ── Product pages (driven by reliable per-product counters) ──────────────
  if (products >= FULL_GRID_MIN) return "category_grid";
  if (products >= 2) return "partial_grid";
  if (products === 1) return "single_product";

  // ── No product signal at all ─────────────────────────────────────────────
  // Cover: dominant artwork and/or cover keywords with no products.
  if (
    imgFrac >= COVER_IMAGE_FRAC ||
    (COVER_KEYWORDS.test(pageText) && imgs <= 2)
  ) {
    return "cover";
  }
  // Several photos but no detectable codes/prices → can't be sure it's empty;
  // let the detectors try rather than wrongly skipping real products.
  if (imgs >= 3) return "unknown";

  // Otherwise: index/table/blank/etc. — nothing to index.
  return "non_product";
}

/** Pages whose products we must never index. */
export function isNonProductPage(type: CatalogPageType): boolean {
  return type === "cover" || type === "summary" || type === "non_product";
}
