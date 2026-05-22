import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import {
  parseVisionBoxesResponse,
  parseVisionJsonResponse,
  type PageProduct,
  type VisionBox,
} from "./product-json-schema";

// ── Multimodal vision detector (boxes-only MVP) ─────────────────────────────
//
// The MVP only needs *bounding boxes*. We ask the model for the smallest
// JSON we can get away with, and the page is downscaled to a cheap JPEG
// before being sent over the wire. Coordinates returned by the model are
// in the downscaled image; the orchestrator rescales them back to the
// original page before cropping.

export class VisionDetectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionDetectorUnavailableError";
  }
}

export type VisionMode = "always" | "auto" | "off";

export function getVisionMode(): VisionMode {
  const raw = process.env.VISION_DETECTOR_MODE?.toLowerCase();
  if (raw === "always" || raw === "off" || raw === "auto") return raw;
  return "auto";
}

export function getCheapVisionModel(): string | undefined {
  return (
    process.env.VISION_DETECTOR_MODEL_CHEAP || process.env.VISION_DETECTOR_MODEL
  );
}

export function getPremiumVisionModel(): string | undefined {
  return (
    process.env.VISION_DETECTOR_MODEL_PREMIUM ||
    process.env.VISION_DETECTOR_MODEL
  );
}

export function isPremiumFallbackEnabled(): boolean {
  return (
    (process.env.VISION_USE_PREMIUM_FALLBACK || "").toLowerCase().trim() ===
    "true"
  );
}

export function getMaxVisionPagesPerCatalog(): number {
  const raw = process.env.CATALOG_MAX_VISION_PAGES;
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 20;
  return n;
}

export function getMaxVisionImageWidth(): number {
  const raw = process.env.VISION_DETECTOR_MAX_IMAGE_WIDTH;
  if (!raw) return 1280;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 200) return 1280;
  return n;
}

export function getVisionJpegQuality(): number {
  const raw = process.env.VISION_DETECTOR_JPEG_QUALITY;
  if (!raw) return 75;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 30 || n > 100) return 75;
  return n;
}

export function getMaxVisionOutputTokens(): number {
  const raw = process.env.VISION_DETECTOR_MAX_OUTPUT_TOKENS;
  if (!raw) return 800;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 100) return 800;
  return n;
}

// ── prepareVisionInputImage ─────────────────────────────────────────────────
//
// Generates a temporary JPEG (max width, quality from env) and reports the
// scale factors so the caller can map model coordinates back to the
// original page coordinates.
//
// IMPORTANT: the downscaled image is for the model only. Cropping must
// always be done on the original full-resolution page.

export type PreparedVisionImage = {
  imagePath: string;
  width: number;
  height: number;
  scaleX: number; // multiply downscaled X by scaleX → original X
  scaleY: number;
};

export async function prepareVisionInputImage(args: {
  pageImagePath: string;
  maxWidth?: number;
  jpegQuality?: number;
}): Promise<PreparedVisionImage> {
  const maxWidth = args.maxWidth ?? getMaxVisionImageWidth();
  const jpegQuality = args.jpegQuality ?? getVisionJpegQuality();

  const meta = await sharp(args.pageImagePath).metadata();
  const origW = meta.width ?? 0;
  const origH = meta.height ?? 0;
  if (origW === 0 || origH === 0) {
    throw new Error(
      `prepareVisionInputImage: invalid source image ${args.pageImagePath}`
    );
  }

  const targetW = Math.min(origW, maxWidth);
  const scale = targetW / origW;
  const targetH = Math.max(1, Math.round(origH * scale));

  const outPath = join(tmpdir(), `vision-input-${randomUUID()}.jpg`);
  await sharp(args.pageImagePath)
    .resize(targetW, targetH, { fit: "fill" })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: jpegQuality, mozjpeg: true })
    .toFile(outPath);

  return {
    imagePath: outPath,
    width: targetW,
    height: targetH,
    scaleX: origW / targetW,
    scaleY: origH / targetH,
  };
}

// ── Prompts ─────────────────────────────────────────────────────────────────
//
// Boxes-only prompt — short, no metadata, no translation, no classification.

