# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # dev server (uses webpack, not turbopack)
pnpm build        # production build (also uses webpack)
pnpm lint         # eslint
pnpm format       # prettier write
pnpm format:check # prettier check

# Python — required by the primary PDF_LAYOUT detector (PyMuPDF)
pip install -r scripts/requirements.txt   # or: pip install PyMuPDF
# Node spawns `python3` (override with PYTHON_BIN); must be able to `import fitz`

# Prisma — uses DIRECT_URL (not DATABASE_URL) for migrations
npx prisma migrate dev    # create + apply migration (shadow DB may fail with pgvector — use migrate deploy instead)
npx prisma migrate deploy # apply migrations in production
npx prisma generate       # regenerate client after schema changes
npx prisma studio         # local DB browser

# Debug scripts
npx tsx scripts/reindex.ts        # re-index legacy ProductImage records (not used for search anymore)
npx tsx scripts/test-detector.ts  # exercise the candidate detector on a local page image
# Validate the structural cascade page-by-page on a real PDF — no DB, no Supabase, no cost.
# Prints `page  type  decision  searchable/total  flags`. Vision off by default (TEST_VISION=1 to include it).
npx tsx scripts/test-eletromex.ts <catalog.pdf> [page page ...]
```

## Architecture

**Purpose:** Internal product-search tool — upload supplier PDF catalogs, search by image, get back the **catalog pages** containing the queried product. The page is the visual result; the product detected on the page is the unit of intelligence (function group > main product > color > look). See `PAGE_LEVEL_SEARCH_REFACTOR.md` for the full rationale.

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma 7 · PyMuPDF (Python) for PDF text/layout · OpenAI / Anthropic multimodal models for the page analyzer + image query profile · OpenAI text-embedding-3-small (1536 dim) for semantic search · DINOv2 (`@xenova/transformers`, 768 dim) for the legacy visual-crop path.

### Two processing modes

| Mode | `CATALOG_PROCESSING_MODE` | `SEARCH_MODE` | What it does |
|---|---|---|---|
| **Page mentions** (default) | `page_mentions` | `page_mentions` | Renders pages → analyzer extracts `PageProductMention` rows (no crops) → searchText → text embedding (1536). Search analyzes the query image to a structured `ImageQueryProfile`, pgvector-searches mentions, reranks commercially, returns *pages*. |
| **Legacy crops** | `legacy_crops` | `legacy_candidates` | The original cascade (`GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → VISION → FALLBACK`) writes `ProductCandidate` rows with DINOv2 visual embeddings. Crop-based search. Kept for compatibility — not the direction. |

### Data flow — page_mentions (default)

1. **Catalog upload** (`POST /api/catalogs`): receives PDF, saves it to `/tmp`, fires `processCatalog` (fire-and-forget). `processCatalog` uploads the original PDF to Supabase Storage at `{catalogId}/original/catalog.pdf`, renders each page with `pdftoppm -jpeg -r 180`, uploads pages to `{catalogId}/pages/page-NNN.jpg`, runs `extractPdfLayout` once (PyMuPDF text/blocks as evidence). For each page it calls `analyzeCatalogPageProducts` (multimodal — boxes-free; the model lists the products visible on the page with `namePt`, `functionGroup`, `colors`, `notConfuseWith`, `isKit`, etc.). Each product becomes a `PageProductMention`. A consolidated `searchText` is built per mention and embedded with `text-embedding-3-small` (1536 dim) — written via raw SQL into the `vector(1536)` column. Final step sets `Catalog.status → READY` and updates `pageProductCount`.

2. **Visual search** (`POST /api/search`): receives image via FormData, normalizes/EXIF-rotates via sharp, calls `analyzeImageQueryProfile` → `ImageQueryProfile` (mainProductNamePt, functionGroup, mustNotMatch, …), builds `searchText`, embeds, runs `searchPagesByQueryProfile`: pgvector top-N over `PageProductMention.embedding`, then `rerankPageProductMentions` applies commercial rules (functionGroup first → main product → color → look; `mustNotMatch` triggers rejection), then groups by page keeping the top match per page. Response shape: `{ mode, profile, results: PageSearchResult[] }` where each result has `pageImageUrl`, `matchedProductName`, `matchType`, `confidence`, `reason`, `otherMatches`.

3. **Reprocess** (`POST /api/catalogs/[catalogId]/reprocess`): deletes old rows + storage files, downloads the original PDF from `pdfStoragePath`, re-runs `processCatalog`. Requires `Catalog.pdfStoragePath`.

### Data flow — legacy_crops (preserved)

Set `CATALOG_PROCESSING_MODE=legacy_crops` and `SEARCH_MODE=legacy_candidates` to use the original cascade detector. Same upload entrypoint; falls through `detectProductCandidatesFromPage` (`PAGE_CLASSIFIER → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → VISION → FALLBACK`), writes `ProductCandidate` rows with DINOv2 (`vector(768)`) embeddings. Search: DINOv2 query embedding → cosine over `ProductCandidate`, filter `isSearchable && qualityScore >= 0.50`, prefer `PAGE_CROP`, dedupe.

### Storage layout

```
product-images/
  {catalogId}/
    original/     ← original PDF (used for reprocessing)
    pages/        ← full rendered pages — the visual result of page_mentions search
    candidates/   ← legacy_crops only: product crops + optional `card-NNNN.jpg`
    embedded/     ← legacy pdfimages output (not used for search)
