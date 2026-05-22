import type { PdfLayoutBlock, PdfLayoutPage } from "./pdf-layout-extractor";

// ── Public type ──────────────────────────────────────────────────────────────

export type PdfLayoutCard = {
  /** Pixel coordinates in the *rendered* page image. */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "PDF_LAYOUT";
  /** Concatenated text of the cluster (product code / description), if any. */
  text?: string;
};

// ── Tuning constants ─────────────────────────────────────────────────────────
//
// All thresholds are fractions of the rendered page dimensions so they hold
// across catalogs with different page sizes and render DPIs.

// Bands at the very top/bottom are page furniture (running header, page number).
const HEADER_FRAC = 0.05;
const FOOTER_FRAC = 0.05;
// An image/drawing this large is a full-page background, not a product photo.
const FULL_PAGE_FRAC = 0.9;
const BACKGROUND_AREA_FRAC = 0.85;
// Thin full-width elements are dividers / banners, never a card on their own.
const THIN_BAR_WIDTH_FRAC = 0.8;
const THIN_BAR_HEIGHT_FRAC = 0.04;
// Two *images* merge into one anchor only when they are essentially touching
// or overlapping — i.e. fragments of the same photo. Kept tight so distinct
// grid cells never merge.
const IMAGE_MERGE_GAP_X_FRAC = 0.015;
const IMAGE_MERGE_GAP_Y_FRAC = 0.015;
const IMAGE_MERGE_IOU = 0.2;
// A text block attaches to its nearest image anchor when it sits within this
// distance of the photo (a caption below / code beside it). Text never bridges
// two anchors, so a column of stacked products can't chain into one card.
const TEXT_ATTACH_GAP_X_FRAC = 0.04;
const TEXT_ATTACH_GAP_Y_FRAC = 0.05;
// A caption must share most of its span with the photo's column/row, and a
// near-full-width block is a banner/section header, never a single caption —
// both guards stop a card from being stretched across neighbouring columns.
const TEXT_OVERLAP_FRAC = 0.4;
const TEXT_MAX_WIDTH_FRAC = 0.55;
// Grow the final box a touch to include card padding / borders.
const EXPAND_FRAC = 0.03;
// Clusters smaller than this aren't product cards (stray icons, bullets).
const MIN_CARD_W_FRAC = 0.08;
const MIN_CARD_H_FRAC = 0.05;
// A cluster covering most of the page is page-like — drop it (vision/heuristic
// can have a go at that page instead).
const MAX_CARD_AREA_FRAC = 0.6;
// Extreme aspect ratios are bars / full columns, never a single card.
const MAX_ASPECT = 4.0;
const DEDUPE_IOU = 0.6;
const CARD_CONFIDENCE = 0.85;
const MAX_TEXT_LEN = 160;

// ── Internal geometry ────────────────────────────────────────────────────────

type PxBlock = {
  type: PdfLayoutBlock["type"];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  text?: string;
};

type Rect = { x1: number; y1: number; x2: number; y2: number };

function area(r: Rect): number {
  return Math.max(0, r.x2 - r.x1) * Math.max(0, r.y2 - r.y1);
}

function union(a: Rect, b: Rect): Rect {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/** Gap between two rects on each axis (0 when they overlap on that axis). */
function gap(a: Rect, b: Rect): { dx: number; dy: number } {
  const dx = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2));
  const dy = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
  return { dx, dy };
}

/** Overlap length on each axis (0 when the rects don't overlap there). */
function overlap(a: Rect, b: Rect): { ox: number; oy: number } {
  const ox = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const oy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  return { ox, oy };
}

function iou(a: Rect, b: Rect): number {
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (inter <= 0) return 0;
  return inter / (area(a) + area(b) - inter);
}

// ── Union-find ───────────────────────────────────────────────────────────────

function makeUnionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function unite(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  return { find, unite };
}

// ── Detector ─────────────────────────────────────────────────────────────────

