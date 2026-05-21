import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import {
  parseVisionJsonResponse,
  type PageProduct,
} from "./product-json-schema";

// ── Multimodal vision detector ──────────────────────────────────────────────
//
// Sends a rendered catalog page to a multimodal LLM and asks it to return a
// JSON list of products with bounding boxes. The provider is configurable via
// env so we are not married to a single vendor — `anthropic` and `openai` are
// implemented out of the box; new providers slot in here.

export class VisionDetectorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionDetectorUnavailableError";
  }
}

export type VisionDetectorResult = {
  provider: string;
  model: string;
  rawJson: unknown;
  rawText: string;
  products: PageProduct[];
};

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
  return (process.env.VISION_USE_PREMIUM_FALLBACK || "")
    .toLowerCase()
    .trim() === "true";
}

export function getMaxVisionPagesPerCatalog(): number {
  const raw = process.env.CATALOG_MAX_VISION_PAGES;
  if (!raw) return 20;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 20;
  return n;
}

// The prompt is intentionally strict about JSON-only output so we don't need
// to chase markdown fences (though the parser handles them anyway).
function buildPrompt(args: {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
}): string {
  return `Você está analisando uma página renderizada de um catálogo de fornecedor.

A imagem tem ${args.pageWidth} pixels de largura e ${args.pageHeight} pixels de altura.
Esta é a página número ${args.pageNumber} do catálogo.

Sua tarefa é identificar TODOS os produtos comerciais vendidos nesta página.

Retorne SOMENTE JSON válido, sem markdown, sem explicação, no formato exato:

{
  "pageNumber": ${args.pageNumber},
  "products": [
    {
      "box": { "x": number, "y": number, "width": number, "height": number },
      "productName": string | null,
      "productNamePt": string | null,
      "category": string | null,
      "functionGroup": string | null,
      "model": string | null,
      "originalText": string | null,
      "descriptionPt": string | null,
      "confidence": number
    }
  ]
}

Regras:
- Cada card/produto vendido vira um item separado.
- Não junte múltiplos produtos em um único box se aparecem como cards separados.
- Ignore cabeçalho, rodapé, número da página, título de seção, logo do catálogo, faixas decorativas, tabela vazia e espaços em branco.
- Se a página tiver grade 3x3 de produtos, retorne 9 produtos.
- Se a página for capa, sumário ou não tiver produtos, retorne products: [].
- O box deve estar em PIXELS relativos à imagem inteira (não normalize para 0-1).
- O box deve cobrir o card/produto inteiro: imagem do produto, embalagem e texto principal.
- Não tente isolar apenas o objeto físico. O card completo é aceitável.
- productNamePt e descriptionPt devem estar em português quando possível.
- functionGroup é a função comercial em snake_case: carregador, cabo_usb, hub_usb, antena_tv, suporte_tv, barbeador_eletrico, fone_bluetooth, controle_game, mouse, teclado, ring_light, lanterna, umidificador, microfone, adaptador, ferramenta_eletrica, desconhecido.
- confidence deve estar entre 0 e 1.

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

// ── Provider: Anthropic ─────────────────────────────────────────────────────

async function callAnthropic(args: {
  apiKey: string;
  model: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  prompt: string;
}): Promise<string> {
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
        max_tokens: 4096,
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
  };
  const textBlock = json.content?.find((c) => c.type === "text" && c.text);
  if (!textBlock?.text) {
    throw new Error("Anthropic response had no text block");
  }
  return textBlock.text;
}

// ── Provider: OpenAI ────────────────────────────────────────────────────────

async function callOpenAI(args: {
  apiKey: string;
  model: string;
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png";
  prompt: string;
}): Promise<string> {
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
        // Ask for JSON object output if the chosen model supports it.
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
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("OpenAI response had no content");
  }
  return text;
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

export async function detectProductsJsonWithVision(args: {
  pageImagePath: string;
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  modelOverride?: string;
}): Promise<VisionDetectorResult> {
  const provider = process.env.VISION_DETECTOR_PROVIDER?.toLowerCase();
  const apiKey = process.env.VISION_DETECTOR_API_KEY;
  const model =
    args.modelOverride ||
    process.env.VISION_DETECTOR_MODEL_CHEAP ||
    process.env.VISION_DETECTOR_MODEL;

  if (!provider || !apiKey || !model) {
    throw new VisionDetectorUnavailableError(
      "VISION_DETECTOR_PROVIDER, VISION_DETECTOR_API_KEY and a model (VISION_DETECTOR_MODEL_CHEAP/PREMIUM or VISION_DETECTOR_MODEL) must all be set"
    );
  }

  const imageBuffer = await readFile(args.pageImagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mediaType = mediaTypeFromPath(args.pageImagePath);

  const prompt = buildPrompt({
    pageNumber: args.pageNumber,
    pageWidth: args.pageWidth,
    pageHeight: args.pageHeight,
  });

  let rawText: string;
  if (provider === "anthropic") {
    rawText = await callAnthropic({ apiKey, model, imageBase64, mediaType, prompt });
  } else if (provider === "openai") {
    rawText = await callOpenAI({ apiKey, model, imageBase64, mediaType, prompt });
  } else {
    throw new VisionDetectorUnavailableError(
      `Unsupported VISION_DETECTOR_PROVIDER: ${provider} (supported: anthropic, openai)`
    );
  }

  const parsed = parseVisionJsonResponse(rawText);

  return {
    provider,
    model,
    rawJson: parsed,
    rawText,
    products: parsed.products,
  };
}