```

### Page-level modules (page_mentions)

| File | Role |
|---|---|
| `src/features/catalog-processing/page-product-analyzer.ts` | `analyzeCatalogPageProducts` — multimodal page analyzer (no boxes). Reuses `VISION_DETECTOR_PROVIDER`/`API_KEY`; model from `PAGE_ANALYZER_MODEL`. Output: `PageProductAnalysis` (Zod-validated). Also exports `buildPageProductSearchText` for the embedding input. |
| `src/features/semantic-search/text-embeddings.ts` | `generateTextEmbedding` / `generateTextEmbeddings` (batched). Uses `TEXT_EMBEDDING_*` envs. Always normalizes the vector and returns `TEXT_EMBEDDING_DIMENSIONS` floats (default 1536). |
| `src/features/visual-search/query-image-analyzer.ts` | `analyzeImageQueryProfile{,FromFile}` — image → `ImageQueryProfile` (mainProductNamePt, functionGroup, mustNotMatch, …). Also exports `buildImageQuerySearchText`. |
| `src/features/semantic-search/rerank-page-products.ts` | `rerankPageProductMentions` — commercial reranker: functionGroup > main product > color > look; mustNotMatch is a hard reject. Returns `matchType` + `confidence` + `score` + `reason`. |
| `src/features/semantic-search/page-search.ts` | `searchPagesByQueryProfile` — pgvector top-N over `PageProductMention.embedding`, rerank, group by page → `PageSearchResult[]`. |
| `src/components/page-search-results.tsx` | UI for `/busca` when `mode=page_mentions`. |
| `scripts/test-page-analyzer.ts` | CLI: run analyzer on chosen pages of a PDF, no DB. |
| `scripts/test-page-search.ts` | CLI: end-to-end search (image → profile → DB → ranked pages). |

### Detection pipeline (cascade — PDF-structure-first, cost-aware)

`detectProductCandidatesFromPage()` orchestrates a **cascade** whose primary detectors read the PDF's own structure (PyMuPDF), not an LLM. The LLM is a fallback for scanned / structureless pages. Order: **`PAGE_CLASSIFIER → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → VISION_BOXES_CHEAP → VISION_BOXES_PREMIUM → FALLBACK`**.

The decisive guard against the "one crop = several products" failure (which poisons embeddings) is **per-crop signal validation**: count the per-product markers (`R$` prices, `PCS/CX`, `Unid.CX`, product codes) that fall *inside* a crop. ≥2 ⇒ `multi_card_crop` ⇒ never searchable. See `product-signals.ts` / `validateSingleProductCrop`.

`VISION_DETECTOR_MODE` still gates the vision tiers:

- **`off`** — never call vision; `classifier → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC` only.
- **`always`** — skip classifier + structural + heuristic, call the cheap vision model directly (legacy / pure-vision testing).
- **`auto`** (default) — full cascade below.

In **auto** mode, per page:

0. **PAGE_CLASSIFIER** (`classifyCatalogPage`). From page text + layout (never color): `cover` / `summary` / `category_grid` / `partial_grid` / `single_product` / `non_product` / `unknown`. A `cover`/`summary`/`non_product` page returns **0 searchable, no vision** (`decision = PAGE_SKIP`).
1. **GRID_LAYOUT (primary)** (`grid-layout-detector.ts`). For `category_grid` / `partial_grid`: cluster the positions of signal-bearing text blocks into rows/columns, build one box per gridline cell that contains a product signal, **clamp each box to its cell** (so it can't span neighbours). Crop → `validateSingleProductCrop` → `enforceHardCardRules`. `evaluateStructuralQuality` accepts when searchable ≥ ~60% of the page's expected product count. `sourceDetector = GRID_LAYOUT`.
2. **PDF_LAYOUT** (`pdf-layout-card-detector.ts`). Image-anchored cards (see below), each validated; a crop that validates as `multi_card_crop` is handed to `splitCompositeProductBox` (signal-position split into 2×1/1×2/2×2/3×3/…); if ≥2 sub-cards validate, they replace the composite, else it's kept as non-searchable debug. Same `evaluateStructuralQuality` gate. `sourceDetector = PDF_LAYOUT`.
3. **HEURISTIC.** Structural tiers rejected (likely scanned/odd) → whitespace-gap splitter + `enforceHardCardRules`, gated by `evaluateHeuristicQuality`. `sourceDetector = HEURISTIC`.
4. **VISION_BOXES_CHEAP / PREMIUM.** Heuristic bad → `VISION_DETECTOR_MODEL_CHEAP` (boxes-only); premium retry only if `VISION_USE_PREMIUM_FALLBACK=true` and cheap returned 0 boxes on a productful page.
5. **FALLBACK.** Vision throws → use the heuristic candidates we already have. `sourceDetector = FALLBACK`.

**Structural extraction** (`pdf-layout-extractor.ts`): `extractPdfLayout` runs `scripts/extract_pdf_layout.py` (PyMuPDF) once per catalog via `execFile` (no shell), producing per-page text/image/drawing blocks with bboxes in **PDF points**; failure (missing Python/PyMuPDF) resolves to `null` → heuristic/vision only.

**PDF_LAYOUT card detector** (`pdf-layout-card-detector.ts`): converts points → rendered pixels (`renderedWidth / pageLayout.width`), drops header/footer/tiny/thin-bar/full-page-background blocks, then **anchors on images**: only touching/overlapping images merge (one anchor per photo), and each text attaches to its *single* nearest anchor (caption below or code beside, never bridging two anchors — stops a whole column from chaining into one card). Clusters are expanded slightly, rejected if page-like / bar / column / tiny, deduped by IoU.

**Debug:** `CATALOG_DEBUG_PAGES="3,4,5,…"` logs page type, signals and rendered size per listed page. Per-page logs: `[page-classifier]`, `[grid-layout]`, `[pdf-layout]`, `[pdf-layout-split]`.

**Per-catalog budget**: `CATALOG_MAX_VISION_PAGES` (default 20) caps the number of vision calls per catalog. When the budget hits 0, remaining bad-heuristic pages serve heuristic candidates anyway and log `BUDGET_EXCEEDED`. This is the hard guardrail against the "$5 per PDF" failure mode.

**Vision response handling (boxes-only MVP):**
- **Downscale before send** (`prepareVisionInputImage`): page is re-encoded as JPEG at `VISION_DETECTOR_MAX_IMAGE_WIDTH` (default 1280) and `VISION_DETECTOR_JPEG_QUALITY` (default 75). The temp file is sent to the model and deleted right after. The original full-resolution page is what's actually cropped.
- **Boxes-only prompt** (`buildBoxesPrompt`): the model is asked for `{ pageNumber, boxes: [{x, y, width, height, confidence}] }` and nothing else — no productName, no category, no description, no translation. `max_tokens` capped by `VISION_DETECTOR_MAX_OUTPUT_TOKENS` (default 800).
- **Parser** (`parseVisionBoxesResponse`): accepts the new boxes-only shape AND falls back to the legacy `products[].box` shape so a stale model response doesn't break a page.
- **Scale boxes back** to original page coordinates using `scaleX`/`scaleY` from `prepareVisionInputImage`.
- **Validate boxes** (`vision-box-validator.ts`): clamp to page bounds, reject `too_small`/`too_large`/`header_footer`/`horizontal_bar`/`vertical_column`, then `dedupeBoxesByIoU(0.65)`.
- **Refine boxes** (`vision-box-refinement.ts → refineVisionBoxToCard`): conservative snap. Expand a 12% margin, snap edges to the nearest whitespace gap starting from the box center. Hard limits: each edge can shift at most 15% of the original dimension; refined area must stay between 70% and 140% of the original — otherwise keep the original.
- **Re-dedupe** post-refinement (`dedupeRefinedByIoU`, threshold 0.55): two model boxes can snap to the same card; keep the best by `visionConfidence × boundaryScore × qualityScore`.
- **Local quality + boundary** per crop via `evaluateCropImageQuality()` and `evaluateBoxBoundary()`. Boundary score detects bleed: penalizes non-white edges and detects "two cards stacked" via a deep mid-row gap with dense content above and below.
- `isSearchable = true` requires `qualityScore >= 0.60 && boundaryScore >= 0.60 && visionConfidence >= 0.45 && no severe rejectReason`. Failures yield `bad_card_boundary` or `low_boundary` (both severe).
- **Token usage** is logged per call: `[vision-tokens] page N provider=… model=… input=… output=… total=…`.
- A successful "0 boxes" response is trusted (cover pages have no products) — unless premium fallback kicks in.

`sourceDetector` taxonomy:
- `GRID_LAYOUT` — primary; product cells inferred from signal positions (no LLM)
- `PDF_LAYOUT` — image-anchored cards from the PDF's structure (validated; no LLM)
- `HEURISTIC` — whitespace-gap splitter, no vision call
- `VISION_BOXES_CHEAP` / `VISION_BOXES_PREMIUM` — boxes-only vision fallback
- `FALLBACK` — vision threw, falling back to heuristic
- Legacy: `VISION_JSON`, `VISION_JSON_CHEAP`, `VISION_JSON_PREMIUM` (no longer emitted; old rows still show them)

**MVP note:** new vision candidates leave `productName`, `category`, `model`, `descriptionPt`, `originalText`, `productNamePt`, `functionGroup` as `null`. The columns are kept for old rows; UI tolerates missing values.

Each page returns `stats: { decision, modelUsed, visionCallsMade, budgetRemainingBefore/After, heuristicQualityReason }`. `processCatalog` aggregates these into a per-catalog summary line (`gridLayoutPages`/`pdfLayoutPages`/`pageSkipPages`/`heuristicPages`/`visionCheapPages`/`visionPremiumPages`/`fallbackPages`/`estimatedVisionCalls`). On a digital catalog most pages should resolve as `GRID_LAYOUT`/`PDF_LAYOUT` — vision is the exception.

The heuristic detector (also in `detect-product-candidates.ts`) is the same legacy card-grid splitter: row-then-column whitespace gaps → score each cell as a card.

**Hard constraint:** a `ProductCandidate` with `isSearchable = false` must never have an embedding. The search query also enforces `isSearchable = true` server-side — never rely on UI filtering.

**PageAnalysis table:** the full raw vision response is persisted per page (`provider`, `model`, `rawJson`, `productsCount`, `error`) for auditing. The per-product slice is also stored on `ProductCandidate.rawVisionJson`.

**Severe rejects** (force `isSearchable = false` regardless of score): `too_small`, `too_large`, `mostly_white`, `green_bar`, `orange_bar`, `color_bar`, `horizontal_bar`, `vertical_column`, `header_footer`, `empty_cell`, `too_horizontal`, `too_vertical`, `insufficient_content`, `card_too_large`, `page_like_crop`, `invalid_box`, `duplicate`, `low_confidence`, `bad_card_boundary`, `low_boundary`, `multi_card_crop`, `non_product_page`, `no_product_signal`, `grid_detection_failed`. Non-severe (`text_like`, `no_central_object`, `low_quality`) are informational.

**Hard card rules** (`enforceHardCardRules`, applied to both heuristic and PDF_LAYOUT crops): a searchable crop may not be ≥ `750×1000` px (`too_large`), cover > 35% of the page area (`card_too_large`), have aspect > 3.2 (`horizontal_bar`), or trip `looksLikeMultiCardCrop` (`multi_card_crop`). `looksLikeMultiCardCrop` flags a crop ~3× taller than wide, or one with ≥2 stacked content bands separated by deep whitespace gaps — i.e. a column / grid-slab rather than one product.

**Sizing (heuristic path):** `MIN_CARD_PX_ORIG = 220` is checked in **original** PDF-page pixels, not in the downscaled analysis space (`ANALYSIS_WIDTH = 800`). Vision-path sizes are checked in original page coordinates by the box validator.

**Per-page caps (heuristic path):** `MAX_SEARCHABLE_PER_PAGE = 12`, `MAX_TOTAL_PER_PAGE = 18`. Vision-path candidates aren't artificially capped — the model decides how many products fit on a page.

### pgvector queries

Prisma does not support vector operations natively. All similarity queries use raw SQL:

```typescript
const vectorStr = `[${embedding.join(",")}]`;
const results = await prisma.$queryRaw`
  SELECT pc.id, pc."cropUrl", pc."originalUrl", pc."catalogId",
         (1 - (pc.embedding <=> ${vectorStr}::vector))::float8 AS similarity
  FROM "ProductCandidate" pc
  WHERE pc.embedding IS NOT NULL
    AND pc."isSearchable" = true
    AND pc."qualityScore" >= 0.50
  ORDER BY pc.embedding <=> ${vectorStr}::vector
  LIMIT 100
`;
```

### Prisma 7 + driver adapter

Prisma 7 dropped the N-API binary engine. `src/lib/prisma.ts` uses `@prisma/adapter-pg` with a `pg.Pool`. Raw SQL for vectors still works via `$queryRaw` / `$executeRaw`.

### DINOv2 embedding extraction

`@xenova/transformers` ignores `pooling` options for DINOv2 and always returns the full `[1, 257, 768]` tensor. Must extract CLS token manually:

```typescript
const output = await extractor(image, { pooling: "none", normalize: false });
const clsToken = Array.from(output.data as Float32Array).slice(0, 768);
return normalizeVector(clsToken);
```

### Key files

| File | Role |
|---|---|
| `scripts/extract_pdf_layout.py` | PyMuPDF extractor: per-page text/image/drawing blocks with bboxes (PDF points) → JSON. Run via `python scripts/extract_pdf_layout.py in.pdf out.json` |
| `src/features/catalog-processing/pdf-layout-extractor.ts` | `extractPdfLayout({pdfPath, outputDir})` — spawns the Python script (`execFile`, no shell), Zod-validates the JSON, returns `PdfLayoutDocument \| null` (graceful on failure). `PYTHON_BIN` selects the interpreter |
| `src/features/catalog-processing/pdf-layout-card-detector.ts` | `detectCardsFromPdfLayout` — points→pixels, image-anchored clustering (text attaches to nearest photo), reject/dedupe → `PDF_LAYOUT` card boxes |
| `src/features/catalog-processing/product-signals.ts` | `extractProductSignals` — codes / `R$` / `PCS-CX` / `Unid.CX` / bullets / category-words. `looksMultiProduct`, `estimateProductCount` (price/PCS-CX are the reliable per-product counters; codes are weak) |
| `src/features/catalog-processing/page-type-classifier.ts` | `classifyCatalogPage` — cover/summary/category_grid/partial_grid/single_product/non_product/unknown from text+layout |
| `src/features/catalog-processing/grid-layout-detector.ts` | `detectGridProductBoxes` — primary; cell boxes from signal-position row/column clustering, clamped per cell. Also `collectTextInPixelBox` |
| `src/features/catalog-processing/composite-card-splitter.ts` | `splitCompositeProductBox` — split a multi-product box by interior signal positions |
| `src/features/catalog-processing/render-pages.ts` | Renders PDF pages via `pdftoppm` |
| `src/features/catalog-processing/detect-product-candidates.ts` | Detector orchestrator: `PAGE_CLASSIFIER → GRID_LAYOUT → PDF_LAYOUT → HEURISTIC → vision → FALLBACK`. Also `validateSingleProductCrop`, `enforceHardCardRules` / `looksLikeMultiCardCrop`. Returns `PageDetectionResult = { candidates, pageAnalysis, stats }` |
| `src/features/catalog-processing/vision-json-detector.ts` | Multimodal vision detector. `detectProductBoxesWithVision` (MVP) + `prepareVisionInputImage` (downscale) + provider helpers (anthropic/openai). `detectProductsJsonWithVision` kept @deprecated for compat. Throws `VisionDetectorUnavailableError` when env is missing |
| `src/features/catalog-processing/product-json-schema.ts` | Zod schemas — `PageBoxesSchema` (current) + `PageAnalysisSchema` (legacy rich), and `parseVisionBoxesResponse` which accepts either shape |
| `src/features/catalog-processing/vision-box-validator.ts` | Clamp boxes (handles normalized 0-1 coords), filter geometric outliers, `dedupeBoxesByIoU(0.65)` |
| `src/features/catalog-processing/vision-box-refinement.ts` | `refineVisionBoxToCard` (snap model box to whitespace gaps), `evaluateBoxBoundary` (detect contamination from neighbor cards), `dedupeRefinedByIoU` |
| `src/features/catalog-processing/process-catalog.ts` | Main pipeline: save PDF to storage → render → detect → upload crops → conditionally embed |
| `src/features/catalog-processing/function-groups.ts` | Static product function group labels (prepared for future classification) |
| `src/features/visual-search/embeddings.ts` | DINOv2 model singleton + embedding helpers |
| `src/features/visual-search/search.ts` | pgvector search; filters `isSearchable + qualityScore`, prefers PAGE_CROP, dedupes |
| `src/app/api/catalogs/route.ts` | Upload PDF, create `Catalog`, fire-and-forget `processCatalog` |
| `src/app/api/catalogs/[catalogId]/reprocess/route.ts` | Wipe candidates+pages+storage, redownload PDF, re-run pipeline |
| `src/lib/prisma.ts` | Prisma client singleton (cached on `globalThis` for dev HMR) |
| `src/lib/supabase.ts` | Supabase admin client + `getPublicImageUrl()` + `uploadImageToStorage()` |
| `prisma/schema.prisma` | Models: `Supplier → Catalog → CatalogPage → ProductCandidate`; `ProductImage` kept as legacy |
| `prisma.config.ts` | Prisma CLI config — uses `DIRECT_URL` env var for migrations |
| `next.config.ts` | Marks `@xenova/transformers`, `onnxruntime-node`, `sharp` as `serverExternalPackages`; allows `*.supabase.co` image hostnames |
| `src/instrumentation.ts` | Preloads the DINOv2 model on server startup so the first search isn't cold |

### Schema models

- **Supplier** → many **Catalog**
- **Catalog** → many **CatalogPage** + many **ProductCandidate** + many **PageProductMention**. Has `pdfStoragePath` and `pageProductCount` (page_mentions counter).
- **CatalogPage** → many **ProductCandidate** (legacy) + many **PageProductMention** (current). Same rendered page is used as the visual result for the new search.
- **PageProductMention** — page-level unit of intelligence. Fields: `namePt`, `originalName`, `descriptionPt`, `category`, `functionGroup`, `colors[]`, `visualAttributes[]`, `technicalAttributes[]`, `notConfuseWith[]`, `commercialUse`, `isKit`, `kitContains[]`, `confidence`, `evidenceText`, `evidenceSource` ("vision"|"pdf_text"|"both"|"manual"), `searchText`, `embedding vector(1536)`, `rawJson`. The embedding is text/semantic — independent from the DINOv2 visual embedding on ProductCandidate.
- **ProductCandidate** — searchable image crop. Key fields:
  - `cropUrl` — image used for search/results (and for embedding when `isSearchable`)
  - `cardUrl` — surrounding card region (defaults to `cropUrl` in the MVP / vision path)
  - `originalUrl` — page the crop came from
  - `embedding vector(768)` — **NULL unless `isSearchable && qualityScore >= 0.60`**
  - `isSearchable Boolean` (default `false`), `qualityScore Float?`, `rejectReason String?`
  - `confidence`, `cropX/Y/Width/Height`, `sourceType`, `detectedLabel`, `functionGroup`
  - **Vision metadata:** `productName`, `productNamePt`, `category`, `model`, `originalText`, `descriptionPt`, `sourceDetector` (`HEURISTIC` / `VISION_JSON_CHEAP` / `VISION_JSON_PREMIUM` / `FALLBACK` — legacy `VISION_JSON` may still appear in old rows), `visionConfidence`, `rawVisionJson`
- **PageAnalysis** — one row per page processed. Stores `provider`, `model`, `rawJson` (full vision response), `productsCount`, optional `error`. Used for auditing — not consulted at search time.
- **ProductImage** — legacy, not used in search; kept to avoid data loss

### Environment variables

```
DATABASE_URL                  # Supabase pooled connection (Prisma runtime)
DIRECT_URL                    # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL                  # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY     # required for server-side storage uploads

