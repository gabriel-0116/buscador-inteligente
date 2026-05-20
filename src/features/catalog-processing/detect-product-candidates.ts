import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type DetectedCandidate = {
  imagePath: string;
  cardImagePath?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  qualityScore: number;
  isSearchable: boolean;
  rejectReason?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const ANALYSIS_WIDTH = 800;
// Minimum card side in ORIGINAL pixels — checked in original coords, not analysis,
// to avoid rejecting legitimate cards as "too_small" when the page is downscaled.
const MIN_CARD_PX_ORIG = 220;
const MIN_AREA_RATIO = 0.015;
// MVP: catalog pages can carry up to ~9-12 product cards. Caps must allow that.
const MAX_SEARCHABLE_PER_PAGE = 12;
const MAX_TOTAL_PER_PAGE = 18;
const QUALITY_THRESHOLD = 0.6;
// A row/col is treated as whitespace when this fraction or less of its pixels are non-white.
const GAP_DENSITY = 0.04;
const MIN_GAP_SPAN = 8;

type Box = { x1: number; y1: number; x2: number; y2: number };

// Reject reasons that fully disqualify a crop from search, regardless of score.
const SEVERE_REJECTS = new Set([
  "too_small",
  "mostly_white",
  "green_bar",
  "orange_bar",
  "color_bar",
  "header_footer",
  "empty_cell",
  "too_horizontal",
  "too_vertical",
  "insufficient_content",
  "card_too_large",
  "page_like_crop",
]);

// ── Low-level pixel helpers ──────────────────────────────────────────────────

function isWhite(r: number, g: number, b: number) {
  return r > 240 && g > 240 && b > 240;
}

function isGreen(r: number, g: number, b: number) {
  return g > 100 && g > r + 40 && g > b + 40;
}

function isOrange(r: number, g: number, b: number) {
  // Orange / red-orange: R high, G moderate-low, B low, R clearly above B.
  return r > 180 && g > 60 && g < r - 20 && b < 100 && r > b + 60;
}

interface PixelStats {
  total: number;
  white: number;
  green: number;
  orange: number;
  nonWhite: number;
  whiteRatio: number;
  greenRatio: number;
  orangeRatio: number;
  nonWhiteRatio: number;
}

function pixelStats(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): PixelStats {
  let white = 0;
  let green = 0;
  let orange = 0;
  let total = 0;
  for (let y = box.y1; y <= box.y2; y++) {
    for (let x = box.x1; x <= box.x2; x++) {
      const off = (y * width + x) * channels;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      total++;
      if (isWhite(r, g, b)) {
        white++;
      } else if (isGreen(r, g, b)) {
        green++;
      } else if (isOrange(r, g, b)) {
        orange++;
      }
    }
  }
  const nonWhite = total - white;
  return {
    total,
    white,
    green,
    orange,
    nonWhite,
    whiteRatio: total > 0 ? white / total : 1,
    greenRatio: total > 0 ? green / total : 0,
    orangeRatio: total > 0 ? orange / total : 0,
    nonWhiteRatio: total > 0 ? nonWhite / total : 0,
  };
}

function rowDensities(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): number[] {
  const colCount = box.x2 - box.x1 + 1;
  const result: number[] = [];
  for (let y = box.y1; y <= box.y2; y++) {
    let nonWhite = 0;
    for (let x = box.x1; x <= box.x2; x++) {
      const off = (y * width + x) * channels;
      if (!isWhite(data[off], data[off + 1], data[off + 2])) nonWhite++;
    }
    result.push(nonWhite / colCount);
  }
  return result;
}

function colDensities(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): number[] {
  const rowCount = box.y2 - box.y1 + 1;
  const result: number[] = [];
  for (let x = box.x1; x <= box.x2; x++) {
    let nonWhite = 0;
    for (let y = box.y1; y <= box.y2; y++) {
      const off = (y * width + x) * channels;
      if (!isWhite(data[off], data[off + 1], data[off + 2])) nonWhite++;
    }
    result.push(nonWhite / rowCount);
  }
  return result;
}

// How much content (non-white fraction) is in the central 50% of the box
function centralMassRatio(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): number {
  const bW = box.x2 - box.x1 + 1;
  const bH = box.y2 - box.y1 + 1;
  const cX = Math.round((box.x1 + box.x2) / 2);
  const cY = Math.round((box.y1 + box.y2) / 2);
  const hw = Math.round(bW * 0.25);
  const hh = Math.round(bH * 0.25);
  const centerBox: Box = {
    x1: Math.max(box.x1, cX - hw),
    y1: Math.max(box.y1, cY - hh),
    x2: Math.min(box.x2, cX + hw),
    y2: Math.min(box.y2, cY + hh),
  };
  const full = pixelStats(data, channels, width, box);
  const center = pixelStats(data, channels, width, centerBox);
  if (full.nonWhite === 0) return 0;
  return center.nonWhite / full.nonWhite;
}

// Dark-to-light transitions per pixel per row → high = text-heavy region.
function estimateTextLikeDensity(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): number {
  const boxWidth = box.x2 - box.x1 + 1;
  let totalTransitions = 0;
  let rowCount = 0;
  for (let y = box.y1; y <= box.y2; y++) {
    let transitions = 0;
    let prevDark = false;
    for (let x = box.x1; x <= box.x2; x++) {
      const off = (y * width + x) * channels;
      const brightness = (data[off] + data[off + 1] + data[off + 2]) / 3;
      const isDark = brightness < 140;
      if (isDark !== prevDark) transitions++;
      prevDark = isDark;
    }
    totalTransitions += transitions;
    rowCount++;
  }
  return rowCount > 0 ? totalTransitions / (rowCount * boxWidth) : 0;
}

// ── Quality predicates ──────────────────────────────────────────────────────

function isMostlyWhiteCrop(whiteRatio: number): boolean {
  return whiteRatio > 0.9;
}

// A "color bar" = wide-and-short shape dominated by a single brand color.
// Crucially: a full card that merely contains a colored price strip is NOT a bar,
// because its aspect ratio is closer to square.
function isColorBarDominant(
  greenRatio: number,
  orangeRatio: number,
  aspectRatio: number
): { isBar: boolean; reason?: "green_bar" | "orange_bar" } {
  if (aspectRatio < 2.0) return { isBar: false };
  if (greenRatio > 0.3) return { isBar: true, reason: "green_bar" };
  if (orangeRatio > 0.3) return { isBar: true, reason: "orange_bar" };
  return { isBar: false };
}

function isTooHorizontal(aspectRatio: number, heightOrig: number): boolean {
  if (aspectRatio > 3.2) return true;
  // Moderately horizontal AND short = also suspect (likely a strip)
  if (aspectRatio > 2.5 && heightOrig < MIN_CARD_PX_ORIG * 1.2) return true;
  return false;
}

function isTooVertical(aspectRatio: number): boolean {
  return aspectRatio < 0.3;
}

function hasEnoughVisualMass(nonWhiteRatio: number): boolean {
  return nonWhiteRatio >= 0.05;
}

// ── Card quality scoring ────────────────────────────────────────────────────

function calculateCardQuality(args: {
  data: Buffer;
  channels: number;
  width: number;
  box: Box;
  pageArea: number;
  pageHeight: number;
  scale: number;
}): { score: number; rejectReason?: string } {
  const { data, channels, width, box, pageArea, pageHeight, scale } = args;

  const bW = box.x2 - box.x1 + 1;
  const bH = box.y2 - box.y1 + 1;
  const aspectRatio = bW / bH;
  const bArea = bW * bH;

  // Size check is done in ORIGINAL coords — analysis is downscaled, so
  // a 240×240 card might be ~96×96 in analysis space and would fail otherwise.
  const wOrig = bW / scale;
  const hOrig = bH / scale;

  if (wOrig < MIN_CARD_PX_ORIG || hOrig < MIN_CARD_PX_ORIG) {
    return { score: 0, rejectReason: "too_small" };
  }
  if (isTooHorizontal(aspectRatio, hOrig)) {
    return { score: 0, rejectReason: "too_horizontal" };
  }
  if (isTooVertical(aspectRatio)) {
    return { score: 0, rejectReason: "too_vertical" };
  }

  const stats = pixelStats(data, channels, width, box);

  if (isMostlyWhiteCrop(stats.whiteRatio)) {
    return { score: 0, rejectReason: "mostly_white" };
  }

  const barCheck = isColorBarDominant(stats.greenRatio, stats.orangeRatio, aspectRatio);
  if (barCheck.isBar) {
    return { score: 0, rejectReason: barCheck.reason };
  }

  if (!hasEnoughVisualMass(stats.nonWhiteRatio)) {
    return { score: 0, rejectReason: "insufficient_content" };
  }

  // Header/footer: an entire box sitting in the top 10% or bottom 8% of the page
  // is almost always metadata (logo, supplier name, page number).
  const topFrac = box.y1 / pageHeight;
  const botFrac = box.y2 / pageHeight;
  if (botFrac < 0.1 || topFrac > 0.92) {
    return { score: 0, rejectReason: "header_footer" };
  }

  const areaRatio = bArea / pageArea;
  if (areaRatio > 0.75) {
    // Full-page / near-full crop: keep for debug, not searchable.
    return { score: 0.25, rejectReason: "page_like_crop" };
  }

  // Score components — a "good card" should score 0.70-0.95.
  const central = centralMassRatio(data, channels, width, box);

  const aspectScore =
    aspectRatio >= 0.6 && aspectRatio <= 1.6
      ? 1.0
      : Math.max(0, 1.0 - Math.abs(Math.log(aspectRatio)) * 0.5);

  const massScore = Math.min(1.0, stats.nonWhiteRatio * 5);
  const centralScore = Math.min(1.0, central * 2.5);

  // Area: cards are typically 5-40% of the page.
  const areaScore =
    areaRatio < 0.02
      ? areaRatio * 30
      : areaRatio > 0.55
        ? Math.max(0.3, 1.0 - (areaRatio - 0.55) * 2)
        : 1.0;

  // Cards naturally contain text + price — only penalize *extreme* text density
  // (a pure text/table block typically exceeds 0.10 transitions/px/row).
  const textDensity = estimateTextLikeDensity(data, channels, width, box);
  const textPenalty = Math.max(0, textDensity - 0.09) * 5;

  // Soft penalty if a brand color leaks past 18% but didn't trigger the bar reject
  // (so we still rank cleaner cards above ones with massive color strips).
  const colorLeakPenalty =
    Math.max(0, stats.greenRatio - 0.18) * 1.5 +
    Math.max(0, stats.orangeRatio - 0.18) * 1.5;

  const score = Math.max(
    0,
    Math.min(
      0.95,
      massScore * 0.3 +
        centralScore * 0.2 +
        aspectScore * 0.2 +
        areaScore * 0.2 +
        0.1 -
        textPenalty * 0.15 -
        colorLeakPenalty * 0.15
    )
  );

  if (score < QUALITY_THRESHOLD) {
    if (textDensity > 0.1) return { score, rejectReason: "text_like" };
    if (central < 0.06) return { score, rejectReason: "no_central_object" };
    return { score, rejectReason: "low_quality" };
  }

  return { score };
}

function shouldIndexCrop(score: number, rejectReason?: string): boolean {
  if (rejectReason && SEVERE_REJECTS.has(rejectReason)) return false;
  return score >= QUALITY_THRESHOLD;
}

// ── Gap detection and region splitting ──────────────────────────────────────

function findGaps(densities: number[], threshold: number, minSpan: number): number[][] {
  const gaps: number[][] = [];
  let gapStart = -1;
  for (let i = 0; i < densities.length; i++) {
    if (densities[i] < threshold) {
      if (gapStart < 0) gapStart = i;
    } else {
      if (gapStart >= 0 && i - gapStart >= minSpan) gaps.push([gapStart, i - 1]);
      gapStart = -1;
    }
  }
  if (gapStart >= 0 && densities.length - gapStart >= minSpan) {
    gaps.push([gapStart, densities.length - 1]);
  }
  return gaps;
}

function gapsToRegions(box: Box, gaps: number[][], axis: "row" | "col"): Box[] {
  const segments: number[][] = [];
  let start = axis === "row" ? box.y1 : box.x1;
  for (const [gs, ge] of gaps) {
    const absStart = (axis === "row" ? box.y1 : box.x1) + gs;
    const absEnd = (axis === "row" ? box.y1 : box.x1) + ge;
    if (absStart > start) segments.push([start, absStart - 1]);
    start = absEnd + 1;
  }
  const end = axis === "row" ? box.y2 : box.x2;
  if (start <= end) segments.push([start, end]);
  return segments.map((seg) =>
    axis === "row"
      ? { x1: box.x1, y1: seg[0], x2: box.x2, y2: seg[1] }
      : { x1: seg[0], y1: box.y1, x2: seg[1], y2: box.y2 }
  );
}

function getBoundingBox(
  data: Buffer,
  channels: number,
  width: number,
  height: number
): Box | null {
  let x1 = width;
  let y1 = height;
  let x2 = 0;
  let y2 = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * channels;
      if (!isWhite(data[off], data[off + 1], data[off + 2])) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
        found = true;
      }
    }
  }
  return found ? { x1, y1, x2, y2 } : null;
}

