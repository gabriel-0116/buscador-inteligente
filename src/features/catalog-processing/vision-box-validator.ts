import type { Box, PageProduct } from "./product-json-schema";

// ── Box validation for vision-detector output ───────────────────────────────
//
// The multimodal model can return geometry that is unusable: out-of-bounds
// boxes, page-wide rectangles, decorative strips. We clamp first, then drop
// boxes that fall outside the "product card" envelope, and finally dedup by
// IoU so two boxes describing the same product don't both get indexed.

export type ValidatedProduct = PageProduct & {
  rejectReason?: string;
};

const MIN_SIDE_PX = 180; // smallest acceptable side in page-image pixels
const MAX_AREA_RATIO = 0.85; // anything that covers nearly the page is rejected
const HEADER_FRACTION = 0.1;
const FOOTER_FRACTION = 0.92;
const HORIZONTAL_BAR_ASPECT = 4.5;
const VERTICAL_COLUMN_ASPECT = 0.22;

function clampBox(box: Box, pageWidth: number, pageHeight: number): Box | null {
  // Coords sometimes come as normalized [0, 1]; detect and rescale.
  const looksNormalized =
    box.x <= 1 &&
    box.y <= 1 &&
    box.x + box.width <= 1.01 &&
    box.y + box.height <= 1.01;
  let x = box.x;
  let y = box.y;
  let width = box.width;
  let height = box.height;
  if (looksNormalized) {
    x *= pageWidth;
    y *= pageHeight;
    width *= pageWidth;
    height *= pageHeight;
  }

  // Clamp into the page rectangle
  const x1 = Math.max(0, Math.min(pageWidth - 1, x));
  const y1 = Math.max(0, Math.min(pageHeight - 1, y));
  const x2 = Math.max(0, Math.min(pageWidth, x + width));
  const y2 = Math.max(0, Math.min(pageHeight, y + height));

  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return null;
  return { x: x1, y: y1, width: w, height: h };
}

function classifyBox(
  box: Box,
  pageWidth: number,
  pageHeight: number
): string | undefined {
  const aspect = box.width / box.height;
  const areaRatio = (box.width * box.height) / (pageWidth * pageHeight);

  if (box.width < MIN_SIDE_PX || box.height < MIN_SIDE_PX) return "too_small";
  if (areaRatio > MAX_AREA_RATIO) return "too_large";

  // Whole box sitting in the top/bottom strip = header/footer/page metadata
  const topFrac = box.y / pageHeight;
  const botFrac = (box.y + box.height) / pageHeight;
  if (botFrac < HEADER_FRACTION || topFrac > FOOTER_FRACTION) {
    return "header_footer";
  }

  if (aspect > HORIZONTAL_BAR_ASPECT) return "horizontal_bar";
  if (aspect < VERTICAL_COLUMN_ASPECT) return "vertical_column";

  return undefined;
}

export function validateVisionBoxes(args: {
  products: PageProduct[];
  pageWidth: number;
  pageHeight: number;
}): ValidatedProduct[] {
  const { products, pageWidth, pageHeight } = args;
  const validated: ValidatedProduct[] = [];

  for (const p of products) {
    const clamped = clampBox(p.box, pageWidth, pageHeight);
    if (!clamped) {
      validated.push({ ...p, rejectReason: "invalid_box" });
      continue;
    }
    const reason = classifyBox(clamped, pageWidth, pageHeight);
    validated.push({ ...p, box: clamped, rejectReason: reason });
  }

  return validated;
}

// ── IoU dedup ───────────────────────────────────────────────────────────────

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Removes overlapping boxes. When two boxes overlap above the threshold,
 * the one with higher `confidence` wins (ties broken by area — larger card
 * wins, since the model often emits both inner-object and outer-card boxes).
 */
export function dedupeBoxesByIoU(
  products: ValidatedProduct[],
  threshold = 0.65
): ValidatedProduct[] {
  // Sort: validated (no reject) before rejected, then by confidence desc.
  const sorted = [...products].sort((a, b) => {
    const aOk = a.rejectReason ? 0 : 1;
    const bOk = b.rejectReason ? 0 : 1;
    if (aOk !== bOk) return bOk - aOk;
    return b.confidence - a.confidence;
  });

  const kept: ValidatedProduct[] = [];
  for (const candidate of sorted) {
    let isDup = false;
    for (const prev of kept) {
      if (iou(candidate.box, prev.box) >= threshold) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      kept.push({ ...candidate, rejectReason: candidate.rejectReason ?? "duplicate" });
    } else {
      kept.push(candidate);
    }
  }
  return kept;
}
