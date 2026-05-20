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

const MIN_CROP_PX = 180;
const MIN_AREA_RATIO = 0.03;
const MAX_SEARCHABLE_PER_PAGE = 3;
const MAX_TOTAL_PER_PAGE = 6;
const QUALITY_THRESHOLD = 0.50;
// Separator gap: row/col is a whitespace gap if < this fraction is non-white
const GAP_DENSITY = 0.04;
const MIN_GAP_SPAN = 8;

type Box = { x1: number; y1: number; x2: number; y2: number };

// ── Low-level pixel helpers ──────────────────────────────────────────────────

function isWhite(r: number, g: number, b: number) {
  return r > 240 && g > 240 && b > 240;
}

function isGreen(r: number, g: number, b: number) {
  return g > 100 && g > r + 40 && g > b + 40;
}

interface PixelStats {
  total: number;
  white: number;
  green: number;
  nonWhite: number;
  whiteRatio: number;
  greenRatio: number;
  nonWhiteRatio: number;
}

function pixelStats(
  data: Buffer,
  channels: number,
  width: number,
  box: Box
): PixelStats {
  let white = 0, green = 0, total = 0;
  for (let y = box.y1; y <= box.y2; y++) {
    for (let x = box.x1; x <= box.x2; x++) {
      const off = (y * width + x) * channels;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      total++;
      if (isWhite(r, g, b)) white++;
      if (isGreen(r, g, b)) green++;
    }
  }
  const nonWhite = total - white;
  return {
    total,
    white,
    green,
    nonWhite,
    whiteRatio: total > 0 ? white / total : 1,
    greenRatio: total > 0 ? green / total : 0,
    nonWhiteRatio: total > 0 ? nonWhite / total : 0,
  };
}

// Fraction of non-white pixels per row within box
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

// Fraction of non-white pixels per column within box
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

// Ratio of dark-to-light transitions per pixel per row → high = text-like
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

// ── Quality filter predicates ────────────────────────────────────────────────

function isMostlyWhiteCrop(whiteRatio: number): boolean {
  return whiteRatio > 0.88;
}

function isGreenBarDominant(greenRatio: number, aspectRatio: number): boolean {
  // Horizontal strip with lots of green = catalog price bar
  return greenRatio > 0.22 && aspectRatio > 1.8;
}

function isTooHorizontal(aspectRatio: number): boolean {
  return aspectRatio > 3.5;
}

function isTooVertical(aspectRatio: number): boolean {
  return aspectRatio < 0.20;
}

function hasEnoughVisualMass(nonWhiteRatio: number): boolean {
  return nonWhiteRatio >= 0.06;
}

function hasCentralObjectMass(ratio: number): boolean {
  return ratio >= 0.08;
}

// ── Main quality evaluator ───────────────────────────────────────────────────

