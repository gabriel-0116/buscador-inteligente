import type { PdfLayoutBlock, PdfLayoutPage } from "./pdf-layout-extractor";
import type { CatalogPageType } from "./page-type-classifier";
import { extractProductSignals, hasProductSignal } from "./product-signals";

// ── Grid layout detector ─────────────────────────────────────────────────────
//
// Detects individual product cards from the *text+geometry* of the PDF, not
// from images alone. The key idea: every product carries a per-product marker
// (code / price / PCS-CX) at a known position. Clustering those marker
// positions reveals the real rows and columns, so a 3×3 page yields 9 cells —
// and a merged "2 products in one box" can't happen.

export type GridProductBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  source: "GRID_LAYOUT";
  reason: string;
};

const HEADER_FRAC = 0.05;
const FOOTER_FRAC = 0.05;
const COL_GAP_FRAC = 0.1; // min x-gap (of page width) between columns
const ROW_GAP_FRAC = 0.06; // min y-gap (of page height) between rows
const EXPAND_FRAC = 0.04;
const MIN_CELL_W_FRAC = 0.08;
const MIN_CELL_H_FRAC = 0.05;
const GRID_CONFIDENCE = 0.9;

type Rect = { x1: number; y1: number; x2: number; y2: number };

function blockRectPx(b: PdfLayoutBlock, scaleX: number, scaleY: number): Rect {
  return {
    x1: b.x * scaleX,
    y1: b.y * scaleY,
    x2: (b.x + b.width) * scaleX,
    y2: (b.y + b.height) * scaleY,
  };
}

function centerX(r: Rect): number {
  return (r.x1 + r.x2) / 2;
}
function centerY(r: Rect): number {
  return (r.y1 + r.y2) / 2;
}

function union(a: Rect, b: Rect): Rect {
  return {
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
    x2: Math.max(a.x2, b.x2),
    y2: Math.max(a.y2, b.y2),
  };
}

/** Cluster 1-D values; start a new cluster when the gap exceeds `minGap`. */
function cluster1d(values: number[], minGap: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > minGap) clusters.push([sorted[i]]);
    else clusters[clusters.length - 1].push(sorted[i]);
  }
  // cluster centers (means)
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

/** Midpoint boundaries between sorted cluster centers, bounded by [lo, hi]. */
function boundaries(centers: number[], lo: number, hi: number): number[] {
  const out = [lo];
  for (let i = 0; i < centers.length - 1; i++) {
    out.push((centers[i] + centers[i + 1]) / 2);
  }
  out.push(hi);
  return out;
}

/**
 * Concatenated text of every text block whose center falls inside a pixel box.
 * Shared by per-crop validation and the composite splitter.
 */
export function collectTextInPixelBox(
  pageLayout: PdfLayoutPage,
  box: { x: number; y: number; width: number; height: number },
  renderedWidth: number,
  renderedHeight: number
): string {
  if (pageLayout.width <= 0 || pageLayout.height <= 0) return "";
  const scaleX = renderedWidth / pageLayout.width;
  const scaleY = renderedHeight / pageLayout.height;
  const x1 = box.x;
  const y1 = box.y;
  const x2 = box.x + box.width;
  const y2 = box.y + box.height;
  const parts: string[] = [];
  for (const b of pageLayout.blocks) {
    if (b.type !== "text" || !b.text) continue;
    const r = blockRectPx(b, scaleX, scaleY);
    const cx = centerX(r);
    const cy = centerY(r);
    if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) parts.push(b.text);
  }
  return parts.join("\n");
}