function buildBoxesPrompt(args: {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
}): string {
  return `Você está analisando uma página renderizada de um catálogo de fornecedor.

A imagem tem ${args.pageWidth} pixels de largura e ${args.pageHeight} pixels de altura.
Página: ${args.pageNumber}.

Sua tarefa é detectar os cards/produtos vendidos nesta página.

Retorne SOMENTE JSON válido, sem markdown e sem explicação:

{
  "pageNumber": ${args.pageNumber},
  "boxes": [
    { "x": number, "y": number, "width": number, "height": number, "confidence": number }
  ]
}

Regras:
- Cada produto/card comercial deve virar uma box separada.
- Não junte vários produtos na mesma box se eles aparecem separados.
- Ignore cabeçalho, rodapé, logo do catálogo, número da página, faixas decorativas e espaços vazios.
- Se a página tiver uma grade 3x3, retorne 9 boxes.
- Se tiver 2 produtos, retorne 2 boxes.
- Se a página não tiver produtos, retorne "boxes": [].
- A box deve cobrir o card/produto completo o suficiente para busca visual.
- Não tente descrever o produto.
- Não extraia texto.
- Não classifique categoria.
- Não traduza nada.
- As coordenadas devem estar em pixels da imagem recebida.
- Confidence deve estar entre 0 e 1.

Responda apenas com JSON.`;
}

// Legacy rich-metadata prompt — kept only as long as the deprecated function
// below exists. Not used by the MVP pipeline.
function buildLegacyRichPrompt(args: {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
}): string {
  return `Você está analisando uma página renderizada de um catálogo de fornecedor.

A imagem tem ${args.pageWidth} pixels de largura e ${args.pageHeight} pixels de altura.
Esta é a página número ${args.pageNumber} do catálogo.

Sua tarefa é identificar TODOS os produtos comerciais vendidos nesta página.

Retorne SOMENTE JSON válido, sem markdown, sem explicação.

{
  "pageNumber": ${args.pageNumber},
  "products": [
    {
      "box": { "x": number, "y": number, "width": number, "height": number },
      "confidence": number
    }
  ]
}

Responda APENAS com o objeto JSON, nada mais.`;
}

function mediaTypeFromPath(path: string): "image/jpeg" | "image/png" {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  return "image/jpeg";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type ProviderCallResult = {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

// ── Provider: Anthropic ─────────────────────────────────────────────────────

async function callAnthropic(args: {
  apiKey: string;
  model: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  prompt: string;
  maxTokens: number;
}): Promise<ProviderCallResult> {
  const res = await fetchWithTimeout(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": args.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: args.mediaType,
                  data: args.imageBase64,
                },
              },
              { type: "text", text: args.prompt },
            ],
          },
        ],
      }),
    },
    120_000
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const textBlock = json.content?.find((c) => c.type === "text" && c.text);
  if (!textBlock?.text) {
    throw new Error("Anthropic response had no text block");
  }
  const inputTokens = json.usage?.input_tokens;
  const outputTokens = json.usage?.output_tokens;
  return {
    text: textBlock.text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens != null && outputTokens != null
          ? inputTokens + outputTokens
          : undefined,
    },
  };
}

// ── Provider: OpenAI ────────────────────────────────────────────────────────