function calculateCropQuality(
  data: Buffer,
  channels: number,
  width: number,
  box: Box,
  pageArea: number
): { score: number; rejectReason?: string } {
  const bW = box.x2 - box.x1 + 1;
  const bH = box.y2 - box.y1 + 1;
  const aspectRatio = bW / bH;
  const bArea = bW * bH;

  if (bW < MIN_CROP_PX || bH < MIN_CROP_PX) {
    return { score: 0, rejectReason: "too_small" };
  }
  if (isTooHorizontal(aspectRatio)) {
    return { score: 0, rejectReason: "too_horizontal" };
  }
  if (isTooVertical(aspectRatio)) {
    return { score: 0, rejectReason: "too_vertical" };
  }

  const stats = pixelStats(data, channels, width, box);

  if (isMostlyWhiteCrop(stats.whiteRatio)) {
    return { score: 0, rejectReason: "mostly_white" };
  }
  if (isGreenBarDominant(stats.greenRatio, aspectRatio)) {
    return { score: 0, rejectReason: "green_bar" };
  }
  if (!hasEnoughVisualMass(stats.nonWhiteRatio)) {
    return { score: 0, rejectReason: "insufficient_content" };
  }

  const areaRatio = bArea / pageArea;
  if (areaRatio > 0.75) {
    // Full card/page saved only for debug
    return { score: 0.25, rejectReason: "card_too_large" };
  }

  const textDensity = estimateTextLikeDensity(data, channels, width, box);
  const central = centralMassRatio(data, channels, width, box);

  // Penalize extreme aspect ratios gracefully
  const aspectPenalty = Math.max(0, (aspectRatio - 2.0) * 0.15) + Math.max(0, (1.0 / aspectRatio - 2.0) * 0.15);

  // Text penalty: typical text = 0.05-0.12 transitions/px/row
  const textPenalty = Math.min(0.50, Math.max(0, textDensity - 0.03) * 8);

  // Green penalty (softer reject for partial green)
  const greenPenalty = Math.min(0.35, stats.greenRatio * 2);

  // Visual mass score — reward content-rich crops
  const massScore = Math.min(1.0, stats.nonWhiteRatio * 4.5);

  // Central mass score
  const centralScore = Math.min(1.0, central * 3.0);

  // Area score: prefer 5-60% of page
  const areaScore = areaRatio < 0.05
    ? areaRatio * 15
    : areaRatio > 0.60
    ? Math.max(0, 1.0 - (areaRatio - 0.60) * 2)
    : 1.0;

  const score = Math.max(0, Math.min(0.95,
    massScore * 0.30 +
    centralScore * 0.25 +
    areaScore * 0.20 +
    (1 - textPenalty) * 0.15 +
    (1 - aspectPenalty) * 0.10 -
    greenPenalty
  ));

  let rejectReason: string | undefined;
  if (score < QUALITY_THRESHOLD) {
    if (textDensity > 0.07) rejectReason = "text_like";
    else if (stats.greenRatio > 0.18) rejectReason = "green_dominant";
    else if (!hasCentralObjectMass(central)) rejectReason = "no_central_object";
    else if (areaRatio > 0.60) rejectReason = "card_too_large";
    else rejectReason = "low_quality";
  }

  return { score, rejectReason };
}

function shouldIndexCrop(score: number, rejectReason?: string): boolean {
  return score >= QUALITY_THRESHOLD && !rejectReason;
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
  let x1 = width, y1 = height, x2 = 0, y2 = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * channels;
      if (!isWhite(data[off], data[off + 1], data[off + 2])) {
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
        found = true;
      }
    }
  }
  return found ? { x1, y1, x2, y2 } : null;
}

// ── Search crop extraction from a large card ─────────────────────────────────
//
// Strips green rows and header/footer zones to find the "product zone" inside a card.
// Returns a tighter box if possible, otherwise returns null (caller uses the card).