// ── Card grid detection ─────────────────────────────────────────────────────
//
// Splits a page into a grid of candidate card cells using whitespace gaps.
// Catalogs typically lay products out as 1-4 columns × 1-4 rows; row-then-column
// gap splitting recovers this structure without forcing a fixed grid.

function detectCardGridFromPage(args: {
  data: Buffer;
  channels: number;
  width: number;
  globalBox: Box;
}): Box[] {
  const { data, channels, width, globalBox } = args;

  const rDens = rowDensities(data, channels, width, globalBox);
  const rowGaps = findGaps(rDens, GAP_DENSITY, MIN_GAP_SPAN);
  const rowRegions =
    rowGaps.length > 0 ? gapsToRegions(globalBox, rowGaps, "row") : [globalBox];

  const cells: Box[] = [];
  for (const rowRegion of rowRegions) {
    const cDens = colDensities(data, channels, width, rowRegion);
    const colGaps = findGaps(cDens, GAP_DENSITY, MIN_GAP_SPAN);
    const cols =
      colGaps.length > 0 ? gapsToRegions(rowRegion, colGaps, "col") : [rowRegion];
    cells.push(...cols);
  }
  return cells;
}

// ── Main export ─────────────────────────────────────────────────────────────

export async function detectProductCandidatesFromPage(args: {
  pageImagePath: string;
  outputDir: string;
  pageNumber: number;
}): Promise<DetectedCandidate[]> {
  const { pageImagePath, outputDir, pageNumber } = args;
  await mkdir(outputDir, { recursive: true });

  const rawMeta = await sharp(pageImagePath).metadata();
  const origWidth = rawMeta.width ?? 800;
  const origHeight = rawMeta.height ?? 1000;

  const scale = Math.min(1, ANALYSIS_WIDTH / origWidth);
  const anaWidth = Math.round(origWidth * scale);
  const anaHeight = Math.round(origHeight * scale);
  // Equivalent minimum in analysis space; floored to avoid 0 for tiny pages.
  const minCardPxAna = Math.max(40, Math.round(MIN_CARD_PX_ORIG * scale));

  const { data, info } = await sharp(pageImagePath)
    .resize(anaWidth, anaHeight, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { channels } = info;
  const pageArea = anaWidth * anaHeight;

  const globalBox = getBoundingBox(data, channels, anaWidth, anaHeight);
  if (!globalBox) return [];

  const cells = detectCardGridFromPage({
    data,
    channels,
    width: anaWidth,
    globalBox,
  });

  // Drop cells smaller than the minimum card size at analysis resolution.
  const candidateBoxes = cells.filter((b) => {
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    return (
      w >= minCardPxAna &&
      h >= minCardPxAna &&
      (w * h) / pageArea >= MIN_AREA_RATIO
    );
  });

  // Fallback: if grid splitting found nothing usable, evaluate the whole content box.
  if (candidateBoxes.length === 0) {
    const w = globalBox.x2 - globalBox.x1 + 1;
    const h = globalBox.y2 - globalBox.y1 + 1;
    if (w >= minCardPxAna && h >= minCardPxAna) {
      candidateBoxes.push(globalBox);
    }
  }

  type Scored = {
    box: Box;
    quality: { score: number; rejectReason?: string };
    confidence: number;
  };

  const scored: Scored[] = candidateBoxes.map((box) => ({
    box,
    quality: calculateCardQuality({
      data,
      channels,
      width: anaWidth,
      box,
      pageArea,
      pageHeight: anaHeight,
      scale,
    }),
    confidence: 0.75,
  }));

  // Searchable first, then by score desc.
  scored.sort((a, b) => {
    const aS = shouldIndexCrop(a.quality.score, a.quality.rejectReason) ? 1 : 0;
    const bS = shouldIndexCrop(b.quality.score, b.quality.rejectReason) ? 1 : 0;
    if (aS !== bS) return bS - aS;
    return b.quality.score - a.quality.score;
  });

  let searchableCount = 0;
  const finalCells: Scored[] = [];
  for (const r of scored) {
    if (finalCells.length >= MAX_TOTAL_PER_PAGE) break;
    const isS = shouldIndexCrop(r.quality.score, r.quality.rejectReason);
    if (isS && searchableCount >= MAX_SEARCHABLE_PER_PAGE) continue;
    if (isS) searchableCount++;
    finalCells.push(r);
  }

  const results: DetectedCandidate[] = [];
  let cropIndex = 1;

  for (const { box, quality, confidence } of finalCells) {
    const toOrig = (v: number) => Math.round(v / scale);
    const clampX = (v: number) => Math.max(0, Math.min(origWidth - 1, v));
    const clampY = (v: number) => Math.max(0, Math.min(origHeight - 1, v));

    const sx = clampX(toOrig(box.x1));
    const sy = clampY(toOrig(box.y1));
    const sw = Math.max(1, Math.min(origWidth - sx, toOrig(box.x2 - box.x1 + 1)));
    const sh = Math.max(1, Math.min(origHeight - sy, toOrig(box.y2 - box.y1 + 1)));

    // Final safety check at original resolution.
    if (sw < MIN_CARD_PX_ORIG || sh < MIN_CARD_PX_ORIG) continue;

    const prefix = `page-${String(pageNumber).padStart(3, "0")}-crop-${String(cropIndex).padStart(2, "0")}`;
    const imagePath = join(outputDir, `${prefix}.jpg`);

    await sharp(pageImagePath)
      .extract({ left: sx, top: sy, width: sw, height: sh })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toFile(imagePath);

    const isSearchable = shouldIndexCrop(quality.score, quality.rejectReason);

    results.push({
      imagePath,
      // MVP: 1 card = 1 candidate. The crop is the card itself; process-catalog
      // copies cropUrl into cardUrl when no separate card image is provided.
      x: sx,
      y: sy,
      width: sw,
      height: sh,
      confidence,
      qualityScore: quality.score,
      isSearchable,
      rejectReason: quality.rejectReason,
    });

    cropIndex++;
  }

  return results;
}