# Vision detector (cascade pipeline — optional)
VISION_DETECTOR_PROVIDER      # 'anthropic' | 'openai'
VISION_DETECTOR_API_KEY       # provider API key
VISION_DETECTOR_MODE          # 'auto' (default) | 'always' | 'off'
VISION_DETECTOR_MODEL_CHEAP   # cheap model — primary vision model in cascade
VISION_DETECTOR_MODEL_PREMIUM # premium model — only used when fallback is on
VISION_USE_PREMIUM_FALLBACK   # 'true' | 'false' (default false)
CATALOG_MAX_VISION_PAGES      # per-catalog vision-call cap (default 20)

# Legacy single-model var — still honored as fallback for *_CHEAP if set
VISION_DETECTOR_MODEL

# Cost knobs for the boxes-only detector
VISION_DETECTOR_MAX_IMAGE_WIDTH    # default 1280
VISION_DETECTOR_JPEG_QUALITY       # default 75
VISION_DETECTOR_MAX_OUTPUT_TOKENS  # default 800

# Structural detector (PyMuPDF)
PYTHON_BIN                         # python interpreter for the extractor (default 'python3')
CATALOG_DEBUG_PAGES                # e.g. "3,4,5" — verbose per-page detector logs

# Page-level strategy (page_mentions)
CATALOG_PROCESSING_MODE            # 'page_mentions' (default) | 'legacy_crops'
SEARCH_MODE                        # 'page_mentions' (default) | 'legacy_candidates'
PAGE_ANALYZER_MODEL                # multimodal model for the page analyzer
PAGE_ANALYZER_MAX_OUTPUT_TOKENS    # default 2400
QUERY_ANALYZER_MODEL               # multimodal model for the query image
QUERY_ANALYZER_MAX_OUTPUT_TOKENS   # default 1200
QUERY_ANALYZER_MAX_IMAGE_WIDTH     # default 1024
TEXT_EMBEDDING_PROVIDER            # 'openai' (default)
TEXT_EMBEDDING_MODEL               # default 'text-embedding-3-small'
TEXT_EMBEDDING_DIMENSIONS          # default 1536 — must match the Prisma column
TEXT_EMBEDDING_API_KEY             # optional — falls back to OPENAI_API_KEY then VISION_DETECTOR_API_KEY
```

**Recommended config for cheap testing:**

```
VISION_DETECTOR_PROVIDER=openai
VISION_DETECTOR_MODE=auto
VISION_DETECTOR_MODEL_CHEAP=gpt-5.4-mini
VISION_DETECTOR_MODEL_PREMIUM=gpt-5.5
VISION_USE_PREMIUM_FALLBACK=false
CATALOG_MAX_VISION_PAGES=20
```

Notes:
- For cheap testing across many catalogs, use `auto` + cheap-only (premium fallback off).
- To boost quality on a few troublesome pages, enable premium fallback. **Never** combine premium fallback with `MODE=always` over a full catalog — that's how you get a $5 PDF.
- `CATALOG_MAX_VISION_PAGES=0` effectively disables vision; equivalent to `MODE=off` but logged differently (`BUDGET_EXCEEDED` vs `VISION_OFF`).

### Pages

| Route | Purpose |
|---|---|
| `/` | Home with stats: suppliers, catalogs, pages processed, candidates indexed |
| `/fornecedores` | Supplier list + create supplier |
| `/fornecedores/[supplierId]` | Supplier detail + PDF upload |
| `/catalogos/[catalogId]` | Debug view: rendered pages + extracted candidates. Shows `isSearchable` badge, `qualityScore`, `rejectReason`, `cardUrl`, crop metadata — primary tool for tuning the detector |
| `/busca` | Search page (image upload → similarity results using cropUrl) |

### Deploy target

Railway (Docker). `pdftoppm` must be available — Dockerfile installs `poppler-utils`. The PDF_LAYOUT detector needs Python + PyMuPDF — the Dockerfile installs `python3`/`python3-pip` and `pip install PyMuPDF` (`--break-system-packages` on Debian). DINOv2 model is downloaded at runtime (first request) and preloaded at startup via `src/instrumentation.ts`.