/**
 * Group the structural blocks of one PDF page into product-card bounding boxes,
 * expressed in rendered-image pixels.
 *
 * Strategy:
 *   1. Scale every block from PDF points to rendered pixels.
 *   2. Drop page furniture: header/footer bands, page numbers, tiny fragments,
 *      thin full-width bars, and full-page background images/drawings.
 *   3. Anchor on images: merge only images that touch/overlap (fragments of one
 *      photo). Distinct grid cells stay separate.
 *   4. Attach each text block to its single nearest image anchor (caption /
 *      code). Text never bridges two anchors, so a column of stacked products
 *      can't chain into one giant card.
 *   5. Expand slightly, reject page-like / bar / column / tiny boxes, dedupe by
 *      IoU. (A page with no product photo yields no cards.)
 */
export function detectCardsFromPdfLayout(args: {
  pageLayout: PdfLayoutPage;
  renderedPageWidth: number;
  renderedPageHeight: number;
}): PdfLayoutCard[] {
  const { pageLayout, renderedPageWidth: PW, renderedPageHeight: PH } = args;

  if (pageLayout.width <= 0 || pageLayout.height <= 0 || PW <= 0 || PH <= 0) {
    return [];
  }

  const scaleX = PW / pageLayout.width;
  const scaleY = PH / pageLayout.height;
  const pageArea = PW * PH;

  // 1 + 2: scale to pixels and filter out page furniture / backgrounds.
  const blocks: PxBlock[] = [];
  for (const b of pageLayout.blocks) {
    const x1 = b.x * scaleX;
    const y1 = b.y * scaleY;
    const x2 = (b.x + b.width) * scaleX;
    const y2 = (b.y + b.height) * scaleY;
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 1 || h <= 1) continue;

    // Full-page background image / drawing → ignore (keeps it from swallowing
    // every other block into one giant cluster).
    const isFullPage =
      (w >= FULL_PAGE_FRAC * PW && h >= FULL_PAGE_FRAC * PH) ||
      w * h >= BACKGROUND_AREA_FRAC * pageArea;
    if (isFullPage && b.type !== "text") continue;

    // Thin full-width bar (divider / banner) → ignore.
    if (w >= THIN_BAR_WIDTH_FRAC * PW && h <= THIN_BAR_HEIGHT_FRAC * PH)
      continue;

    // Header / footer furniture (text & drawings only — a product image in the
    // band is unusual but we keep it just in case).
    const cy = (y1 + y2) / 2;
    const inHeaderFooter = cy < HEADER_FRAC * PH || cy > (1 - FOOTER_FRAC) * PH;
    if (inHeaderFooter && b.type !== "image") continue;

    blocks.push({
      type: b.type,
      x1,
      y1,
      x2,
      y2,
      text: b.text,
    });
  }

  const images = blocks.filter((b) => b.type === "image");
  const texts = blocks.filter((b) => b.type === "text");
  if (images.length === 0) {
    // No product photos on this page → nothing for the layout detector to do.
    return [];
  }

  // 3: merge only images that touch/overlap → one anchor per product photo.
  const imgGapX = IMAGE_MERGE_GAP_X_FRAC * PW;
  const imgGapY = IMAGE_MERGE_GAP_Y_FRAC * PH;
  const uf = makeUnionFind(images.length);
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const { dx, dy } = gap(images[i], images[j]);
      const touching = dx <= imgGapX && dy <= imgGapY;
      if (touching || iou(images[i], images[j]) > IMAGE_MERGE_IOU) {
        uf.unite(i, j);
      }
    }
  }

  type Anchor = { imageBox: Rect; cardBox: Rect; texts: string[] };
  const anchorByRoot = new Map<number, Anchor>();
  for (let i = 0; i < images.length; i++) {
    const root = uf.find(i);
    const img = images[i];
    const existing = anchorByRoot.get(root);
    if (existing) {
      existing.imageBox = union(existing.imageBox, img);
      existing.cardBox = union(existing.cardBox, img);
    } else {
      anchorByRoot.set(root, {
        imageBox: { ...img },
        cardBox: { ...img },
        texts: [],
      });
    }
  }
  const anchors = [...anchorByRoot.values()];

  // 4: attach each text to its single nearest anchor (distance measured against
  // the frozen image box so attachment order doesn't drift the result).
  const attachX = TEXT_ATTACH_GAP_X_FRAC * PW;
  const attachY = TEXT_ATTACH_GAP_Y_FRAC * PH;
  const maxTextWidth = TEXT_MAX_WIDTH_FRAC * PW;
  for (const t of texts) {
    // A near-full-width block is a banner / section header, not a caption.
    if (t.x2 - t.x1 > maxTextWidth) continue;
    const tw = t.x2 - t.x1;
    const th = t.y2 - t.y1;

    let best: Anchor | undefined;
    let bestDist = Infinity;
    for (const a of anchors) {
      const { dx, dy } = gap(t, a.imageBox);
      const { ox, oy } = overlap(t, a.imageBox);
      const iw = a.imageBox.x2 - a.imageBox.x1;
      const ih = a.imageBox.y2 - a.imageBox.y1;
      // Caption below/above the photo (shares its column) …
      const isCaption =
        dy <= attachY && ox >= TEXT_OVERLAP_FRAC * Math.min(tw, iw);
      // … or a code/label beside the photo (shares its row).
      const isSideLabel =
        dx <= attachX && oy >= TEXT_OVERLAP_FRAC * Math.min(th, ih);
      if ((isCaption || isSideLabel) && dx + dy < bestDist) {
        bestDist = dx + dy;
        best = a;
      }
    }
    if (best) {
      best.cardBox = union(best.cardBox, t);
      if (t.text) best.texts.push(t.text);
    }
  }

  // 5: expand, reject, dedupe.
  const minW = MIN_CARD_W_FRAC * PW;
  const minH = MIN_CARD_H_FRAC * PH;

  const cards: PdfLayoutCard[] = [];
  for (const a of anchors) {
    const ew = (a.cardBox.x2 - a.cardBox.x1) * EXPAND_FRAC;
    const eh = (a.cardBox.y2 - a.cardBox.y1) * EXPAND_FRAC;
    const box: Rect = {
      x1: Math.max(0, a.cardBox.x1 - ew),
      y1: Math.max(0, a.cardBox.y1 - eh),
      x2: Math.min(PW, a.cardBox.x2 + ew),
      y2: Math.min(PH, a.cardBox.y2 + eh),
    };

    const w = box.x2 - box.x1;
    const h = box.y2 - box.y1;
    if (w < minW || h < minH) continue; // too small
    if (area(box) > MAX_CARD_AREA_FRAC * pageArea) continue; // page-like
    const aspect = w / h;
    if (aspect > MAX_ASPECT || aspect < 1 / MAX_ASPECT) continue; // bar / column

    const text = a.texts
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT_LEN);

    cards.push({
      x: box.x1,
      y: box.y1,
      width: w,
      height: h,
      confidence: CARD_CONFIDENCE,
      source: "PDF_LAYOUT",
      text: text || undefined,
    });
  }

  return dedupeCardsByIoU(cards, DEDUPE_IOU);
}

/** Drop near-duplicate boxes, keeping the larger (more complete) card. */
function dedupeCardsByIoU(
  cards: PdfLayoutCard[],
  threshold: number
): PdfLayoutCard[] {
  const sorted = [...cards].sort(
    (a, b) => b.width * b.height - a.width * a.height
  );
  const kept: PdfLayoutCard[] = [];
  for (const card of sorted) {
    const cardRect: Rect = {
      x1: card.x,
      y1: card.y,
      x2: card.x + card.width,
      y2: card.y + card.height,
    };
    const dup = kept.some((k) => {
      const kRect: Rect = {
        x1: k.x,
        y1: k.y,
        x2: k.x + k.width,
        y2: k.y + k.height,
      };
      return iou(cardRect, kRect) > threshold;
    });
    if (!dup) kept.push(card);
  }
  return kept;
}
