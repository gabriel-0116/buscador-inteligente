import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import {
  callVisionProvider,
  logVisionUsage,
  mediaTypeFromPath,
  resolveProviderAndModel,
  VisionDetectorUnavailableError,
} from "@/features/catalog-processing/vision-json-detector";
import { VisionJsonParseError } from "@/features/catalog-processing/product-json-schema";

// ── Image → structured query profile ─────────────────────────────────────────
//
// Rafael sends a picture of a product. The system must turn that image into
// a *commercial profile* so we can search by intent — function group +
// must-not-confuse list — instead of by raw visual similarity.

// ── Schema ───────────────────────────────────────────────────────────────────

const trimmedNonEmpty = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

const optionalString = trimmedNonEmpty.optional().nullable();

const stringArray = z
  .union([
    z.array(z.union([z.string(), z.number(), z.boolean()])),
    z.string(),
    z.null(),
    z.undefined(),
  ])
  .transform((value) => {
    if (value == null) return [] as string[];
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v).trim())
        .filter((s) => s.length > 0);
    }
    return value
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  });

export const ImageQueryProfileSchema = z.object({
  mainProductNamePt: trimmedNonEmpty,
  functionGroup: trimmedNonEmpty,
  category: optionalString,
  colors: stringArray.default([]),
  visualAttributes: stringArray.default([]),
  technicalAttributes: stringArray.default([]),
  commercialUse: optionalString,
  possibleSynonyms: stringArray.default([]),
  mustNotMatch: stringArray.default([]),
  ambiguityNotes: stringArray.default([]),
  confidence: z
    .number()
    .finite()
    .transform((n) => Math.max(0, Math.min(1, n)))
    .default(0.5),
});

export type ImageQueryProfile = z.infer<typeof ImageQueryProfileSchema>;

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildQueryProfilePrompt(): string {
  return `Você é um analista que recebe uma foto/print/embalagem de um produto e a transforma em PERFIL DE BUSCA.

Esse perfil será comparado com catálogos de fornecedores. A função comercial do produto importa mais que a cor ou a aparência.

REGRAS DURAS:
- Foque no PRODUTO PRINCIPAL da imagem.
- Não descreva o cenário ao redor.
- Não invente atributos que não dá para confirmar.
- Identifique a função comercial (camera_infantil, antena, carregador_usb, fone_bluetooth, ring_light, …).
- Liste os produtos que VISUALMENTE PARECEM com este mas NÃO devem ser confundidos comercialmente (mustNotMatch).
  Exemplos:
    - antena com cabo preto -> mustNotMatch: cabo USB, cabo HDMI, cabo de energia, carregador, adaptador, fone.
    - câmera infantil rosa -> mustNotMatch: fone rosa, capa rosa, cabo rosa, brinquedo rosa sem câmera.
    - carregador de tomada -> mustNotMatch: cabo USB, adaptador sem função de carregador.
- Se houver dúvida, escreva em "ambiguityNotes".

Responda APENAS com JSON neste schema:

{
  "mainProductNamePt": "...",
  "functionGroup": "snake_case",
  "category": "...",
  "colors": ["..."],
  "visualAttributes": ["..."],
  "technicalAttributes": ["..."],
  "commercialUse": "...",
  "possibleSynonyms": ["..."],
  "mustNotMatch": ["..."],
  "ambiguityNotes": ["..."],
  "confidence": 0.0
}`;
}

// ── Tolerant JSON parser (same strategy as the page analyzer) ────────────────

function stripCodeFences(text: string): string {
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return fence ? fence[1].trim() : text.trim();
}

function extractFirstObject(text: string): string | null {
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

function tryParseAny(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {}
  const stripped = stripCodeFences(raw);
  if (stripped !== raw) {
    try {
      return JSON.parse(stripped);
    } catch {}
  }
  const obj = extractFirstObject(stripped);
  if (obj) {
    try {
      return JSON.parse(obj);
    } catch {}
  }
  throw new VisionJsonParseError(
    "No valid JSON object found in query profile response",
    raw
  );
}

export function parseImageQueryProfile(text: string): ImageQueryProfile {
  const parsed = tryParseAny(text);
  const result = ImageQueryProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionJsonParseError(
      `Query profile failed schema validation: ${result.error.message}`,
      text,
      result.error
    );
  }
  return result.data;
}

// ── Model selection ──────────────────────────────────────────────────────────

export function getQueryAnalyzerModel(): string | undefined {
  return (
    process.env.QUERY_ANALYZER_MODEL ||
    process.env.PAGE_ANALYZER_MODEL ||
    process.env.VISION_DETECTOR_MODEL_CHEAP ||
    process.env.VISION_DETECTOR_MODEL
  );
}

