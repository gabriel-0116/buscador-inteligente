import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  detectProductsJsonWithVision,
  isVisionDetectorConfigured,
  VisionDetectorUnavailableError,
} from "./vision-json-detector";
import {
  dedupeBoxesByIoU,
  validateVisionBoxes,
} from "./vision-box-validator";

export type SourceDetector = "VISION_JSON" | "HEURISTIC" | "FALLBACK";

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
  // Structured metadata produced by the vision detector. All optional —
  // heuristic-only candidates leave these undefined.
  productName?: string;
  productNamePt?: string;
  category?: string;
  functionGroup?: string;
  model?: string;
  originalText?: string;
  descriptionPt?: string;
  sourceDetector?: SourceDetector;
  visionConfidence?: number;
  rawVisionJson?: unknown;
};

export type PageAnalysisInfo = {
  provider?: string;
  model?: string;
  rawJson?: unknown;
  productsCount: number;
  error?: string;
  sourceDetector: SourceDetector;
};

export type PageDetectionResult = {
  candidates: DetectedCandidate[];
  pageAnalysis: PageAnalysisInfo;
};

// ── Constants ────────────────────────────────────────────────────────────────

const ANALYSIS_WIDTH = 800;
const MIN_CARD_PX_ORIG = 220;
const MIN_AREA_RATIO = 0.015;
const MAX_SEARCHABLE_PER_PAGE = 12;
const MAX_TOTAL_PER_PAGE = 18;
const QUALITY_THRESHOLD = 0.6;
const GAP_DENSITY = 0.04;
const MIN_GAP_SPAN = 8;
// Minimum vision-model confidence to allow a candidate into the search index.
const VISION_CONFIDENCE_FLOOR = 0.45;

type Box = { x1: number; y1: number; x2: number; y2: number };

const SEVERE_REJECTS = new Set([
  "too_small",
  "too_large",
  "mostly_white",
  "green_bar",
  "orange_bar",
  "color_bar",
  "header_footer",
  "horizontal_bar",
  "vertical_column",
  "empty_cell",
  "too_horizontal",
  "too_vertical",
  "insufficient_content",
  "card_too_large",
  "page_like_crop",
  "invalid_box",
  "invalid_json",
  "duplicate",
  "low_confidence",
]);

// ── Low-level pixel helpers ──────────────────────────────────────────────────

function isWhite(r: number, g: number, b: number) {
  return r > 240 && g > 240 && b > 240;
}

function isGreen(r: number, g: number, b: number) {
  return g > 100 && g > r + 40 && g > b + 40;
}

function isOrange(r: number, g: number, b: number) {
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
  if (aspectRatio > 2.5 && heightOrig < MIN_CARD_PX_ORIG * 1.2) return true;
  return false;
}

function isTooVertical(aspectRatio: number): boolean {
  return aspectRatio < 0.3;
}

function hasEnoughVisualMass(nonWhiteRatio: number): boolean {
  return nonWhiteRatio >= 0.05;
}

// ── Heuristic card quality (page-context aware) ─────────────────────────────

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

  const topFrac = box.y1 / pageHeight;
  const botFrac = box.y2 / pageHeight;
  if (botFrac < 0.1 || topFrac > 0.92) {
    return { score: 0, rejectReason: "header_footer" };
  }

  const areaRatio = bArea / pageArea;
  if (areaRatio > 0.75) {
    return { score: 0.25, rejectReason: "page_like_crop" };
  }

  const central = centralMassRatio(data, channels, width, box);
  const aspectScore =
    aspectRatio >= 0.6 && aspectRatio <= 1.6
      ? 1.0
      : Math.max(0, 1.0 - Math.abs(Math.log(aspectRatio)) * 0.5);
  const massScore = Math.min(1.0, stats.nonWhiteRatio * 5);
  const centralScore = Math.min(1.0, central * 2.5);
  const areaScore =
    areaRatio < 0.02
      ? areaRatio * 30
      : areaRatio > 0.55
        ? Math.max(0.3, 1.0 - (areaRatio - 0.55) * 2)
        : 1.0;

  const textDensity = estimateTextLikeDensity(data, channels, width, box);
  const textPenalty = Math.max(0, textDensity - 0.09) * 5;
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

