import { z } from "zod";

// ── Zod schemas for the multimodal vision response ──────────────────────────
//
// The model is asked to return a JSON object describing the products on a
// rendered catalog page. We validate every field that downstream code reads.

export const BoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

const nullableString = z.string().trim().min(1).nullable().optional();

export const PageProductSchema = z.object({
  box: BoxSchema,
  productName: nullableString,
  productNamePt: nullableString,
  category: nullableString,
  functionGroup: nullableString,
  model: nullableString,
  originalText: nullableString,
  descriptionPt: nullableString,
  // The prompt asks for a number in [0, 1]; clamp if the model goes slightly out.
  confidence: z
    .number()
    .finite()
    .transform((n) => Math.max(0, Math.min(1, n))),
});

export const PageAnalysisSchema = z.object({
  pageNumber: z.number().int().nonnegative().optional(),
  products: z.array(PageProductSchema).default([]),
});

export type Box = z.infer<typeof BoxSchema>;
export type PageProduct = z.infer<typeof PageProductSchema>;
export type PageAnalysisJson = z.infer<typeof PageAnalysisSchema>;

// ── Safe parser ─────────────────────────────────────────────────────────────
//
// Vision models tend to wrap JSON in code fences or add prose around it. Try
// the cheapest extraction strategies first, then fall back to balanced-brace
// scanning to find the largest top-level object.

export class VisionJsonParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "VisionJsonParseError";
  }
}

function stripCodeFences(text: string): string {
  // ```json ... ``` or ``` ... ```
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return fence ? fence[1].trim() : text.trim();
}

function extractFirstObject(text: string): string | null {
  // Walk the string, count braces ignoring those inside string literals.
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(raw: string): unknown {
  // 1) direct
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  // 2) strip markdown fences then parse
  const stripped = stripCodeFences(raw);
  if (stripped !== raw) {
    try {
      return JSON.parse(stripped);
    } catch {
      // fall through
    }
  }
  // 3) scan for the first balanced {...} block
  const obj = extractFirstObject(stripped);
  if (obj) {
    try {
      return JSON.parse(obj);
    } catch {
      // fall through
    }
  }
  throw new VisionJsonParseError("No valid JSON object found in response", raw);
}

/**
 * Parse a vision model's response into a validated PageAnalysisJson.
 * Throws VisionJsonParseError on failure (caller decides whether to fallback).
 */
export function parseVisionJsonResponse(text: string): PageAnalysisJson {
  const parsed = tryParse(text);
  const result = PageAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionJsonParseError(
      `Vision JSON failed schema validation: ${result.error.message}`,
      text,
      result.error
    );
  }
  return result.data;
}
