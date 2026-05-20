import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export type DetectedCandidate = {
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
};

const MIN_CROP_PX = 180;
const MIN_AREA_RATIO = 0.03;
const MAX_CANDIDATES_PER_PAGE = 3;
// Row/col is a separator if < GAP_DENSITY of pixels are non-white
const GAP_DENSITY = 0.04;
// Minimum consecutive gap rows/cols to count as a separator
const MIN_GAP_SPAN = 8;

type Box = { x1: number; y1: number; x2: number; y2: number };

function isWhitePixel(data: Buffer, offset: number) {
  return data[offset] > 244 && data[offset + 1] > 244 && data[offset + 2] > 244;
}

function getBoundingBox(
  data: Buffer,
  width: number,
  height: number,
  channels: number
): Box | null {
  let x1 = width, y1 = height, x2 = 0, y2 = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      if (!isWhitePixel(data, offset)) {
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

function rowDensities(data: Buffer, width: number, channels: number, box: Box): number[] {
  const colCount = box.x2 - box.x1 + 1;
  const result: number[] = [];
  for (let y = box.y1; y <= box.y2; y++) {
    let nonWhite = 0;
    for (let x = box.x1; x <= box.x2; x++) {
      if (!isWhitePixel(data, (y * width + x) * channels)) nonWhite++;
    }
    result.push(nonWhite / colCount);
  }
  return result;
}

function colDensities(data: Buffer, width: number, channels: number, box: Box): number[] {
  const rowCount = box.y2 - box.y1 + 1;
  const result: number[] = [];
  for (let x = box.x1; x <= box.x2; x++) {
    let nonWhite = 0;
    for (let y = box.y1; y <= box.y2; y++) {
      if (!isWhitePixel(data, (y * width + x) * channels)) nonWhite++;
    }
    result.push(nonWhite / rowCount);
  }
  return result;
}

// Returns average "colorfulness" per row (how much color vs grayscale).
// Product photos tend to be more colorful; logos/text tend to be monochromatic.
function rowColorfulness(data: Buffer, width: number, channels: number, box: Box): number[] {
  const colCount = box.x2 - box.x1 + 1;
  const result: number[] = [];
  for (let y = box.y1; y <= box.y2; y++) {
    let colorfulness = 0;
    for (let x = box.x1; x <= box.x2; x++) {
      const off = (y * width + x) * channels;
      const r = data[off], g = data[off + 1], b = data[off + 2];
      colorfulness += Math.max(r, g, b) - Math.min(r, g, b);
    }
    result.push(colorfulness / (255 * colCount));
  }
  return result;
}

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

// For single-product pages: find the most "colorful" horizontal zone (likely the product photo)
// and return a sub-crop centered on it, removing header logos and footer text.
function findColorfulZoneCrop(
  data: Buffer,
  anaWidth: number,
  channels: number,
  globalBox: Box,
  pageArea: number
): { box: Box; confidence: number } | null {
  const colorfulness = rowColorfulness(data, anaWidth, channels, globalBox);
  const density = rowDensities(data, anaWidth, channels, globalBox);

  // Smooth with a window average
  const windowSize = Math.max(3, Math.round(colorfulness.length * 0.05));
  const smoothed: number[] = colorfulness.map((_, i) => {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(colorfulness.length - 1, i + windowSize);
    let sum = 0;
    for (let j = start; j <= end; j++) sum += colorfulness[j] * density[j];
    return sum / (end - start + 1);
  });

  // Find peak colorfulness row
  let peakIdx = 0;
  for (let i = 1; i < smoothed.length; i++) {
    if (smoothed[i] > smoothed[peakIdx]) peakIdx = i;
  }

  // Expand window around peak to capture the full product region
  const totalRows = globalBox.y2 - globalBox.y1 + 1;
  const targetH = Math.round(totalRows * 0.55);
  const subY1 = Math.max(0, peakIdx - Math.round(targetH * 0.5));
  const subY2 = Math.min(smoothed.length - 1, subY1 + targetH - 1);
  if (subY2 - subY1 < Math.round(totalRows * 0.3)) return null;

  // Convert back to box coordinates
  const absY1 = globalBox.y1 + subY1;
  const absY2 = globalBox.y1 + subY2;
  const subBox = { x1: globalBox.x1, y1: absY1, x2: globalBox.x2, y2: absY2 };
  const subArea = (subBox.x2 - subBox.x1 + 1) * (subBox.y2 - subBox.y1 + 1);

  if (subArea / pageArea < MIN_AREA_RATIO) return null;

  return { box: subBox, confidence: 0.60 };
}

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

  const globalBox = getBoundingBox(data, anaWidth, anaHeight, channels);
  if (!globalBox) return [];

  const contentW = globalBox.x2 - globalBox.x1 + 1;
  const contentH = globalBox.y2 - globalBox.y1 + 1;
  if (contentW < MIN_CROP_PX * scale || contentH < MIN_CROP_PX * scale) return [];

  const contentArea = contentW * contentH;
  const contentRatio = contentArea / pageArea;

  // Try to split by whitespace gaps (works well for multi-product grids)
  const rDens = rowDensities(data, anaWidth, channels, globalBox);
  const rowGaps = findGaps(rDens, GAP_DENSITY, MIN_GAP_SPAN);
  const rowRegions = rowGaps.length > 0 ? gapsToRegions(globalBox, rowGaps, "row") : [globalBox];

  const boxes: Box[] = [];
  for (const rowRegion of rowRegions) {
    const cDens = colDensities(data, anaWidth, channels, rowRegion);
    const colGaps = findGaps(cDens, GAP_DENSITY, MIN_GAP_SPAN);
    const cellBoxes = colGaps.length > 0 ? gapsToRegions(rowRegion, colGaps, "col") : [rowRegion];
    boxes.push(...cellBoxes);
  }

  // Filter by minimum size
  const validBoxes = boxes.filter((b) => {
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    return (
      w >= MIN_CROP_PX * scale &&
      h >= MIN_CROP_PX * scale &&
      (w * h) / pageArea >= MIN_AREA_RATIO
    );
  });

  // Score: prefer squarish boxes with reasonable area
  const scored = validBoxes.map((b) => {
    const w = b.x2 - b.x1 + 1;
    const h = b.y2 - b.y1 + 1;
    const ar = w / h;
    const aspectScore = ar >= 0.4 && ar <= 2.5 ? 1.0 : 0.4;
    const areaScore = Math.min(1.0, (w * h) / (0.25 * pageArea));
    return { box: b, confidence: Math.min(0.92, aspectScore * 0.35 + areaScore * 0.65) };
  });

  scored.sort((a, b) => b.confidence - a.confidence);

  // If only 1 block found and it covers most of the page → single-product card.
  // Add a colorfulness-based sub-crop to try to isolate the product photo from logos/text.
  if (validBoxes.length === 1 && contentRatio > 0.45) {
    const colorZone = findColorfulZoneCrop(data, anaWidth, channels, globalBox, pageArea);
    if (colorZone) {
      // Only add if meaningfully smaller than the main box (actually cropping something)
      const mainH = globalBox.y2 - globalBox.y1 + 1;
      const subH = colorZone.box.y2 - colorZone.box.y1 + 1;
      if (subH < mainH * 0.85) {
        scored.push(colorZone);
      }
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const topCandidates = scored.slice(0, MAX_CANDIDATES_PER_PAGE);

  // Fallback: use trimmed global box if nothing passed the filters
  if (topCandidates.length === 0) {
    const pad = Math.round(8 * scale);
    topCandidates.push({
      box: {
        x1: Math.max(0, globalBox.x1 - pad),
        y1: Math.max(0, globalBox.y1 - pad),
        x2: Math.min(anaWidth - 1, globalBox.x2 + pad),
        y2: Math.min(anaHeight - 1, globalBox.y2 + pad),
      },
      confidence: 0.20,
    });
  }

  const results: DetectedCandidate[] = [];
  let cropIndex = 1;

  for (const { box, confidence } of topCandidates) {
    const x = Math.round(box.x1 / scale);
    const y = Math.round(box.y1 / scale);
    const w = Math.min(origWidth - x, Math.round((box.x2 - box.x1 + 1) / scale));
    const h = Math.min(origHeight - y, Math.round((box.y2 - box.y1 + 1) / scale));

    if (w < MIN_CROP_PX || h < MIN_CROP_PX) continue;

    const fileName = `page-${String(pageNumber).padStart(3, "0")}-crop-${String(cropIndex).padStart(2, "0")}.jpg`;
    const imagePath = join(outputDir, fileName);

    await sharp(pageImagePath)
      .extract({ left: x, top: y, width: w, height: h })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toFile(imagePath);

    results.push({ imagePath, x, y, width: w, height: h, confidence });
    cropIndex++;
  }

  return results;
}
