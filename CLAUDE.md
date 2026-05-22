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
```

## Architecture

**Purpose:** Internal image-similarity search tool — upload supplier PDF catalogs, detect product regions, search by image.

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma 7 · DINOv2 embeddings via `@xenova/transformers` · PyMuPDF (Python) PDF-structure detector (primary) · Multimodal vision detector (Anthropic Claude or OpenAI GPT-4o) as fallback

### Data flow

1. **Catalog upload** (`POST /api/catalogs`): receives PDF via FormData, saves it to `/tmp`, fires `processCatalog` (fire-and-forget). `processCatalog` uploads the original PDF to Supabase Storage at `{catalogId}/original/catalog.pdf` (so the catalog can be reprocessed later), renders each page with `pdftoppm -jpeg -r 180`, uploads pages to `{catalogId}/pages/page-NNN.jpg`, runs `extractPdfLayout` **once** (PyMuPDF, the primary detector's input), then runs `detectProductCandidatesFromPage` per page (passing that page's layout) to produce crop candidates, uploads crops to `{catalogId}/candidates/candidate-NNNN.jpg` (and optionally `card-NNNN.jpg` for the surrounding card), inserts `CatalogPage` + `ProductCandidate` rows. **Embeddings are only generated when `candidate.isSearchable && candidate.qualityScore >= 0.60`** (matches `QUALITY_THRESHOLD`) — rejected crops are kept for debug with `embedding = NULL`. Final step sets `Catalog.status → READY`. Note the two distinct gates: embedding/indexing requires `>= 0.60`, but search (#2) re-filters at a looser `>= 0.50` floor (`MIN_QUALITY`).

2. **Visual search** (`POST /api/search`): receives image via FormData, generates a DINOv2 embedding, queries `ProductCandidate` with pgvector cosine distance, filtering on `embedding IS NOT NULL AND isSearchable = true AND qualityScore >= 0.50`. Results are sorted to prefer `PAGE_CROP` over other source types, deduped by `cropUrl` and near-identical similarity within the same catalog, capped at 20.

3. **Reprocess** (`POST /api/catalogs/[catalogId]/reprocess`): deletes old `ProductCandidate` + `CatalogPage` rows + their storage files, downloads the original PDF from `pdfStoragePath`, writes to `/tmp`, and re-runs `processCatalog`. Requires `Catalog.pdfStoragePath` to be set — catalogs uploaded before that field existed must be re-uploaded.

### Storage layout

```
product-images/
  {catalogId}/
    original/     ← original PDF (used for reprocessing)
    pages/        ← full rendered pages (source/debug)
    candidates/   ← product crops + optional `card-NNNN.jpg` per candidate
    embedded/     ← legacy pdfimages output (not used for search)