export function detectGridProductBoxes(args: {
  pageLayout: PdfLayoutPage;
  pageText: string;
  pageType: CatalogPageType;
  renderedWidth: number;
  renderedHeight: number;
}): GridProductBox[] {
  const { pageLayout, pageType, renderedWidth: PW, renderedHeight: PH } = args;

  // Only product grids are this detector's job.
  if (pageType !== "category_grid" && pageType !== "partial_grid") return [];
  if (pageLayout.width <= 0 || pageLayout.height <= 0 || PW <= 0 || PH <= 0) {
    return [];
  }

  const scaleX = PW / pageLayout.width;
  const scaleY = PH / pageLayout.height;

  const headerY = HEADER_FRAC * PH;
  const footerY = (1 - FOOTER_FRAC) * PH;

  // Signal blocks: text blocks that carry a per-product marker.
  type Px = { rect: Rect; isSignal: boolean; isImage: boolean };
  const items: Px[] = [];
  const signalRects: Rect[] = [];
  for (const b of pageLayout.blocks) {
    const rect = blockRectPx(b, scaleX, scaleY);
    const cy = centerY(rect);
    if (cy < headerY || cy > footerY) continue; // drop header/footer furniture
    const isImage = b.type === "image";
    let isSignal = false;
    if (b.type === "text" && b.text) {
      isSignal = hasProductSignal(extractProductSignals({ text: b.text }));
      if (isSignal) signalRects.push(rect);
    }
    if (isImage || b.type === "text") items.push({ rect, isSignal, isImage });
  }

  if (signalRects.length < 2) return []; // not enough structure to infer a grid

  // Infer columns / rows from signal centers.
  const colCenters = cluster1d(
    signalRects.map(centerX),
    COL_GAP_FRAC * PW
  ).sort((a, b) => a - b);
  const rowCenters = cluster1d(
    signalRects.map(centerY),
    ROW_GAP_FRAC * PH
  ).sort((a, b) => a - b);

  // Vertical boundaries from column centers; horizontal from row centers. The
  // content envelope is bounded by images + signal blocks only (not stray
  // header/description text) so the outer cells don't swell into furniture.
  const envelope = items.filter((i) => i.isImage || i.isSignal);
  const contentLeft = Math.min(...envelope.map((i) => i.rect.x1));
  const contentRight = Math.max(...envelope.map((i) => i.rect.x2));
  const contentTop = Math.min(...envelope.map((i) => i.rect.y1));
  const contentBottom = Math.max(...envelope.map((i) => i.rect.y2));

  const colBounds = boundaries(
    colCenters,
    Math.max(0, contentLeft),
    Math.min(PW, contentRight)
  );
  const rowBounds = boundaries(
    rowCenters,
    Math.max(0, contentTop),
    Math.min(PH, contentBottom)
  );

  const minW = MIN_CELL_W_FRAC * PW;
  const minH = MIN_CELL_H_FRAC * PH;

  const boxes: GridProductBox[] = [];
  for (let r = 0; r < rowBounds.length - 1; r++) {
    for (let c = 0; c < colBounds.length - 1; c++) {
      const cell: Rect = {
        x1: colBounds[c],
        y1: rowBounds[r],
        x2: colBounds[c + 1],
        y2: rowBounds[r + 1],
      };

      // Members whose center sits in the cell.
      const members = items.filter((it) => {
        const cx = centerX(it.rect);
        const cy = centerY(it.rect);
        return cx >= cell.x1 && cx <= cell.x2 && cy >= cell.y1 && cy <= cell.y2;
      });
      const hasSignal = members.some((m) => m.isSignal);
      if (!hasSignal) continue; // empty cell → not a product

      // Tight box = union of the photo(s) + signal text in this cell, then
      // CLAMPED to the gridline cell so it can never span a neighbouring
      // column/row (the cause of merged multi-product crops).
      const relevant = members.filter((m) => m.isImage || m.isSignal);
      let box = relevant[0].rect;
      for (const m of relevant) box = union(box, m.rect);
      box = {
        x1: Math.max(box.x1, cell.x1),
        y1: Math.max(box.y1, cell.y1),
        x2: Math.min(box.x2, cell.x2),
        y2: Math.min(box.y2, cell.y2),
      };

      // Expand slightly, but stay within the cell.
      const ew = (box.x2 - box.x1) * EXPAND_FRAC;
      const eh = (box.y2 - box.y1) * EXPAND_FRAC;
      const x1 = Math.max(cell.x1, box.x1 - ew);
      const y1 = Math.max(cell.y1, box.y1 - eh);
      const x2 = Math.min(cell.x2, box.x2 + ew);
      const y2 = Math.min(cell.y2, box.y2 + eh);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w < minW || h < minH) continue;

      boxes.push({
        x: x1,
        y: y1,
        width: w,
        height: h,
        confidence: GRID_CONFIDENCE,
        source: "GRID_LAYOUT",
        reason: `grid ${rowCenters.length}x${colCenters.length} cell r${r + 1}c${c + 1}`,
      });
    }
  }

  return boxes;
}
