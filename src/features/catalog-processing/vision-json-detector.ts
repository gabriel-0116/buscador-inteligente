import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

// ── Multimodal provider plumbing ────────────────────────────────────────────
//
// Provider call + image-prep primitives shared by the page analyzer and the
// query-image analyzer. No detector cascade anymore — that lived here in a
// previous life and was deleted along with `detect-product-candidates`.
//
// File name is preserved (vs. `multimodal-provider.ts` etc.) so existing
// imports keep resolving; rename can happen in a separate, isolated commit.

export class VisionDetectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionDetectorUnavailableError";
  }
}

// Raised when a multimodal response can't be parsed as the expected JSON.
// Kept here (instead of a separate `product-json-schema.ts`) because every
// caller imports it alongside the provider primitives.
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

// ── Env helpers (only what the page/query analyzers actually use) ───────────

function getMaxVisionImageWidth(): number {
  const raw = process.env.VISION_DETECTOR_MAX_IMAGE_WIDTH;
  if (!raw) return 1280;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 200) return 1280;
  return n;
}

function getVisionJpegQuality(): number {
  const raw = process.env.VISION_DETECTOR_JPEG_QUALITY;
  if (!raw) return 75;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 30 || n > 100) return 75;
  return n;
}

// ── prepareVisionInputImage ─────────────────────────────────────────────────
//
// Downscales the page to a JPEG and reports the scale factors so the caller
// can map model coordinates back to original page coordinates if it ever
// needs to (the page analyzer doesn't — it just needs the cheaper input).

export type PreparedVisionImage = {
  imagePath: string;
  width: number;
  height: number;
  scaleX: number;
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

export function mediaTypeFromPath(path: string): "image/jpeg" | "image/png" {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  return "image/jpeg";
}

// ── Provider selection ─────────────────────────────────────────────────────

export function resolveProviderAndModel(model: string): {
  provider: "anthropic" | "openai";
  apiKey: string;
  model: string;
} {
  const provider = process.env.VISION_DETECTOR_PROVIDER?.toLowerCase();
  const apiKey = process.env.VISION_DETECTOR_API_KEY;

  if (!provider || !apiKey || !model) {
    throw new VisionDetectorUnavailableError(
      "VISION_DETECTOR_PROVIDER, VISION_DETECTOR_API_KEY and a model (PAGE_ANALYZER_MODEL / QUERY_ANALYZER_MODEL / VISION_DETECTOR_MODEL_CHEAP) must all be set"
    );
  }
  if (provider !== "anthropic" && provider !== "openai") {
    throw new VisionDetectorUnavailableError(
      `Unsupported VISION_DETECTOR_PROVIDER: ${provider} (supported: anthropic, openai)`
    );
  }
  return { provider, apiKey, model };
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

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

export type VisionProviderUsage = ProviderCallResult["usage"];

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
        max_completion_tokens: args.maxTokens,
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

export async function callVisionProvider(args: {
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

export function logVisionUsage(args: {
  provider: string;
  model: string;
  pageNumber: number;
  tag?: string;
  usage?: ProviderCallResult["usage"];
}) {
  if (!args.usage) return;
  const { inputTokens, outputTokens, totalTokens } = args.usage;
  const tag = args.tag ?? "vision-tokens";
  console.log(
    `[${tag}] page ${args.pageNumber} provider=${args.provider} model=${args.model} input=${inputTokens ?? "?"} output=${outputTokens ?? "?"} total=${totalTokens ?? "?"}`
  );
}