export function getQueryAnalyzerMaxOutputTokens(): number {
  const raw = process.env.QUERY_ANALYZER_MAX_OUTPUT_TOKENS;
  if (!raw) return 1200;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 200) return 1200;
  return n;
}

export function getQueryAnalyzerMaxImageWidth(): number {
  const raw = process.env.QUERY_ANALYZER_MAX_IMAGE_WIDTH;
  if (!raw) return 1024;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 256) return 1024;
  return n;
}

// ── Image preparation ────────────────────────────────────────────────────────
//
// Query images come straight from the user — could be HEIC, huge, rotated by
// EXIF, weird ratios. Normalize to a sane JPEG before sending to the model.

async function prepareQueryImage(input: {
  pathOrBuffer: string | Buffer;
}): Promise<{ path: string; mediaType: "image/jpeg" }> {
  const maxWidth = getQueryAnalyzerMaxImageWidth();
  const outPath = join(tmpdir(), `query-image-${randomUUID()}.jpg`);
  const source =
    typeof input.pathOrBuffer === "string"
      ? sharp(input.pathOrBuffer)
      : sharp(input.pathOrBuffer);
  await source
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(outPath);
  return { path: outPath, mediaType: "image/jpeg" };
}

// ── Public API ───────────────────────────────────────────────────────────────

export type AnalyzeImageQueryProfileResult = {
  provider: string;
  model: string;
  profile: ImageQueryProfile;
  rawText: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export async function analyzeImageQueryProfile(args: {
  pathOrBuffer: string | Buffer;
  modelOverride?: string;
}): Promise<AnalyzeImageQueryProfileResult> {
  const model = args.modelOverride ?? getQueryAnalyzerModel();
  if (!model) {
    throw new VisionDetectorUnavailableError(
      "QUERY_ANALYZER_MODEL (or fallbacks) must be set to analyze query images"
    );
  }
  const { provider, apiKey } = resolveProviderAndModel(model);

  const prepared = await prepareQueryImage({ pathOrBuffer: args.pathOrBuffer });
  let imageBase64: string;
  try {
    const buf = await readFile(prepared.path);
    imageBase64 = buf.toString("base64");
  } finally {
    // Clean up temp file regardless of API outcome.
    unlink(prepared.path).catch(() => {});
  }

  const mediaType = mediaTypeFromPath(prepared.path);

  const prompt = buildQueryProfilePrompt();

  const { text, usage } = await callVisionProvider({
    provider,
    apiKey,
    model,
    imageBase64,
    mediaType,
    prompt,
    maxTokens: getQueryAnalyzerMaxOutputTokens(),
  });

  logVisionUsage({
    provider,
    model,
    pageNumber: 0,
    tag: "query-analyzer-tokens",
    usage,
  });

  const profile = parseImageQueryProfile(text);

  return { provider, model, profile, rawText: text, usage };
}

// Convenience for the API route (File from FormData).
export async function analyzeImageQueryProfileFromFile(
  file: File
): Promise<AnalyzeImageQueryProfileResult> {
  const buffer = Buffer.from(await file.arrayBuffer());
  // The shared prep helper accepts a Buffer too — but writing to a tmp first
  // lets us read EXIF/orientation correctly via sharp.
  const tmpPath = join(tmpdir(), `query-input-${randomUUID()}`);
  await writeFile(tmpPath, buffer);
  try {
    return await analyzeImageQueryProfile({ pathOrBuffer: tmpPath });
  } finally {
    unlink(tmpPath).catch(() => {});
  }
}

// ── Query searchText helper ─────────────────────────────────────────────────

export function buildImageQuerySearchText(profile: ImageQueryProfile): string {
  const parts: Array<string | null | undefined> = [
    profile.mainProductNamePt,
    `função: ${profile.functionGroup}`,
    profile.category,
    profile.commercialUse ? `uso: ${profile.commercialUse}` : null,
    profile.colors.length ? `cores: ${profile.colors.join(", ")}` : null,
    profile.visualAttributes.length
      ? `aspecto: ${profile.visualAttributes.join(", ")}`
      : null,
    profile.technicalAttributes.length
      ? `técnico: ${profile.technicalAttributes.join(", ")}`
      : null,
    profile.possibleSynonyms.length
      ? `sinônimos: ${profile.possibleSynonyms.join(", ")}`
      : null,
    profile.mustNotMatch.length
      ? `Não confundir com: ${profile.mustNotMatch.join(", ")}`
      : null,
  ];
  return parts
    .map((p) => (p == null ? null : String(p).trim()))
    .filter((p): p is string => !!p && p.length > 0)
    .join("\n");
}
