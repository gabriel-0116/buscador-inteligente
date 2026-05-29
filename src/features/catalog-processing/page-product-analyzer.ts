import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  callVisionProvider,
  logVisionUsage,
  mediaTypeFromPath,
  prepareVisionInputImage,
  resolveProviderAndModel,
  VisionDetectorUnavailableError,
} from "./vision-json-detector";
import { VisionJsonParseError } from "./product-json-schema";

// ── Page-level product analyzer ─────────────────────────────────────────────
//
// Strategy: the page is the visual result, the *mention* is the unit of
// intelligence. We ask the multimodal model to enumerate the commercial
// products visible on the page and return structured metadata for each.
//
// IMPORTANT:
// - No bounding boxes are requested.
// - No coordinates.
// - No crop.
// - All names/descriptions in pt-BR.
// - Function group is more important than appearance — we record it
//   explicitly and surface `notConfuseWith` to drive the reranker.

// ── Output schema ───────────────────────────────────────────────────────────

const trimmedNonEmpty = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

const optionalString = trimmedNonEmpty.optional().nullable();

// Always returns a normalized string[] — even if the model sent a string or null.
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

export const EvidenceSourceSchema = z
  .enum(["vision", "pdf_text", "both", "manual"])
  .catch("vision");

export const PageProductMentionInputSchema = z.object({
  namePt: trimmedNonEmpty,
  originalName: optionalString,
  descriptionPt: optionalString,
  category: optionalString,
  functionGroup: trimmedNonEmpty,
  colors: stringArray.default([]),
  visualAttributes: stringArray.default([]),
  technicalAttributes: stringArray.default([]),
  commercialUse: optionalString,
  isKit: z.coerce.boolean().optional().default(false),
  kitContains: stringArray.default([]),
  confidence: z
    .number()
    .finite()
    .transform((n) => Math.max(0, Math.min(1, n)))
    .default(0.5),
  evidenceText: optionalString,
  evidenceSource: EvidenceSourceSchema.default("vision"),
  notConfuseWith: stringArray.default([]),
});

export type PageProductMentionInput = z.infer<
  typeof PageProductMentionInputSchema
>;

export const PageProductAnalysisSchema = z.object({
  pageNumber: z.number().int().nonnegative().optional(),
  products: z.array(PageProductMentionInputSchema).default([]),
  pageSummary: optionalString,
  hasProducts: z.boolean().optional(),
});

export type PageProductAnalysis = {
  pageNumber: number;
  products: PageProductMentionInput[];
  pageSummary?: string | null;
  hasProducts: boolean;
};

// ── Prompt ──────────────────────────────────────────────────────────────────

function buildPageAnalyzerPrompt(args: {
  pageNumber: number;
  supplierName?: string;
  catalogFileName?: string;
  pdfTextSnippet?: string | null;
}): string {
  const header =
    args.supplierName || args.catalogFileName
      ? `Fornecedor: ${args.supplierName ?? "desconhecido"}\nCatálogo: ${
          args.catalogFileName ?? "—"
        }\nPágina: ${args.pageNumber}`
      : `Página: ${args.pageNumber}`;

  const pdfText = args.pdfTextSnippet
    ? `\n\nTexto extraído do PDF nesta página (pode estar incompleto, use só para apoiar a evidência textual):\n"""\n${args.pdfTextSnippet.slice(0, 4000)}\n"""`
    : "";

  return `Você está analisando uma página de catálogo de fornecedor.

${header}${pdfText}

Sua tarefa é identificar quais produtos REAIS aparecem nesta página.

Regras:
- NÃO retorne bounding boxes.
- NÃO retorne coordenadas.
- NÃO recorte produtos.
- NÃO invente produtos.
- NÃO liste banners, títulos de seção, marcas, rodapés, selos, chamadas promocionais ou categorias como se fossem produtos.
- Traduza nomes e descrições para português do Brasil.
- A FUNÇÃO COMERCIAL importa mais que aparência. Exemplos:
  - Antena com cabo preto ≠ cabo USB preto.
  - Câmera infantil rosa ≠ fone rosa.
  - Carregador ≠ cabo ≠ adaptador.
- Se a página for capa, sumário, índice, página vazia, página de categoria sem produto: retorne "products": [] e "hasProducts": false.
- Se for um KIT (vários itens vendidos juntos), marque "isKit": true e liste em "kitContains" os principais itens incluídos.
- Liste acessórios apenas quando forem produtos vendidos isoladamente — não cole acessório dentro do mesmo produto principal.

Para cada produto retorne:
- "namePt": nome em pt-BR;
- "originalName": nome original (inglês/chinês/etc), se houver;
- "descriptionPt": descrição curta em pt-BR;
- "category": categoria comercial (ex.: "Eletrônicos infantis");
- "functionGroup": função comercial normalizada em snake_case (ex.: "camera_infantil", "antena", "carregador_usb", "fone_bluetooth");
- "colors": cores principais;
- "visualAttributes": atributos visuais (ex.: "tela pequena", "botões frontais", "formato compacto");
- "technicalAttributes": atributos técnicos visíveis (ex.: "câmera digital", "Bluetooth 5.0");
- "commercialUse": para que serve, em pt-BR;
- "isKit": boolean;
- "kitContains": se kit, principais itens incluídos;
- "confidence": número entre 0 e 1;
- "evidenceText": trecho de texto do catálogo que confirma o produto (use o texto do PDF acima quando ajudar);
- "evidenceSource": "vision" | "pdf_text" | "both" | "manual";
- "notConfuseWith": lista de produtos que se parecem mas NÃO devem ser confundidos com este.

Responda SOMENTE com JSON válido, sem markdown, no formato:

{
  "pageNumber": ${args.pageNumber},
  "products": [ ... ],
  "pageSummary": "resumo curto da página em pt-BR (opcional)",
  "hasProducts": true | false
}`;
}

