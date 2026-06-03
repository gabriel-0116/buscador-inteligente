# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # dev server (uses webpack, not turbopack)
pnpm build        # production build (also uses webpack)
pnpm lint         # eslint
pnpm format       # prettier write
pnpm format:check # prettier check

# Python — required by the PDF text-extractor used by the page analyzer
pip install -r scripts/requirements.txt   # or: pip install PyMuPDF
# Node spawns `python3` (override with PYTHON_BIN); must be able to `import fitz`

# Prisma — uses DIRECT_URL (not DATABASE_URL) for migrations
npx prisma migrate dev    # create + apply migration (shadow DB may fail with pgvector — use migrate deploy instead)
npx prisma migrate deploy # apply migrations in production
npx prisma generate       # regenerate client after schema changes
npx prisma studio         # local DB browser

# Debug scripts
npx tsx scripts/test-page-analyzer.ts <catalog.pdf> [page page ...]
# Runs the multimodal analyzer on chosen pages of a PDF; no DB writes.
npx tsx scripts/test-page-search.ts --image <path> [--limit N] [--debug]
# End-to-end search against the live DB; `--debug` also prints rejected/related.
npx tsx scripts/debug-catalog-processing.ts <catalogId>
# Catalog audit: status, counters, Catalog.error, PageAnalysis errors per page.
```

## Architecture

**Purpose:** Internal product-search tool — upload supplier PDF catalogs, search by image, get back the **catalog pages** containing the queried product. The page is the visual result; the product detected on the page is the unit of intelligence (function group > main product > color > look). See `PAGE_LEVEL_SEARCH_REFACTOR.md` and `SPEC-buscador-imagem.md` for the full rationale.

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma 7 · PyMuPDF (Python) for PDF text/layout · OpenAI / Anthropic multimodal models for the page analyzer + image query profile · OpenAI `text-embedding-3-small` (1536 dim) for semantic search · DINOv2 (`@xenova/transformers`, 768 dim) for full-page visual similarity.

### Data flow — upload

`POST /api/catalogs` receives the PDF, saves it to `/tmp`, and fires `processCatalog` fire-and-forget. `processCatalog` then:

1. Uploads the original PDF to Supabase Storage at `{catalogId}/original/catalog.pdf` (so the catalog can be reprocessed later).
2. Renders each page with `pdftoppm -jpeg -r 180`, uploads pages to `{catalogId}/pages/page-NNN.jpg`.
3. Runs `extractPdfLayout` once (PyMuPDF → per-page text blocks). Failure here just means the analyzer runs without the PDF-text evidence.
4. For each page:
   - Generates the **full-page DINOv2 visual embedding** (`vector(768)` on `CatalogPage.visualEmbedding`). Failure here is non-fatal — visual-only matches are capped at "low confidence" anyway.
   - Calls `analyzeCatalogPageProducts` (multimodal — no boxes, no crops). The model returns one entry per product: `namePt`, `originalName`, `brand`, `modelCodes[]`, `aliases[]`, `category`, `functionGroup`, `colors[]`, `visualAttributes[]`, `technicalAttributes[]`, `notConfuseWith[]`, `commercialUse`, `isKit`, `kitContains[]`, `evidenceText`, `confidence`. Order in the array = visual order (left→right, top→bottom).
   - Each entry becomes a `PageProductMention` row (`displayOrder = i + 1`). A consolidated `searchText` is built per mention (multi-signal: brand + codes + aliases + evidence + …) and embedded with `text-embedding-3-small` (1536 dim) via raw SQL into the `vector(1536)` column.
   - Raw analyzer JSON is persisted to `PageAnalysis` for auditing.
5. Updates `Catalog.pageCount`, `Catalog.pageProductCount`, and `status → READY`. Partial failures (some pages failed analyzer/embedding) stay READY but surface a warning in `Catalog.error` — `0 analyzed && errors > 0` flips to `FAILED`.

### Data flow — search

`POST /api/search` receives an image in FormData and runs in parallel:

- `analyzeImageQueryProfileFromFile` → `ImageQueryProfile` (`mainProductNamePt`, `functionGroup`, `brand`, `modelCodes[]`, `visibleText[]`, `mustNotMatch[]`, …).
- `generateImageEmbeddingFromFile` → DINOv2 768-dim vector. Failure here is non-fatal; the search just falls back to semantic-only.

`searchPagesByQueryProfile`:

1. Builds `searchText` from the profile and embeds it (1536).
2. pgvector cosine over `PageProductMention.embedding` (top 200) → `rerankPageProductMentions` (commercial reranker, see below).
3. pgvector cosine over `CatalogPage.visualEmbedding` (top 60) → visual hits.
4. Groups semantic results by page. Pages that hit both signals get a hybrid score `0.75 · semanticScore + 0.25 · visualSimilarity`. Visual-only pages can be elevated to `variant + low confidence` only if at least one mention on the page has a compatible function group and doesn't violate `mustNotMatch`.
5. Filters `related_but_not_match`, `accessory`, `rejected` out of the public payload (debug callers can pass `includeAllMatches: true`).

Response: `{ profile, results: PageSearchResult[] }`. Each result has `pageImageUrl`, `matchedProductName`, `matchedBrand`, `matchedModelCodes`, `matchedFunctionGroup`, `matchType`, `confidence`, `score`, `semanticScore`, `visualSimilarity`, `matchedByVisualPage`, `reason`, `otherMatches`.

### Commercial reranker (`rerank-page-products.ts`)

Priority order (function comercial > main product > brand > color > look). Match-type ladder:

1. **`exact + high + 0.98`** — beats `mustNotMatch`. Triggered only by `explicitStrongCodeMatches`: query.modelCodes ∩ candidate.modelCodes, with both sides passing `isStrongModelCode` (normalized length ≥ 5, ≥1 letter and ≥1 digit, not in `GENERIC_CODE_DENYLIST` of USB/TYPEC/IPX5/5W/RPM/FASTCHARGE/PD/…).
2. **`mustNotMatch` reject** — hard guard, any name/category/functionGroup/etc match in `mustNotMatch` drops to `rejected`.
3. **Kit case** — candidate `isKit && kitContains` hits the query → `kit_contains`.
4. **Same function group** → `exact` (mainProduct + colors compatible + sim ≥ 0.6), else `equivalent`, else `variant`.
5. **Related function group (same head)** → `variant`, **except** when one side is "powered" (eletrico/recarregavel/automatico/digital/wireless/bluetooth) and the other is "manual" (manual/navalha/lamina/descartavel) — that becomes `related_but_not_match` with a directional reason.
6. **Else** → `related_but_not_match` (or `rejected` if sim < 0.35 and no brand/visibleText signals).

Bonuses (only nudge score, never promote across function group): `brandOk && sameFg` (+0.06), `brandOk` alone (+0.02), `visibleTextOverlap` (+0.02 per hit, capped at 4), `visibleCodeHint` (+0.2 — OCR'd code that matches a strong catalog code, but still respects mustNotMatch and functionGroup).

### Key files

| File | Role |
|---|---|
| `src/features/catalog-processing/process-catalog.ts` | Main pipeline. Render pages → save to Storage → run analyzer → generate text + visual embeddings → persist mentions. |
| `src/features/catalog-processing/page-product-analyzer.ts` | `analyzeCatalogPageProducts` + Zod schema + prompt + `normalizeKitFlag` defensive downgrade + `buildPageProductSearchText`. |
| `src/features/catalog-processing/pdf-layout-extractor.ts` | Spawns `scripts/extract_pdf_layout.py` (PyMuPDF) via `execFile` to get per-page text/image/drawing blocks. |
| `src/features/catalog-processing/render-pages.ts` | Renders PDF pages via `pdftoppm`. |
| `src/features/catalog-processing/vision-json-detector.ts` | Multimodal provider plumbing — `resolveProviderAndModel`, `callVisionProvider`, `logVisionUsage`, `prepareVisionInputImage`, `mediaTypeFromPath`, `VisionDetectorUnavailableError`, `VisionJsonParseError`. Used by both analyzers. |
| `src/features/visual-search/embeddings.ts` | DINOv2 model singleton + `generateImageEmbeddingFrom{Path,Buffer,File}` (CLS token extraction, 768 dim). |
| `src/features/visual-search/query-image-analyzer.ts` | `analyzeImageQueryProfile{,FromFile}` + prompt + `buildImageQuerySearchText`. |
| `src/features/semantic-search/text-embeddings.ts` | `generateTextEmbedding{,s}` (batched), `toPgVectorLiteral`. |
| `src/features/semantic-search/rerank-page-products.ts` | `rerankPageProductMentions` + helpers (`isStrongModelCode`, `poweredManualConflict`, `sameBrand`, …). |
| `src/features/semantic-search/page-search.ts` | `searchPagesByQueryProfile` (hybrid) + `searchCatalogPagesByVisualEmbedding`. |
| `src/components/page-search-results.tsx` | UI for `/busca` cards. |
| `src/app/api/catalogs/route.ts` | Upload PDF → `Catalog` → fire-and-forget `processCatalog`. |
| `src/app/api/catalogs/[catalogId]/reprocess/route.ts` | Wipe mentions + pages + storage, redownload PDF, re-run pipeline. |
| `src/app/api/catalogs/[catalogId]/route.ts` | GET catalog + pages; DELETE removes all storage objects (PDF + pages). |
| `src/app/api/search/route.ts` | Profile + DINOv2 in parallel → `searchPagesByQueryProfile` → `{ profile, results }`. |
| `src/lib/prisma.ts` | Prisma client singleton (instantiated at module load; scripts must run `dotenv.config()` *before* importing). |
| `src/lib/supabase.ts` | Supabase admin client + `getPublicImageUrl()` + `uploadImageToStorage()`. |
| `prisma/schema.prisma` | Models: `Supplier → Catalog → CatalogPage → PageProductMention` + `PageAnalysis` (audit). |
| `prisma.config.ts` | Prisma CLI config — uses `DIRECT_URL` env var for migrations. |
| `next.config.ts` | Marks `@xenova/transformers`, `onnxruntime-node`, `sharp` as `serverExternalPackages`; allows `*.supabase.co` image hostnames. |
| `src/instrumentation.ts` | Preloads the DINOv2 model on server startup so the first search isn't cold. |
| `scripts/extract_pdf_layout.py` | PyMuPDF extractor: per-page text/image/drawing blocks with bboxes (PDF points) → JSON. |

### Schema models

- **Supplier** → many **Catalog**.
- **Catalog** → many **CatalogPage** + many **PageProductMention** + many **PageAnalysis**. Has `pdfStoragePath` (required for reprocessing) and `pageProductCount`.
- **CatalogPage** — `imageUrl`, `width`/`height`, plus `visualEmbedding vector(768)` (full-page DINOv2, supports the visual branch of the hybrid search).
- **PageProductMention** — page-level unit of intelligence. Strong textual signals: `brand`, `modelCodes[]`, `aliases[]`. Plus `namePt`, `originalName`, `descriptionPt`, `category`, `functionGroup`, `colors[]`, `visualAttributes[]`, `technicalAttributes[]`, `notConfuseWith[]`, `commercialUse`, `isKit`, `kitContains[]`, `confidence`, `evidenceText`, `evidenceSource`, `displayOrder`, `searchText`, `embedding vector(1536)` (text-embedding-3-small), `rawJson`.
- **PageAnalysis** — one row per page processed. Stores `provider`, `model`, `rawJson`, `productsCount`, optional `error`. Auditing only — never read at search time.

### Storage layout

```
product-images/
  {catalogId}/
    original/   ← original PDF (used for reprocessing)
    pages/      ← full rendered pages (the visual result of every search)