async function callOpenAI(args: {
  apiKey: string;
  model: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  prompt: string;
  maxTokens: number;
}): Promise<ProviderCallResult> {
  const dataUrl = `data:${args.mediaType};base64,${args.imageBase64}`;
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: args.prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    },
    120_000
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI response had no content");
  }
  return {
    text,
    usage: {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      totalTokens: json.usage?.total_tokens,
    },
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isVisionDetectorConfigured(): boolean {
  return Boolean(
    process.env.VISION_DETECTOR_PROVIDER &&
      process.env.VISION_DETECTOR_API_KEY &&
      (process.env.VISION_DETECTOR_MODEL_CHEAP ||
        process.env.VISION_DETECTOR_MODEL_PREMIUM ||
        process.env.VISION_DETECTOR_MODEL)
  );
}

function resolveProviderAndModel(modelOverride?: string): {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
} {
  const provider = process.env.VISION_DETECTOR_PROVIDER?.toLowerCase();
  const apiKey = process.env.VISION_DETECTOR_API_KEY;
  const model =
    modelOverride ||
    process.env.VISION_DETECTOR_MODEL_CHEAP ||
    process.env.VISION_DETECTOR_MODEL;

  if (!provider || !apiKey || !model) {
    throw new VisionDetectorUnavailableError(
      "VISION_DETECTOR_PROVIDER, VISION_DETECTOR_API_KEY and a model (VISION_DETECTOR_MODEL_CHEAP/PREMIUM or VISION_DETECTOR_MODEL) must all be set"
    );
  }
  if (provider !== "anthropic" && provider !== "openai") {
    throw new VisionDetectorUnavailableError(
      `Unsupported VISION_DETECTOR_PROVIDER: ${provider} (supported: anthropic, openai)`
    );
  }
  return { provider, apiKey, model };
}

async function callProvider(args: {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  prompt: string;
  maxTokens: number;
}): Promise<ProviderCallResult> {
  if (args.provider === "anthropic") {
    return callAnthropic({
      apiKey: args.apiKey,
      model: args.model,
      imageBase64: args.imageBase64,
      mediaType: args.mediaType,
      prompt: args.prompt,
      maxTokens: args.maxTokens,
    });
  }
  return callOpenAI({
    apiKey: args.apiKey,
    model: args.model,
    imageBase64: args.imageBase64,
    mediaType: args.mediaType,
    prompt: args.prompt,
    maxTokens: args.maxTokens,
  });
}

function logUsage(args: {
  provider: string;
  model: string;
  pageNumber: number;
  usage?: ProviderCallResult["usage"];
}) {
  if (!args.usage) return;
  const { inputTokens, outputTokens, totalTokens } = args.usage;
  console.log(
    `[vision-tokens] page ${args.pageNumber} provider=${args.provider} model=${args.model} input=${inputTokens ?? "?"} output=${outputTokens ?? "?"} total=${totalTokens ?? "?"}`
  );
}

// ── Boxes-only detector (MVP) ───────────────────────────────────────────────

export type VisionBoxesResult = {
  provider: string;
  model: string;
  rawJson: unknown;
  rawText: string;
  boxes: VisionBox[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

/**
 * Sends a (downscaled) page to the multimodal model and asks for bounding
 * boxes only. Returns boxes in *image-input* coordinates — the caller is
 * responsible for scaling them back to the original page.
 */
export async function detectProductBoxesWithVision(args: {
  pageImagePath: string; // path to the image you actually send to the model
  pageNumber: number;
  pageWidth: number; // width of the image you send to the model
  pageHeight: number; // height of the image you send to the model
  modelOverride?: string;
}): Promise<VisionBoxesResult> {
  const { provider, apiKey, model } = resolveProviderAndModel(args.modelOverride);

  const imageBuffer = await readFile(args.pageImagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mediaType = mediaTypeFromPath(args.pageImagePath);
  const maxTokens = getMaxVisionOutputTokens();

  const prompt = buildBoxesPrompt({
    pageNumber: args.pageNumber,
    pageWidth: args.pageWidth,
    pageHeight: args.pageHeight,
  });

  const { text, usage } = await callProvider({
    provider,
    apiKey,
    model,
    imageBase64,
    mediaType,
    prompt,
    maxTokens,
  });

  logUsage({ provider, model, pageNumber: args.pageNumber, usage });

  const parsed = parseVisionBoxesResponse(text);

  return {
    provider,
    model,
    rawJson: parsed,
    rawText: text,
    boxes: parsed.boxes,
    usage,
  };
}

// ── Legacy rich-metadata detector (deprecated) ──────────────────────────────
//
// Kept temporarily so existing callers still compile. New code should use
// `detectProductBoxesWithVision`. This function still hits the API and
// returns product[].box; it just uses a shorter prompt to avoid the old
// expensive rich-metadata response.

export type VisionDetectorResult = {
  provider: string;
  model: string;
  rawJson: unknown;
  rawText: string;
  products: PageProduct[];
};

/** @deprecated Use `detectProductBoxesWithVision`. */
export async function detectProductsJsonWithVision(args: {
  pageImagePath: string;
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  modelOverride?: string;
}): Promise<VisionDetectorResult> {
  const { provider, apiKey, model } = resolveProviderAndModel(args.modelOverride);

  const imageBuffer = await readFile(args.pageImagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mediaType = mediaTypeFromPath(args.pageImagePath);
  const maxTokens = getMaxVisionOutputTokens();

  const prompt = buildLegacyRichPrompt({
    pageNumber: args.pageNumber,
    pageWidth: args.pageWidth,
    pageHeight: args.pageHeight,
  });

  const { text, usage } = await callProvider({
    provider,
    apiKey,
    model,
    imageBase64,
    mediaType,
    prompt,
    maxTokens,
  });

  logUsage({ provider, model, pageNumber: args.pageNumber, usage });

  const parsed = parseVisionJsonResponse(text);

  return {
    provider,
    model,
    rawJson: parsed,
    rawText: text,
    products: parsed.products,
  };
}