// ── Standalone crop quality (no page-context — for already-validated boxes) ─

async function evaluateCropImageQuality(
  imagePath: string
): Promise<{ score: number; rejectReason?: string }> {
  const meta = await sharp(imagePath).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (origW === 0 || origH === 0) return { score: 0, rejectReason: "invalid_box" };

  const ANALYSIS_W = 600;
  const scale = Math.min(1, ANALYSIS_W / origW);
  const w = Math.max(1, Math.round(origW * scale));
  const h = Math.max(1, Math.round(origH * scale));

  const { data, info } = await sharp(imagePath)
    .resize(w, h, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });

  const fullBox: Box = { x1: 0, y1: 0, x2: w - 1, y2: h - 1 };
  const stats = pixelStats(data, info.channels, w, fullBox);

  if (stats.whiteRatio > 0.92) return { score: 0, rejectReason: "mostly_white" };
  if (stats.nonWhiteRatio < 0.04) return { score: 0, rejectReason: "insufficient_content" };

  const aspectRatio = w / h;
  const barCheck = isColorBarDominant(stats.greenRatio, stats.orangeRatio, aspectRatio);
  if (barCheck.isBar) return { score: 0, rejectReason: barCheck.reason };

  const central = centralMassRatio(data, info.channels, w, fullBox);
  const textDensity = estimateTextLikeDensity(data, info.channels, w, fullBox);

  const aspectScore =
    aspectRatio >= 0.5 && aspectRatio <= 1.8
      ? 1.0
      : Math.max(0, 1.0 - Math.abs(Math.log(aspectRatio)) * 0.5);
  const massScore = Math.min(1.0, stats.nonWhiteRatio * 5);
  const centralScore = Math.min(1.0, central * 2.5);
  const textPenalty = Math.max(0, textDensity - 0.1) * 5;
  const colorLeakPenalty =
    Math.max(0, stats.greenRatio - 0.22) * 1.2 +
    Math.max(0, stats.orangeRatio - 0.22) * 1.2;

  const score = Math.max(
    0,
    Math.min(
      0.95,
      massScore * 0.35 +
        centralScore * 0.25 +
        aspectScore * 0.2 +
        // Base bonus: this box already passed envelope/dedup checks, so it
        // starts with credit for being a legitimate card.
        0.2 -
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

// ── Gap detection / region splitting ────────────────────────────────────────

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

// ── Heuristic detector ──────────────────────────────────────────────────────
//
// Used as a fallback when the vision detector is not configured or fails.
// Splits the page into a grid of cells via whitespace gaps and scores each
// cell with `calculateCardQuality`.

async function runHeuristicDetector(args: {
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

  const candidateBoxes = cells.filter((b) => {
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    return (
      w >= minCardPxAna &&
      h >= minCardPxAna &&
      (w * h) / pageArea >= MIN_AREA_RATIO
    );
  });

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

// ── Vision-detector pipeline ────────────────────────────────────────────────

async function runVisionDetector(args: {
  pageImagePath: string;
  outputDir: string;
  pageNumber: number;
}): Promise<{ candidates: DetectedCandidate[]; pageAnalysis: PageAnalysisInfo }> {
  await mkdir(args.outputDir, { recursive: true });

  const meta = await sharp(args.pageImagePath).metadata();
  const pageWidth = meta.width ?? 0;
  const pageHeight = meta.height ?? 0;

  const vision = await detectProductsJsonWithVision({
    pageImagePath: args.pageImagePath,
    pageNumber: args.pageNumber,
    pageWidth,
    pageHeight,
  });

  const validated = validateVisionBoxes({
    products: vision.products,
    pageWidth,
    pageHeight,
  });
  const deduped = dedupeBoxesByIoU(validated, 0.65);

  const candidates: DetectedCandidate[] = [];
  let cropIndex = 1;

  for (const product of deduped) {
    const { box } = product;
    let { rejectReason } = product;

    const sx = Math.max(0, Math.min(pageWidth - 1, Math.round(box.x)));
    const sy = Math.max(0, Math.min(pageHeight - 1, Math.round(box.y)));
    const sw = Math.max(
      1,
      Math.min(pageWidth - sx, Math.round(box.width))
    );
    const sh = Math.max(
      1,
      Math.min(pageHeight - sy, Math.round(box.height))
    );

    const prefix = `page-${String(args.pageNumber).padStart(3, "0")}-crop-${String(cropIndex).padStart(2, "0")}`;
    const imagePath = join(args.outputDir, `${prefix}.jpg`);

    try {
      await sharp(args.pageImagePath)
        .extract({ left: sx, top: sy, width: sw, height: sh })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: 90 })
        .toFile(imagePath);
    } catch (err) {
      console.error(
        `[vision] page ${args.pageNumber} crop ${cropIndex} extract failed:`,
        err
      );
      continue;
    }

    let qualityScore = 0;
    if (!rejectReason) {
      const local = await evaluateCropImageQuality(imagePath);
      qualityScore = local.score;
      if (local.rejectReason) rejectReason = local.rejectReason;
    }

    const visionConf = product.confidence;
    let isSearchable =
      !rejectReason &&
      qualityScore >= QUALITY_THRESHOLD &&
      visionConf >= VISION_CONFIDENCE_FLOOR;

    if (!rejectReason && visionConf < VISION_CONFIDENCE_FLOOR) {
      rejectReason = "low_confidence";
      isSearchable = false;
    }

    candidates.push({
      imagePath,
      x: sx,
      y: sy,
      width: sw,
      height: sh,
      confidence: visionConf,
      qualityScore,
      isSearchable,
      rejectReason,
      productName: product.productName ?? undefined,
      productNamePt: product.productNamePt ?? undefined,
      category: product.category ?? undefined,
      functionGroup: product.functionGroup ?? undefined,
      model: product.model ?? undefined,
      originalText: product.originalText ?? undefined,
      descriptionPt: product.descriptionPt ?? undefined,
      sourceDetector: "VISION_JSON",
      visionConfidence: visionConf,
      rawVisionJson: product,
    });

    cropIndex++;
  }

  return {
    candidates,
    pageAnalysis: {
      provider: vision.provider,
      model: vision.model,
      rawJson: vision.rawJson,
      productsCount: vision.products.length,
      sourceDetector: "VISION_JSON",
    },
  };
}

// ── Orchestrator (public API) ───────────────────────────────────────────────

export async function detectProductCandidatesFromPage(args: {
  pageImagePath: string;
  outputDir: string;
  pageNumber: number;
}): Promise<PageDetectionResult> {
  // Try the vision detector first when configured.
  if (isVisionDetectorConfigured()) {
    try {
      const result = await runVisionDetector(args);
      const searchable = result.candidates.filter((c) => c.isSearchable).length;
      console.log(
        `[detector] page ${args.pageNumber}: VISION → raw=${result.pageAnalysis.productsCount} valid=${result.candidates.length} searchable=${searchable}`
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof VisionDetectorUnavailableError)) {
        console.error(
          `[detector] page ${args.pageNumber}: vision failed (${msg}) → heuristic fallback`
        );
      }
      const heuristic = await runHeuristicDetector(args);
      const searchable = heuristic.filter((c) => c.isSearchable).length;
      console.log(
        `[detector] page ${args.pageNumber}: FALLBACK → ${heuristic.length} candidates, ${searchable} searchable`
      );
      return {
        candidates: heuristic.map((c) => ({
          ...c,
          sourceDetector: "FALLBACK" as const,
        })),
        pageAnalysis: {
          productsCount: heuristic.length,
          error: msg,
          sourceDetector: "FALLBACK",
        },
      };
    }
  }

  // No vision config → use heuristic as the primary detector.
  console.log(
    `[detector] page ${args.pageNumber}: HEURISTIC (vision detector not configured)`
  );
  const heuristic = await runHeuristicDetector(args);
  const searchable = heuristic.filter((c) => c.isSearchable).length;
  console.log(
    `[detector] page ${args.pageNumber}: HEURISTIC → ${heuristic.length} candidates, ${searchable} searchable`
  );
  return {
    candidates: heuristic.map((c) => ({
      ...c,
      sourceDetector: "HEURISTIC" as const,
    })),
    pageAnalysis: {
      productsCount: heuristic.length,
      sourceDetector: "HEURISTIC",
    },
  };
}