function extractSearchCropFromCard(
  data: Buffer,
  channels: number,
  width: number,
  cardBox: Box
): Box | null {
  const cardH = cardBox.y2 - cardBox.y1 + 1;
  if (cardH < MIN_CROP_PX * 2) return null;

  const rDens = rowDensities(data, channels, width, cardBox);

  // Classify each row: 'g'=green, 'w'=white/empty, 'c'=content
  const rowType: Array<"g" | "w" | "c"> = rDens.map((density, i) => {
    if (density < 0.03) return "w";
    const absY = cardBox.y1 + i;
    let greenCount = 0;
    for (let x = cardBox.x1; x <= cardBox.x2; x++) {
      const off = (absY * width + x) * channels;
      if (isGreen(data[off], data[off + 1], data[off + 2])) greenCount++;
    }
    const greenRatio = greenCount / (cardBox.x2 - cardBox.x1 + 1);
    if (greenRatio > 0.20) return "g";
    return "c";
  });

  // Find the largest contiguous span of 'c' rows (content, not green, not empty)
  let bestStart = -1, bestEnd = -1, bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= rowType.length; i++) {
    const type = rowType[i];
    if (type === "c") {
      if (curStart < 0) curStart = i;
    } else {
      if (curStart >= 0) {
        const len = i - curStart;
        if (len > bestLen) {
          bestLen = len;
          bestStart = curStart;
          bestEnd = i - 1;
        }
        curStart = -1;
      }
    }
  }

  if (bestStart < 0 || bestLen < MIN_CROP_PX) return null;

  // Only return the sub-crop if it's meaningfully smaller than the card
  const subFraction = bestLen / cardH;
  if (subFraction > 0.85) return null; // not worth cropping

  return {
    x1: cardBox.x1,
    y1: cardBox.y1 + bestStart,
    x2: cardBox.x2,
    y2: cardBox.y1 + bestEnd,
  };
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function detectProductCandidatesFromPage(args: {
  pageImagePath: string;
  outputDir: string;
  pageNumber: number;
}): Promise<DetectedCandidate[]> {
  const { pageImagePath, outputDir, pageNumber } = args;
  await mkdir(outputDir, { recursive: true });

  const ANALYSIS_WIDTH = 800;
  const rawMeta = await sharp(pageImagePath).metadata();
  const origWidth = rawMeta.width ?? 800;
  const origHeight = rawMeta.height ?? 1000;

  const scale = Math.min(1, ANALYSIS_WIDTH / origWidth);
  const anaWidth = Math.round(origWidth * scale);
  const anaHeight = Math.round(origHeight * scale);

  const { data, info } = await sharp(pageImagePath)
    .resize(anaWidth, anaHeight, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { channels } = info;
  const pageArea = anaWidth * anaHeight;

  // Global content bounding box
  const globalBox = getBoundingBox(data, channels, anaWidth, anaHeight);
  if (!globalBox) return [];

  // Split page into distinct regions using whitespace gaps
  const rDens = rowDensities(data, channels, anaWidth, globalBox);
  const rowGaps = findGaps(rDens, GAP_DENSITY, MIN_GAP_SPAN);
  const rowRegions = rowGaps.length > 0 ? gapsToRegions(globalBox, rowGaps, "row") : [globalBox];

  const allBoxes: Box[] = [];
  for (const rowRegion of rowRegions) {
    const cDens = colDensities(data, channels, anaWidth, rowRegion);
    const colGaps = findGaps(cDens, GAP_DENSITY, MIN_GAP_SPAN);
    const cells = colGaps.length > 0 ? gapsToRegions(rowRegion, colGaps, "col") : [rowRegion];
    allBoxes.push(...cells);
  }

  // Filter minimum size at analysis resolution
  const candidateBoxes = allBoxes.filter((b) => {
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    return w >= MIN_CROP_PX * scale && h >= MIN_CROP_PX * scale && (w * h) / pageArea >= MIN_AREA_RATIO;
  });

  // If no regions found, try the global box as a fallback
  if (candidateBoxes.length === 0) {
    const w = globalBox.x2 - globalBox.x1 + 1;
    const h = globalBox.y2 - globalBox.y1 + 1;
    if (w >= MIN_CROP_PX * scale && h >= MIN_CROP_PX * scale) {
      candidateBoxes.push(globalBox);
    }
  }

  // For each detected region: evaluate quality + attempt inner search crop
  interface ScoredRegion {
    searchBox: Box;
    cardBox?: Box;
    qualityResult: ReturnType<typeof calculateCropQuality>;
    confidence: number;
  }

  const scoredRegions: ScoredRegion[] = [];

  for (const box of candidateBoxes) {
    const areaRatio = ((box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1)) / pageArea;
    const isLargeCard = areaRatio > 0.35;

    if (isLargeCard) {
      // Try to extract a tighter product crop from within the card
      const innerBox = extractSearchCropFromCard(data, channels, anaWidth, box);
      if (innerBox) {
        const qInner = calculateCropQuality(data, channels, anaWidth, innerBox, pageArea);
        scoredRegions.push({
          searchBox: innerBox,
          cardBox: box,
          qualityResult: qInner,
          confidence: 0.65,
        });
      } else {
        // Use the card itself, but it will be flagged card_too_large if > 75%
        const qCard = calculateCropQuality(data, channels, anaWidth, box, pageArea);
        scoredRegions.push({ searchBox: box, qualityResult: qCard, confidence: 0.40 });
      }
    } else {
      const q = calculateCropQuality(data, channels, anaWidth, box, pageArea);
      scoredRegions.push({ searchBox: box, qualityResult: q, confidence: 0.75 });
    }
  }

  // Sort: searchable first, then by score desc
  scoredRegions.sort((a, b) => {
    const aSearch = shouldIndexCrop(a.qualityResult.score, a.qualityResult.rejectReason) ? 1 : 0;
    const bSearch = shouldIndexCrop(b.qualityResult.score, b.qualityResult.rejectReason) ? 1 : 0;
    if (aSearch !== bSearch) return bSearch - aSearch;
    return b.qualityResult.score - a.qualityResult.score;
  });

  // Cap: max MAX_SEARCHABLE_PER_PAGE searchable + up to MAX_TOTAL_PER_PAGE total
  let searchableCount = 0;
  const finalRegions: typeof scoredRegions = [];
  for (const r of scoredRegions) {
    if (finalRegions.length >= MAX_TOTAL_PER_PAGE) break;
    const isS = shouldIndexCrop(r.qualityResult.score, r.qualityResult.rejectReason);
    if (isS && searchableCount >= MAX_SEARCHABLE_PER_PAGE) continue;
    if (isS) searchableCount++;
    finalRegions.push(r);
  }

  // Crop and save images
  const results: DetectedCandidate[] = [];
  let cropIndex = 1;

  for (const { searchBox, cardBox, qualityResult, confidence } of finalRegions) {
    // Scale back to original resolution
    const toOrig = (v: number) => Math.round(v / scale);
    const clampX = (v: number) => Math.max(0, Math.min(origWidth - 1, v));
    const clampY = (v: number) => Math.max(0, Math.min(origHeight - 1, v));

    const sx = clampX(toOrig(searchBox.x1));
    const sy = clampY(toOrig(searchBox.y1));
    const sw = Math.max(1, Math.min(origWidth - sx, toOrig(searchBox.x2 - searchBox.x1 + 1)));
    const sh = Math.max(1, Math.min(origHeight - sy, toOrig(searchBox.y2 - searchBox.y1 + 1)));

    if (sw < MIN_CROP_PX || sh < MIN_CROP_PX) continue;

    const prefix = `page-${String(pageNumber).padStart(3, "0")}-crop-${String(cropIndex).padStart(2, "0")}`;
    const imagePath = join(outputDir, `${prefix}.jpg`);

    await sharp(pageImagePath)
      .extract({ left: sx, top: sy, width: sw, height: sh })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toFile(imagePath);

    let cardImagePath: string | undefined;
    if (cardBox) {
      const cx = clampX(toOrig(cardBox.x1));
      const cy = clampY(toOrig(cardBox.y1));
      const cw = Math.max(1, Math.min(origWidth - cx, toOrig(cardBox.x2 - cardBox.x1 + 1)));
      const ch = Math.max(1, Math.min(origHeight - cy, toOrig(cardBox.y2 - cardBox.y1 + 1)));

      if (cw >= MIN_CROP_PX && ch >= MIN_CROP_PX) {
        cardImagePath = join(outputDir, `${prefix}-card.jpg`);
        await sharp(pageImagePath)
          .extract({ left: cx, top: cy, width: cw, height: ch })
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality: 85 })
          .toFile(cardImagePath);
      }
    }

    const isSearchable = shouldIndexCrop(qualityResult.score, qualityResult.rejectReason);

    results.push({
      imagePath,
      cardImagePath,
      x: sx, y: sy,
      width: sw, height: sh,
      confidence,
      qualityScore: qualityResult.score,
      isSearchable,
      rejectReason: qualityResult.rejectReason,
    });

    cropIndex++;
  }

  return results;
}
