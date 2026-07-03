import { readFile, rm } from "node:fs/promises";
import { z } from "zod";
import {
  callVisionProvider,
  logVisionUsage,
  mediaTypeFromPath,
  prepareVisionInputImage,
  resolveProviderAndModel,
  VisionDetectorUnavailableError,
  VisionJsonParseError,
} from "./vision-json-detector";

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

// Local LLMs (Qwen2.5-VL, MiniCPM-V, …) often emit "" instead of null when a
// field is unknown, unlike the hosted OpenAI/Anthropic models this schema
// was originally shaped for. Coerce "" / whitespace-only into null so an
// otherwise-valid page doesn't get rejected wholesale for a couple of empty
// strings.
const optionalString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (v === null || v === undefined) return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  });

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
  // Strong textual signals — see atualizacao.md Part 1.
  brand: optionalString,
  modelCodes: stringArray.default([]),
  aliases: stringArray.default([]),
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
- Liste acessórios apenas quando forem produtos vendidos isoladamente — não cole acessório dentro do mesmo produto principal.

ORDEM VISUAL (obrigatória):
- Liste os produtos na ordem visual da página: da esquerda para a direita e de cima para baixo.
- Em uma grade 3x3, retorne primeiro os 3 produtos da primeira linha, depois os 3 da segunda linha, depois os 3 da terceira linha.
- Em uma grade 2x2 ou parcial, mantenha a mesma regra. A posição do produto no array já é a sua ordem visual; não é necessário retornar coordenadas.

REGRA ESTRITA DE isKit:
- "isKit" deve ser true SOMENTE quando o item é vendido explicitamente como kit, combo, conjunto, pacote ou pack com VÁRIOS produtos principais.
- Caixa, embalagem, manual, instruções, cabo USB, cabo de carga, carregador, escova de limpeza, estojo, case, bolsa, tampa, adaptador ou acessórios básicos inclusos NÃO tornam o produto um kit.
- Se for apenas UM produto principal com acessórios inclusos, use "isKit": false.
- Não coloque a palavra "Kit"/"Combo"/"Conjunto" em "namePt" a menos que o catálogo realmente indique kit/combo/conjunto/pacote.

Exemplos:
- Barbeador elétrico com cabo USB e caixa → isKit=false.
- Câmera infantil com cabo USB e embalagem → isKit=false.
- Aparelho com estojo → isKit=false, a menos que o catálogo diga explicitamente kit.
- Kit câmera + cartão + tripé → isKit=true.
- Kit escolar com lápis + borracha + régua → isKit=true.
- Combo gamer (teclado + mouse + headset) → isKit=true.

Para cada produto retorne:
- "namePt": nome em pt-BR;
- "originalName": nome original (inglês/chinês/etc), se houver;
- "descriptionPt": descrição curta em pt-BR;
- "category": categoria comercial (ex.: "Eletrônicos infantis");
- "functionGroup": função comercial normalizada em snake_case (ex.: "camera_infantil", "antena", "carregador_usb", "fone_bluetooth", "barbeador_eletrico", "maquina_cortar_cabelo");
- "brand": marca visível no produto/embalagem (ex.: "Kemei", "Xiaomi", "Anker"). Null se não houver.
- "modelCodes": array de códigos/modelos/SKUs visíveis (ex.: ["KM-7103"], ["BMQ-KM-7108", "LFJ-3124"]). Inclua todos os códigos que aparecerem para esse produto.
- "aliases": 3 a 8 sinônimos comerciais para multiplicar o recall da busca — misture pt-BR, inglês e (quando útil) chinês. NÃO repita o namePt.
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

REGRA DE CÓDIGOS/MODELOS:
- Extraia padrões como "KM-7103", "KM-293", "BMQ-KM-7108", "LFJ-3124", "TXD-KM-T389", "KM-3385", "BMQ-3006".
- NUNCA deixe um código aparecer SÓ em descriptionPt ou evidenceText — ele tem que estar em "modelCodes".
- Mantenha hífens originais (não normalize).

REGRA DE ALIASES (3 a 8 termos, sem inventar):
- barbeador_eletrico → ["barbeador", "máquina de barbear", "aparelho de barbear", "electric shaver", "shaver", "剃须刀"].
- maquina_cortar_cabelo → ["máquina de cortar cabelo", "cortador de cabelo", "hair clipper", "clipper", "理发器"].
- aparador_pelos_nariz → ["aparador de nariz", "aparador nasal", "nose trimmer", "鼻毛器"].
- camera_infantil → ["câmera infantil", "kids camera", "children camera", "câmera digital infantil"].
- antena → ["antena interna", "antena digital", "indoor antenna"].
- carregador_usb → ["carregador", "fonte usb", "usb charger"].

Exemplo de produto bem extraído:

{
  "namePt": "Barbeador elétrico 3 em 1",
  "originalName": "拔毛器（三合一、数显、USB） / 包好 / KM-7103",
  "brand": "Kemei",
  "modelCodes": ["KM-7103"],
  "aliases": ["barbeador", "máquina de barbear", "electric shaver", "剃须刀"],
  "functionGroup": "barbeador_eletrico",
  "category": "Cuidados pessoais",
  "colors": ["dourado", "roxo"],
  "visualAttributes": ["formato compacto", "cabeças intercambiáveis"],
  "technicalAttributes": ["USB", "3 em 1", "display digital"],
  "commercialUse": "barbear pelos do rosto",
  "isKit": false,
  "kitContains": [],
  "confidence": 0.92,
  "evidenceText": "KM-7103",
  "evidenceSource": "both",
  "notConfuseWith": ["aparador de nariz", "máquina de cortar cabelo", "cabo USB"]
}

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
  // Defensive post-processing: the model occasionally marks isKit=true when
  // the product just ships with a USB cable / case / manual. Downgrade those
  // before they reach the DB.
  const products = result.data.products.map(normalizeKitFlag);
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