// ── Tolerant JSON parser ────────────────────────────────────────────────────
//
// Reuses the same tolerant strategies as the vision boxes parser: try direct
// parse, strip code fences, then balanced-brace scan. We re-implement here
// instead of reusing the boxes-only parser because the schema differs.

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
    "No valid JSON object found in analyzer response",
    raw
  );
}

export function parsePageAnalyzerResponse(text: string): PageProductAnalysis {
  const parsed = tryParseAny(text);
  const result = PageProductAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new VisionJsonParseError(
      `Page analyzer JSON failed schema validation: ${result.error.message}`,
      text,
      result.error
    );
  }
  const products = result.data.products;
  return {
    pageNumber: result.data.pageNumber ?? 0,
    products,
    pageSummary: result.data.pageSummary ?? null,
    hasProducts:
      typeof result.data.hasProducts === "boolean"
        ? result.data.hasProducts
        : products.length > 0,
  };
}

// ── Provider/model resolution for the analyzer ──────────────────────────────
//
// Reuses VISION_DETECTOR_PROVIDER / VISION_DETECTOR_API_KEY but allows a
// dedicated model override so the analyzer can use a cheaper or more
// capable model than the boxes-only detector.

export function getPageAnalyzerModel(): string | undefined {
  return (
    process.env.PAGE_ANALYZER_MODEL ||
    process.env.VISION_DETECTOR_MODEL_CHEAP ||
    process.env.VISION_DETECTOR_MODEL
  );
}

export function getPageAnalyzerMaxOutputTokens(): number {
  const raw = process.env.PAGE_ANALYZER_MAX_OUTPUT_TOKENS;
  if (!raw) return 2400;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 400) return 2400;
  return n;
}

export function isPageAnalyzerConfigured(): boolean {
  return Boolean(
    process.env.VISION_DETECTOR_PROVIDER &&
      process.env.VISION_DETECTOR_API_KEY &&
      getPageAnalyzerModel()
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

export type AnalyzeCatalogPageProductsResult = {
  provider: string;
  model: string;
  analysis: PageProductAnalysis;
  rawText: string;
  rawJson: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export async function analyzeCatalogPageProducts(args: {
  pageImagePath: string;
  pageNumber: number;
  supplierName?: string;
  catalogFileName?: string;
  pdfTextBlocks?: Array<{
    text: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }>;
  modelOverride?: string;
}): Promise<AnalyzeCatalogPageProductsResult> {
  const model = args.modelOverride ?? getPageAnalyzerModel();
  if (!model) {
    throw new VisionDetectorUnavailableError(
      "PAGE_ANALYZER_MODEL (or VISION_DETECTOR_MODEL_CHEAP/MODEL) must be set to analyze pages"
    );
  }

  const { provider, apiKey } = resolveProviderAndModel(model);

  // Downscale page for cost — analyzer doesn't need full resolution to read.
  const prepared = await prepareVisionInputImage({
    pageImagePath: args.pageImagePath,
  });

  const imageBuffer = await readFile(prepared.imagePath);
  const imageBase64 = imageBuffer.toString("base64");
  const mediaType = mediaTypeFromPath(prepared.imagePath);

  const pdfTextSnippet = (args.pdfTextBlocks ?? [])
    .map((b) => b.text)
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .join("\n")
    .trim();

  const prompt = buildPageAnalyzerPrompt({
    pageNumber: args.pageNumber,
    supplierName: args.supplierName,
    catalogFileName: args.catalogFileName,
    pdfTextSnippet: pdfTextSnippet.length > 0 ? pdfTextSnippet : null,
  });

  const { text, usage } = await callVisionProvider({
    provider,
    apiKey,
    model,
    imageBase64,
    mediaType,
    prompt,
    maxTokens: getPageAnalyzerMaxOutputTokens(),
  });

  logVisionUsage({
    provider,
    model,
    pageNumber: args.pageNumber,
    tag: "page-analyzer-tokens",
    usage,
  });

  const analysis = parsePageAnalyzerResponse(text);
  // Force pageNumber from the caller — the model is unreliable here.
  analysis.pageNumber = args.pageNumber;

  return {
    provider,
    model,
    analysis,
    rawText: text,
    rawJson: analysis,
    usage,
  };
}

// ── Search-text helper ──────────────────────────────────────────────────────
//
// Consolidates everything we want to embed into one block of natural text.
// The reranker still reads the structured fields directly — searchText is
// only for the embedding.

export function buildPageProductSearchText(
  product: PageProductMentionInput
): string {
  const parts: Array<string | null | undefined> = [
    product.namePt,
    product.originalName,
    product.descriptionPt,
    product.category,
    product.functionGroup ? `função: ${product.functionGroup}` : null,
    product.commercialUse ? `uso: ${product.commercialUse}` : null,
    product.colors.length ? `cores: ${product.colors.join(", ")}` : null,
    product.visualAttributes.length
      ? `aspecto: ${product.visualAttributes.join(", ")}`
      : null,
    product.technicalAttributes.length
      ? `técnico: ${product.technicalAttributes.join(", ")}`
      : null,
    product.isKit && product.kitContains.length
      ? `kit contém: ${product.kitContains.join(", ")}`
      : null,
    product.notConfuseWith.length
      ? `Não confundir com: ${product.notConfuseWith.join(", ")}`
      : null,
  ];
  return parts
    .map((p) => (p == null ? null : String(p).trim()))
    .filter((p): p is string => !!p && p.length > 0)
    .join("\n");
}
