import type { PdfLayoutPage } from "./pdf-layout-extractor";
import { extractProductSignals, hasProductSignal } from "./product-signals";

// ── Composite card splitter ──────────────────────────────────────────────────
//
// When a single box ends up covering several products (the failure mode that
// poisons embeddings), split it back into one box per product using the
// positions of the per-product signals (code / price / PCS-CX) inside the box.
//
// Clustering the signal centers into rows and columns reproduces any of the
// listed split shapes generically — 2×1, 1×2, 2×2, 3×1, 1×3, 3×2, 3×3 — without
// hard-coding them. The caller crops each sub-box and keeps only those that
// pass single-product validation.

export type SubBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  reason: string;
};

type Rect = { x1: number; y1: number; x2: number; y2: number };

function cluster1d(values: number[], minGap: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > minGap) clusters.push([sorted[i]]);
    else clusters[clusters.length - 1].push(sorted[i]);
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

function boundaries(centers: number[], lo: number, hi: number): number[] {
  const sorted = [...centers].sort((a, b) => a - b);
  const out = [lo];
  for (let i = 0; i < sorted.length - 1; i++) {
    out.push((sorted[i] + sorted[i + 1]) / 2);
  }
  out.push(hi);
  return out;
}

export async function splitCompositeProductBox(args: {
  pageImagePath: string;
  pageLayout?: PdfLayoutPage;
  pageText?: string;
  box: { x: number; y: number; width: number; height: number };
  pageWidth: number;
  pageHeight: number;
}): Promise<SubBox[]> {
  const { pageLayout, box, pageWidth, pageHeight } = args;
  if (!pageLayout || pageLayout.width <= 0 || pageLayout.height <= 0) return [];

  const scaleX = pageWidth / pageLayout.width;
  const scaleY = pageHeight / pageLayout.height;

  const bx1 = box.x;
  const by1 = box.y;
  const bx2 = box.x + box.width;
  const by2 = box.y + box.height;

  // Signal centers inside the box.
  const signalCenters: Array<{ cx: number; cy: number }> = [];
  for (const b of pageLayout.blocks) {
    if (b.type !== "text" || !b.text) continue;
    const cx = (b.x + b.width / 2) * scaleX;
    const cy = (b.y + b.height / 2) * scaleY;
    if (cx < bx1 || cx > bx2 || cy < by1 || cy > by2) continue;
    if (hasProductSignal(extractProductSignals({ text: b.text }))) {
      signalCenters.push({ cx, cy });
    }
  }

  if (signalCenters.length < 2) return []; // nothing to split on

  // Cluster into columns / rows, using gaps relative to the box size.
  const colCenters = cluster1d(
    signalCenters.map((s) => s.cx),
    box.width * 0.18
  );
  const rowCenters = cluster1d(
    signalCenters.map((s) => s.cy),
    box.height * 0.18
  );
  if (colCenters.length <= 1 && rowCenters.length <= 1) return [];

  const colBounds = boundaries(colCenters, bx1, bx2);
  const rowBounds = boundaries(rowCenters, by1, by2);

  const subBoxes: SubBox[] = [];
  for (let r = 0; r < rowBounds.length - 1; r++) {
    for (let c = 0; c < colBounds.length - 1; c++) {
      const cell: Rect = {
        x1: colBounds[c],
        y1: rowBounds[r],
        x2: colBounds[c + 1],
        y2: rowBounds[r + 1],
      };
      // Keep the sub-cell only if a signal actually sits in it.
      const hasSignal = signalCenters.some(
        (s) =>
          s.cx >= cell.x1 &&
          s.cx <= cell.x2 &&
          s.cy >= cell.y1 &&
          s.cy <= cell.y2
      );
      if (!hasSignal) continue;

      const w = cell.x2 - cell.x1;
      const h = cell.y2 - cell.y1;
      if (w < 8 || h < 8) continue;
      subBoxes.push({
        x: cell.x1,
        y: cell.y1,
        width: w,
        height: h,
        confidence: 0.8,
        reason: `split ${rowCenters.length}x${colCenters.length} r${r + 1}c${c + 1}`,
      });
    }
  }

  // Only a real split (≥2 sub-cells) is useful.
  return subBoxes.length >= 2 ? subBoxes : [];
}