// ── normalizeKitFlag (defensive isKit downgrade) ────────────────────────────
//
// The analyzer sometimes flips isKit=true for any product that ships with
// basic accessories (cable, box, manual). A real kit has a kit/combo/
// conjunto/pacote/pack keyword in the catalog text OR contains 2+ items
// that are themselves *products* (camera + tripod + memory card), not just
// the packaging. This helper enforces that rule conservatively: when there
// is no textual kit evidence AND every entry in kitContains looks like a
// basic accessory, force isKit=false and clear kitContains.

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    // Strip combining diacritics so "instruções" → "instrucoes".
    .replace(/\p{M}+/gu, "")
    .trim();
}

const KIT_KEYWORDS = [
  "kit",
  "combo",
  "conjunto",
  "pacote",
  "pack",
];

function mentionsKitKeyword(value: string | null | undefined): boolean {
  if (!value) return false;
  const n = normalizeForMatch(value);
  if (!n) return false;
  return KIT_KEYWORDS.some((kw) =>
    // Word-boundaryish — surround by non-letter or string edges so we don't
    // match "packet" or "kitchen".
    new RegExp(`(?:^|[^a-z0-9])${kw}(?:[^a-z0-9]|$)`).test(n)
  );
}

// Items that, alone, never make a "kit": packaging, cables, chargers, etc.
const BASIC_ACCESSORY_PATTERNS: RegExp[] = [
  /\bcabo(s)?\b/,
  /\bcable(s)?\b/,
  /\busb\b/,
  /\bmanual(is|es)?\b/,
  /\binstrucoes\b/,
  /\binstructions?\b/,
  /\bcaixa\b/,
  /\bembalagem\b/,
  /\bbox\b/,
  /\bpackaging\b/,
  /\bcarregador(es)?\b/,
  /\bcharger(s)?\b/,
  /\bfonte\b/,
  /\badaptador(es)?\b/,
  /\badapter(s)?\b/,
  /\bescova de limpeza\b/,
  /\bescovinha\b/,
  /\bcleaning brush\b/,
  /\bestojo\b/,
  /\bcase\b/,
  /\bpouch\b/,
  /\bbolsa\b/,
  /\btampa\b/,
  /\bcap\b/,
  /\blid\b/,
];

function isBasicAccessory(item: string): boolean {
  const n = normalizeForMatch(item);
  if (!n) return true; // empty/blank entries are harmless filler
  return BASIC_ACCESSORY_PATTERNS.some((re) => re.test(n));
}

export function normalizeKitFlag(
  product: PageProductMentionInput
): PageProductMentionInput {
  if (!product.isKit) return product;

  // 1) Textual evidence wins — if anywhere it says kit/combo/etc, trust it.
  if (
    mentionsKitKeyword(product.namePt) ||
    mentionsKitKeyword(product.originalName) ||
    mentionsKitKeyword(product.evidenceText)
  ) {
    return product;
  }

  // 2) No textual evidence. Look at kitContains.
  if (product.kitContains.length === 0) {
    return { ...product, isKit: false };
  }
  const allAccessories = product.kitContains.every(isBasicAccessory);
  if (allAccessories) {
    return { ...product, isKit: false, kitContains: [] };
  }

  // Has multiple non-accessory items even without a kit keyword — leave alone.
  return product;
}

// ── Provider/model resolution for the analyzer ──────────────────────────────
//
// Reuses VISION_DETECTOR_PROVIDER / VISION_DETECTOR_API_KEY but allows a
// dedicated model override; VISION_DETECTOR_MODEL_CHEAP remains a legitimate
// fallback so a single env var can configure both analyzers at once.

export function getPageAnalyzerModel(): string | undefined {
  return (
    process.env.PAGE_ANALYZER_MODEL || process.env.VISION_DETECTOR_MODEL_CHEAP
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
      "PAGE_ANALYZER_MODEL (or VISION_DETECTOR_MODEL_CHEAP) must be set to analyze pages"
    );
  }

  const { provider, apiKey } = resolveProviderAndModel(model);

  // Downscale page for cost — analyzer doesn't need full resolution to read.
  // The downscaled JPEG lives in /tmp; clean it up regardless of API outcome
  // so we don't leak a file per page in a 100-page catalog.
  const prepared = await prepareVisionInputImage({
    pageImagePath: args.pageImagePath,
  });

  try {
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
  } finally {
    await rm(prepared.imagePath, { force: true }).catch(() => {});
  }
}

// ── Search-text helper ──────────────────────────────────────────────────────
//
// Consolidates everything we want to embed into one block of natural text.
// The reranker still reads the structured fields directly — searchText is
// only for the embedding.

export function buildPageProductSearchText(
  product: PageProductMentionInput
): string {
  // Multi-signal blob fed to the text embedding: brand / model code / aliases
  // / evidenceText broaden recall across languages (chinese ⇄ english ⇄
  // pt-BR) without depending on translation quality. The reranker still
  // reads the structured fields directly — searchText is only the embedding
  // input.
  const parts: Array<string | null | undefined> = [
    product.namePt,
    product.originalName,
    product.descriptionPt,
    product.brand ? `marca: ${product.brand}` : null,
    product.modelCodes.length
      ? `modelos/códigos: ${product.modelCodes.join(", ")}`
      : null,
    product.aliases.length ? `sinônimos: ${product.aliases.join(", ")}` : null,
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
    product.evidenceText
      ? `texto original/evidência: ${product.evidenceText}`
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
