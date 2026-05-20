# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # dev server (uses webpack, not turbopack)
pnpm build        # production build (also uses webpack)
pnpm lint         # eslint
pnpm format       # prettier write
pnpm format:check # prettier check

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

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma 7 · DINOv2 embeddings via `@xenova/transformers`

### Data flow

1. **Catalog upload** (`POST /api/catalogs`): receives PDF via FormData, saves it to `/tmp`, fires `processCatalog` (fire-and-forget). `processCatalog` uploads the original PDF to Supabase Storage at `{catalogId}/original/catalog.pdf` (so the catalog can be reprocessed later), renders each page with `pdftoppm -jpeg -r 180`, uploads pages to `{catalogId}/pages/page-NNN.jpg`, runs `detectProductCandidatesFromPage` per page to produce crop candidates, uploads crops to `{catalogId}/candidates/candidate-NNNN.jpg` (and optionally `card-NNNN.jpg` for the surrounding card), inserts `CatalogPage` + `ProductCandidate` rows. **Embeddings are only generated when `candidate.isSearchable && candidate.qualityScore >= 0.50`** — rejected crops are kept for debug with `embedding = NULL`. Final step sets `Catalog.status → READY`.

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

### Quality gate (what enters the search index)

The detector (`detect-product-candidates.ts`) is the *only* gate that decides whether a crop is searchable. The pipeline trusts its `isSearchable` + `qualityScore` flags — `process-catalog.ts` does not re-evaluate them, it only skips embedding generation when they fail.

Rejection reasons (`rejectReason`) currently emitted by the detector include `green_bar`, `mostly_white`, `too_horizontal`, `too_vertical`, `text_like`, `card_too_large`/`page_like_crop`, and `low_visual_mass`. Per-page caps: max 3 searchable, max 6 total (best by `qualityScore` win).

Hard constraint: a `ProductCandidate` with `isSearchable = false` must never have an embedding. The search query also enforces `isSearchable = true` server-side — do not rely on UI filtering.

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
| `src/features/catalog-processing/render-pages.ts` | Renders PDF pages via `pdftoppm` |
| `src/features/catalog-processing/detect-product-candidates.ts` | Detector + quality filters (green-bar, white-ratio, aspect-ratio, text-density, card-vs-search-crop). Returns `DetectedCandidate` with `isSearchable` + `qualityScore` + `rejectReason` |
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
  - `cardUrl` — optional larger surrounding card region (debug/reference)
  - `originalUrl` — page the crop came from
  - `embedding vector(768)` — **NULL unless `isSearchable && qualityScore >= 0.50`**
  - `isSearchable Boolean` (default `false`), `qualityScore Float?`, `rejectReason String?`
  - `confidence`, `cropX/Y/Width/Height`, `sourceType`, `detectedLabel`, `functionGroup`
- **ProductImage** — legacy, not used in search; kept to avoid data loss

### Environment variables

```
DATABASE_URL                # Supabase pooled connection (Prisma runtime)
DIRECT_URL                  # Supabase direct connection (Prisma CLI migrations)
SUPABASE_URL                # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY   # required for server-side storage uploads
```

### Pages

| Route | Purpose |
|---|---|
| `/` | Home with stats: suppliers, catalogs, pages processed, candidates indexed |
| `/fornecedores` | Supplier list + create supplier |
| `/fornecedores/[supplierId]` | Supplier detail + PDF upload |
| `/catalogos/[catalogId]` | Debug view: rendered pages + extracted candidates. Shows `isSearchable` badge, `qualityScore`, `rejectReason`, `cardUrl`, crop metadata — primary tool for tuning the detector |
| `/busca` | Search page (image upload → similarity results using cropUrl) |

### Deploy target

Railway (Docker). `pdftoppm` must be available — Dockerfile installs `poppler-utils`. DINOv2 model is downloaded at runtime (first request) and preloaded at startup via `src/instrumentation.ts`.