```

### pgvector queries

Prisma does not support vector operations natively. All similarity queries use raw SQL — `text-embeddings.ts` exports `toPgVectorLiteral(vector)` so callers don't hand-format the literal:

```typescript
const vec = toPgVectorLiteral(embedding);
const rows = await prisma.$queryRaw`
  SELECT m.id, (1 - (m.embedding <=> ${vec}::vector))::float8 AS similarity
  FROM "PageProductMention" m
  WHERE m.embedding IS NOT NULL
  ORDER BY m.embedding <=> ${vec}::vector
  LIMIT 200
`;
```

ANN indexes: `ivfflat (vector_cosine_ops) WITH (lists = 100)` on both `PageProductMention.embedding` and `CatalogPage.visualEmbedding` — see migrations `20260528214800_pgvector_index_page_product_mention` and `20260529143546_add_brand_codes_aliases_and_page_visual`.

### Prisma 7 + driver adapter

Prisma 7 dropped the N-API binary engine. `src/lib/prisma.ts` uses `@prisma/adapter-pg` with a `pg.Pool`. Raw SQL for vectors still works via `$queryRaw` / `$executeRaw`. **The Pool is created at module load**, reading `process.env.DATABASE_URL` immediately, so any standalone script must run `dotenv.config()` and then *dynamically* import prisma:

```ts
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  // ...
}
```

`scripts/debug-catalog-processing.ts` and `scripts/test-page-search.ts` already follow this pattern.

### DINOv2 embedding extraction

`@xenova/transformers` ignores `pooling` options for DINOv2 and always returns the full `[1, 257, 768]` tensor. Must extract CLS token manually:

```typescript
const output = await extractor(image, { pooling: "none", normalize: false });
const clsToken = Array.from(output.data as Float32Array).slice(0, 768);
return normalizeVector(clsToken);
```

### Environment variables

```
DATABASE_URL                       # Supabase pooled connection (Prisma runtime)
DIRECT_URL                         # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL                       # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY          # required for server-side storage uploads

