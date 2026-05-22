import sharp from "sharp";
import type { Box } from "./product-json-schema";

// ── Box refinement (vision-output post-processing) ──────────────────────────
//
// The multimodal model is good at *identifying* products but its bounding
// boxes are imprecise — they often include a slice of the card above, the
// price banner of the previous product, or cut off the description below.
//
// Treat the model's box as a *seed*. Expand a margin around it, snap the
// edges to natural whitespace gaps in the page, and validate that the
// resulting crop has clean boundaries (no contamination from neighboring
// cards).

const ANALYSIS_MAX_DIM = 800;
const WHITE_THRESHOLD = 240;

function isWhitePixel(r: number, g: number, b: number): boolean {
  return r > WHITE_THRESHOLD && g > WHITE_THRESHOLD && b > WHITE_THRESHOLD;
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

type RawAnalysis = {
  data: Buffer;
  channels: number;
  width: number;
  height: number;
  rowDensities: number[];
  colDensities: number[];
};

async function analyzeRegion(args: {
  pageImagePath: string;
  left: number;
  top: number;
  width: number;
  height: number;
}): Promise<RawAnalysis | null> {
  const scale = Math.min(1, ANALYSIS_MAX_DIM / Math.max(args.width, args.height));
  const anaW = Math.max(4, Math.round(args.width * scale));
  const anaH = Math.max(4, Math.round(args.height * scale));

  const { data, info } = await sharp(args.pageImagePath)
    .extract({
      left: args.left,
      top: args.top,
      width: args.width,
      height: args.height,
    })
    .resize(anaW, anaH, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const ch = info.channels;
  const rowDensities = new Array<number>(anaH).fill(0);
  const colDensities = new Array<number>(anaW).fill(0);

  for (let y = 0; y < anaH; y++) {
    let nw = 0;
    for (let x = 0; x < anaW; x++) {
      const off = (y * anaW + x) * ch;
      if (!isWhitePixel(data[off], data[off + 1], data[off + 2])) {
        nw++;
        colDensities[x] += 1;
      }
    }
    rowDensities[y] = nw / anaW;
  }
  for (let x = 0; x < anaW; x++) colDensities[x] /= anaH;

  return { data, channels: ch, width: anaW, height: anaH, rowDensities, colDensities };
}

// ── refineVisionBoxToCard ───────────────────────────────────────────────────
//
// Strategy:
//   1. Expand the model's box by `marginRatio` on every side (clamped to the
//      page). This gives us a search window that includes whatever the model
//      missed AND a bit of the neighboring cards.
//   2. Render that window at low resolution and compute per-row / per-col
//      "non-white density".
//   3. From the *center* of the original box, walk outward in each direction
//      until we hit a row/column that is mostly white (a gap). That's the
//      card's natural boundary.
//   4. Sanity-check: the refined box must overlap the original significantly
//      (50%–200% area) — otherwise the gap detection is probably noise.

export async function refineVisionBoxToCard(args: {
  pageImagePath: string;
  box: Box;
  pageWidth: number;
  pageHeight: number;
  marginRatio?: number;
}): Promise<{ box: Box; changed: boolean; reason?: string }> {
  const margin = args.marginRatio ?? 0.12;

  const dx = Math.round(args.box.width * margin);
  const dy = Math.round(args.box.height * margin);
  const exLeft = Math.max(0, Math.round(args.box.x) - dx);
  const exTop = Math.max(0, Math.round(args.box.y) - dy);
  const exRight = Math.min(
    args.pageWidth,
    Math.round(args.box.x + args.box.width) + dx
  );
  const exBottom = Math.min(
    args.pageHeight,
    Math.round(args.box.y + args.box.height) + dy
  );
  const exW = exRight - exLeft;
  const exH = exBottom - exTop;

  if (exW < 4 || exH < 4) {
    return { box: args.box, changed: false, reason: "expand_invalid" };
  }

  const analysis = await analyzeRegion({
    pageImagePath: args.pageImagePath,
    left: exLeft,
    top: exTop,
    width: exW,
    height: exH,
  });
  if (!analysis) return { box: args.box, changed: false, reason: "analyze_failed" };

  const { rowDensities, colDensities, width: anaW, height: anaH } = analysis;
  const scaleX = anaW / exW;
  const scaleY = anaH / exH;

  const centerPageX = args.box.x + args.box.width / 2;
  const centerPageY = args.box.y + args.box.height / 2;
  const centerAnaX = Math.round((centerPageX - exLeft) * scaleX);
  const centerAnaY = Math.round((centerPageY - exTop) * scaleY);

  if (
    centerAnaX < 0 ||
    centerAnaX >= anaW ||
    centerAnaY < 0 ||
    centerAnaY >= anaH
  ) {
    return { box: args.box, changed: false, reason: "center_outside" };
  }

  // Gap thresholds: a row/col below this density is treated as a card gap.
  const GAP = 0.04;

  // Walk outward from the center to the first gap row/col.
  let topAna = 0;
  for (let y = centerAnaY; y >= 0; y--) {
    if (rowDensities[y] < GAP) {
      topAna = y + 1;
      break;
    }
    topAna = y;
  }
  let botAna = anaH - 1;
  for (let y = centerAnaY; y < anaH; y++) {
    if (rowDensities[y] < GAP) {
      botAna = y - 1;
      break;
    }
    botAna = y;
  }
  let leftAna = 0;
  for (let x = centerAnaX; x >= 0; x--) {
    if (colDensities[x] < GAP) {
      leftAna = x + 1;
      break;
    }
    leftAna = x;
  }
  let rightAna = anaW - 1;
  for (let x = centerAnaX; x < anaW; x++) {
    if (colDensities[x] < GAP) {
      rightAna = x - 1;
      break;
    }
    rightAna = x;
  }

  if (botAna <= topAna || rightAna <= leftAna) {
    return { box: args.box, changed: false, reason: "empty_refined" };
  }

  let newX = Math.round(exLeft + leftAna / scaleX);
  let newY = Math.round(exTop + topAna / scaleY);
  let newW = Math.max(1, Math.round((rightAna - leftAna + 1) / scaleX));
  let newH = Math.max(1, Math.round((botAna - topAna + 1) / scaleY));

  // Conservative clamping: refinement shouldn't shove the top/bottom edge
  // more than 15% of the original height (same for left/right vs. width).
  // This protects against a misread gap that snaps the box to a completely
  // wrong card.
  const MAX_EDGE_SHIFT_RATIO = 0.15;
  const maxShiftY = Math.round(args.box.height * MAX_EDGE_SHIFT_RATIO);
  const maxShiftX = Math.round(args.box.width * MAX_EDGE_SHIFT_RATIO);

  const origTop = Math.round(args.box.y);
  const origBot = Math.round(args.box.y + args.box.height);
  const origLeft = Math.round(args.box.x);
  const origRight = Math.round(args.box.x + args.box.width);

  if (newY < origTop - maxShiftY) newY = origTop - maxShiftY;
  if (newY > origTop + maxShiftY) newY = origTop + maxShiftY;

  let newBot = newY + newH;
  if (newBot < origBot - maxShiftY) newBot = origBot - maxShiftY;
  if (newBot > origBot + maxShiftY) newBot = origBot + maxShiftY;
  newH = Math.max(1, newBot - newY);

  if (newX < origLeft - maxShiftX) newX = origLeft - maxShiftX;
  if (newX > origLeft + maxShiftX) newX = origLeft + maxShiftX;

  let newRight = newX + newW;
  if (newRight < origRight - maxShiftX) newRight = origRight - maxShiftX;
  if (newRight > origRight + maxShiftX) newRight = origRight + maxShiftX;
  newW = Math.max(1, newRight - newX);

  // Re-clamp to page bounds after the conservative shift.
  newX = Math.max(0, Math.min(args.pageWidth - 1, newX));
  newY = Math.max(0, Math.min(args.pageHeight - 1, newY));
  newW = Math.max(1, Math.min(args.pageWidth - newX, newW));
  newH = Math.max(1, Math.min(args.pageHeight - newY, newH));

  const refined: Box = { x: newX, y: newY, width: newW, height: newH };

  const origArea = args.box.width * args.box.height;
  const newArea = newW * newH;
  // Tightened area bounds: 70%–140% of original. Anything outside is a
  // sign the gap detector misread the layout.
  if (newArea < origArea * 0.7) {
    return { box: args.box, changed: false, reason: "refined_too_small" };
  }
  if (newArea > origArea * 1.4) {
    return { box: args.box, changed: false, reason: "refined_too_large" };
  }

  const overlap = iou(args.box, refined);
  if (overlap > 0.95) {
    return { box: args.box, changed: false };
  }

  return { box: refined, changed: true, reason: "snap_to_card_boundary" };
}

// ── evaluateBoxBoundary ─────────────────────────────────────────────────────
//
// Inspects a crop file directly to decide whether the crop sits cleanly on
// card boundaries, or whether it's contaminated by neighboring content.
// Returns a boundaryScore in [0, 1]. A score < 0.6 should disqualify the
// candidate from being indexed.
//
// Signals:
//   - edge density: a clean card has mostly-white borders. Heavy content on
//     the top/bottom/side edges means we either cropped into a neighbor or
//     truncated the actual card.
//   - mid-cut: a near-empty row in the inner 25%–75% with dense content
//     above AND below means two cards were stacked into one crop.

export async function evaluateBoxBoundary(args: {
  cropImagePath: string;
}): Promise<{ boundaryScore: number; rejectReason?: string }> {
  const meta = await sharp(args.cropImagePath).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (origW < 8 || origH < 8) {
    return { boundaryScore: 0, rejectReason: "invalid_box" };
  }

  const scale = Math.min(1, ANALYSIS_MAX_DIM / Math.max(origW, origH));
  const anaW = Math.max(8, Math.round(origW * scale));
  const anaH = Math.max(8, Math.round(origH * scale));

  const { data, info } = await sharp(args.cropImagePath)
    .resize(anaW, anaH, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  const rowDensities = new Array<number>(anaH).fill(0);
  const colDensities = new Array<number>(anaW).fill(0);
  for (let y = 0; y < anaH; y++) {
    let nw = 0;
    for (let x = 0; x < anaW; x++) {
      const off = (y * anaW + x) * ch;
      if (!isWhitePixel(data[off], data[off + 1], data[off + 2])) {
        nw++;
        colDensities[x] += 1;
      }
    }
    rowDensities[y] = nw / anaW;
  }
  for (let x = 0; x < anaW; x++) colDensities[x] /= anaH;

  const edgeBandH = Math.max(2, Math.round(anaH * 0.04));
  const edgeBandW = Math.max(2, Math.round(anaW * 0.04));

  const avg = (arr: number[], from: number, to: number): number => {
    let s = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      s += arr[i];
      n++;
    }
    return n > 0 ? s / n : 0;
  };

  const topAvg = avg(rowDensities, 0, edgeBandH);
  const botAvg = avg(rowDensities, anaH - edgeBandH, anaH);
  const leftAvg = avg(colDensities, 0, edgeBandW);
  const rightAvg = avg(colDensities, anaW - edgeBandW, anaW);

  // Mid-cut detection: a near-empty row band in the inner 25%–75% with
  // dense content both above and below indicates two cards stacked.
  const innerStart = Math.round(anaH * 0.25);
  const innerEnd = Math.round(anaH * 0.75);
  let midGapMin = 1;
  for (let y = innerStart; y < innerEnd; y++) {
    if (rowDensities[y] < midGapMin) midGapMin = rowDensities[y];
  }
  let denseAbove = false;
  let denseBelow = false;
  for (let y = 0; y < innerStart; y++) {
    if (rowDensities[y] > 0.15) {
      denseAbove = true;
      break;
    }
  }
  for (let y = innerEnd; y < anaH; y++) {
    if (rowDensities[y] > 0.15) {
      denseBelow = true;
      break;
    }
  }
  const twoCardsStacked = midGapMin < 0.02 && denseAbove && denseBelow;

  // Each edge that exceeds 0.05 starts paying a penalty.
  const edgePenalty = (val: number) => Math.max(0, val - 0.05) * 1.2;
  const edgeScore =
    1.0 -
    Math.min(
      1.0,
      edgePenalty(topAvg) +
        edgePenalty(botAvg) +
        edgePenalty(leftAvg) +
        edgePenalty(rightAvg)
    );
  const stackPenalty = twoCardsStacked ? 0.5 : 0;
  const boundaryScore = Math.max(0, Math.min(1, edgeScore - stackPenalty));

  if (twoCardsStacked) return { boundaryScore, rejectReason: "bad_card_boundary" };
  if (topAvg > 0.28 || botAvg > 0.28) {
    return { boundaryScore, rejectReason: "bad_card_boundary" };
  }

  return { boundaryScore };
}

// ── Post-refinement IoU dedup ───────────────────────────────────────────────
//
// After refinement, two distinct model boxes can snap to the same card.
// Re-dedup by IoU, keeping the candidate with the best composite score
// (visionConfidence × boundaryScore × qualityScore).

export type RefinedCandidate<T> = T & {
  box: Box;
  visionConfidence: number;
  boundaryScore: number;
  qualityScore: number;
};

export function dedupeRefinedByIoU<T>(
  candidates: RefinedCandidate<T>[],
  threshold = 0.55
): RefinedCandidate<T>[] {
  const score = (c: RefinedCandidate<T>) =>
    c.visionConfidence * 0.4 + c.boundaryScore * 0.3 + c.qualityScore * 0.3;

  const sorted = [...candidates].sort((a, b) => score(b) - score(a));
  const kept: RefinedCandidate<T>[] = [];
  for (const c of sorted) {
    let dup = false;
    for (const prev of kept) {
      if (iou(c.box, prev.box) >= threshold) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept;
}