```

### Detection pipeline (cascade — PDF-structure-first, cost-aware)

`detectProductCandidatesFromPage()` orchestrates a **cascade** whose primary detector is the PDF's own structure (PyMuPDF), not an LLM. The LLM is a fallback for scanned / structureless pages. Order: **`PDF_LAYOUT → HEURISTIC → VISION_BOXES_CHEAP → VISION_BOXES_PREMIUM → FALLBACK`**.

`VISION_DETECTOR_MODE` still gates the vision tiers:

- **`off`** — never call vision; `PDF_LAYOUT → HEURISTIC` only.
- **`always`** — skip PDF_LAYOUT + heuristic, call the cheap vision model directly (legacy / pure-vision testing).
- **`auto`** (default) — full cascade below.

In **auto** mode, per page:

1. **PDF_LAYOUT (primary).** If a `pageLayout` was extracted, `runPdfLayoutDetector` crops the cards from `detectCardsFromPdfLayout()`, scores each with `evaluateCropImageQuality()`, and applies `enforceHardCardRules()`. `evaluatePdfLayoutQuality()` accepts when: the page has no product images (trusted "no products", no escalation), or ≥1 searchable card survived. If accepted → ship, **no heuristic, no vision call**. `sourceDetector = PDF_LAYOUT`.
2. **HEURISTIC.** PDF_LAYOUT rejected (had images but 0 searchable cards → likely scanned/odd) → run the whitespace-gap splitter + `enforceHardCardRules()`, score with `evaluateHeuristicQuality()` (good when `searchableCount >= estimateExpectedProductCount`, no searchable crop with aspect > 3.0 or < 0.33, avg `qualityScore` ≥ 0.80, severe rejects don't outnumber searchable). If good → ship. `sourceDetector = HEURISTIC`.
3. **VISION_BOXES_CHEAP.** Heuristic bad → call `VISION_DETECTOR_MODEL_CHEAP` (boxes-only).
4. **VISION_BOXES_PREMIUM.** `VISION_USE_PREMIUM_FALLBACK=true` AND cheap returned 0 boxes on a productful page → retry with `VISION_DETECTOR_MODEL_PREMIUM`.
5. **FALLBACK.** Vision throws (auth / network / parse) → use the heuristic candidates we already have. `sourceDetector = FALLBACK`.

**PDF_LAYOUT detector** (`pdf-layout-extractor.ts` + `pdf-layout-card-detector.ts`): `extractPdfLayout` runs `scripts/extract_pdf_layout.py` (PyMuPDF) once per catalog via `execFile` (no shell), producing per-page text/image/drawing blocks with bboxes in **PDF points**. `detectCardsFromPdfLayout` converts points → rendered pixels (`renderedWidth / pageLayout.width`), drops header/footer/tiny/thin-bar/full-page-background blocks, then **anchors on images**: only touching/overlapping images merge (one anchor per photo), and each text attaches to its *single* nearest anchor (caption below or code beside, never bridging two anchors — this is what stops a whole column from chaining into one card). Clusters are expanded slightly, then rejected if page-like / bar / column / tiny, and deduped by IoU. A page with no product image yields no cards. Extraction failure (missing Python/PyMuPDF) resolves to `null` → every page falls back to heuristic/vision.

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
- `PDF_LAYOUT` — primary; cards from the PDF's real structure (no LLM)
- `HEURISTIC` — whitespace-gap splitter, no vision call
- `VISION_BOXES_CHEAP` / `VISION_BOXES_PREMIUM` — boxes-only vision fallback
- `FALLBACK` — vision threw, falling back to heuristic
- Legacy: `VISION_JSON`, `VISION_JSON_CHEAP`, `VISION_JSON_PREMIUM` (no longer emitted; old rows still show them)

**MVP note:** new vision candidates leave `productName`, `category`, `model`, `descriptionPt`, `originalText`, `productNamePt`, `functionGroup` as `null`. The columns are kept for old rows; UI tolerates missing values.

Each page returns `stats: { decision, modelUsed, visionCallsMade, budgetRemainingBefore/After, heuristicQualityReason }`. `processCatalog` aggregates these into a per-catalog summary line (`pdfLayoutPages`/`heuristicPages`/`visionCheapPages`/`visionPremiumPages`/`fallbackPages`/`estimatedVisionCalls`). On a digital catalog most pages should resolve as `PDF_LAYOUT` — vision is the exception.

The heuristic detector (also in `detect-product-candidates.ts`) is the same legacy card-grid splitter: row-then-column whitespace gaps → score each cell as a card.

**Hard constraint:** a `ProductCandidate` with `isSearchable = false` must never have an embedding. The search query also enforces `isSearchable = true` server-side — never rely on UI filtering.

**PageAnalysis table:** the full raw vision response is persisted per page (`provider`, `model`, `rawJson`, `productsCount`, `error`) for auditing. The per-product slice is also stored on `ProductCandidate.rawVisionJson`.

**Severe rejects** (force `isSearchable = false` regardless of score): `too_small`, `too_large`, `mostly_white`, `green_bar`, `orange_bar`, `color_bar`, `horizontal_bar`, `vertical_column`, `header_footer`, `empty_cell`, `too_horizontal`, `too_vertical`, `insufficient_content`, `card_too_large`, `page_like_crop`, `invalid_box`, `duplicate`, `low_confidence`, `bad_card_boundary`, `low_boundary`, `multi_card_crop`. Non-severe (`text_like`, `no_central_object`, `low_quality`) are informational.

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
| `src/features/catalog-processing/render-pages.ts` | Renders PDF pages via `pdftoppm` |
| `src/features/catalog-processing/detect-product-candidates.ts` | Detector orchestrator: `PDF_LAYOUT → HEURISTIC → vision → FALLBACK`. Also `enforceHardCardRules` / `looksLikeMultiCardCrop`. Returns `PageDetectionResult = { candidates, pageAnalysis, stats }` |
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
- **Catalog** → many **CatalogPage** + many **ProductCandidate**. Has `pdfStoragePath` pointing at the original PDF in Supabase Storage (required for reprocessing).
- **CatalogPage** → many **ProductCandidate** (the rendered page each candidate came from)
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

# PDF_LAYOUT detector (PyMuPDF)
PYTHON_BIN                         # python interpreter for the extractor (default 'python3')
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