# Multimodal provider (shared by both analyzers)
VISION_DETECTOR_PROVIDER           # 'anthropic' | 'openai'
VISION_DETECTOR_API_KEY
VISION_DETECTOR_MAX_IMAGE_WIDTH    # default 1280
VISION_DETECTOR_JPEG_QUALITY       # default 75

# Page analyzer
VISION_DETECTOR_MODEL_CHEAP        # shared fallback for the analyzers
PAGE_ANALYZER_MODEL                # overrides MODEL_CHEAP for the page analyzer
PAGE_ANALYZER_MAX_OUTPUT_TOKENS    # default 2400

# Query image analyzer
QUERY_ANALYZER_MODEL               # overrides PAGE_ANALYZER_MODEL for the query
QUERY_ANALYZER_MAX_OUTPUT_TOKENS   # default 1200
QUERY_ANALYZER_MAX_IMAGE_WIDTH     # default 1024

# PyMuPDF
PYTHON_BIN                         # python interpreter (default 'python3')

# Text embeddings
TEXT_EMBEDDING_PROVIDER            # 'openai' (default; only one supported)
TEXT_EMBEDDING_MODEL               # default 'text-embedding-3-small'
TEXT_EMBEDDING_DIMENSIONS          # default 1536 — must match the Prisma column
TEXT_EMBEDDING_API_KEY             # optional — falls back to OPENAI_API_KEY then VISION_DETECTOR_API_KEY
```

### Pages

| Route | Purpose |
|---|---|
| `/` | Home with stats: suppliers, catalogs ready, pages processed, products detected (count of `PageProductMention`). |
| `/fornecedores` | Supplier list + create supplier. |
| `/fornecedores/[supplierId]` | Supplier detail + PDF upload + catalogs table with `pageProductCount` per row. |
| `/catalogos/[catalogId]` | Catalog detail: rendered pages with the products detected on each (visual order, brand + modelCodes, kit badge). |
| `/busca` | Search page (image upload → ranked pages with matched product + match type + confidence + reason). |

### Deploy target

Railway (Docker). `pdftoppm` must be available — Dockerfile installs `poppler-utils`. The PDF text extractor needs Python + PyMuPDF — the Dockerfile installs `python3`/`python3-pip` and `pip install PyMuPDF` (`--break-system-packages` on Debian). DINOv2 model is downloaded at runtime (first request) and preloaded at startup via `src/instrumentation.ts`.
