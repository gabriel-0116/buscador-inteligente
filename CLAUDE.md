# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm dev          # dev server (uses webpack, not turbopack)
pnpm build        # production build
pnpm lint         # eslint
pnpm format       # prettier write
pnpm format:check # prettier check

# Prisma — uses DIRECT_URL (not DATABASE_URL) for migrations
npx prisma migrate dev    # create + apply migration (shadow DB may fail with pgvector — use migrate deploy instead)
npx prisma migrate deploy # apply migrations in production
npx prisma generate       # regenerate client after schema changes
npx prisma studio         # local DB browser

# Re-index legacy ProductImage records (not used for search anymore)
npx tsx scripts/reindex.ts
```

## Architecture

**Purpose:** Internal image-similarity search tool — upload supplier PDF catalogs, detect product regions, search by image.

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma 7 · DINOv2 embeddings via `@xenova/transformers`

### Data flow

1. **Catalog upload** (`POST /api/catalogs`): receives PDF via FormData, saves to `/tmp`, runs `pdftoppm -jpeg -r 180` to render each page as a JPEG, uploads pages to Supabase Storage (`{catalogId}/pages/page-NNN.jpg`), runs `detectProductCandidatesFromPage` on each page to generate crop candidates, uploads crops to `{catalogId}/candidates/candidate-NNNN.jpg`, generates DINOv2 embeddings (768-dim CLS token) for each crop, inserts `CatalogPage` and `ProductCandidate` rows, updates `Catalog.status → READY`. Processing runs fire-and-forget.

2. **Visual search** (`POST /api/search`): receives image via FormData, generates DINOv2 embedding, queries pgvector with cosine distance over `ProductCandidate`, returns top 20 with `cropUrl`, `originalUrl`, `similarity`, `supplierName`, `catalogFileName`.

### Storage layout

```
product-images/
  {catalogId}/
    pages/        ← full rendered pages (source/debug)
    candidates/   ← product crop regions (used for search)
    embedded/     ← legacy pdfimages output (not used for search)
```

### pgvector queries

Prisma does not support vector operations natively. All similarity queries use raw SQL:

```typescript
const results = await prisma.$queryRaw`
  SELECT pc.id, pc."cropUrl", pc."originalUrl", pc."catalogId",
         1 - (pc.embedding <=> ${queryVector}::vector) as similarity
  FROM "ProductCandidate" pc
  WHERE pc.embedding IS NOT NULL
  ORDER BY pc.embedding <=> ${queryVector}::vector
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
| `src/features/catalog-processing/detect-product-candidates.ts` | Heuristic crop detector using sharp pixel analysis |
| `src/features/catalog-processing/process-catalog.ts` | Main pipeline: render → detect → upload → embed |
| `src/features/catalog-processing/function-groups.ts` | Static product function group labels (prepared for future classification) |
| `src/features/visual-search/embeddings.ts` | DINOv2 model singleton + embedding helpers |
| `src/features/visual-search/search.ts` | pgvector search over `ProductCandidate` |
| `src/lib/prisma.ts` | Prisma client singleton (cached on `globalThis` for dev HMR) |
| `src/lib/supabase.ts` | Supabase admin client + `getPublicImageUrl()` + `uploadImageToStorage()` |
| `prisma/schema.prisma` | Models: `Supplier → Catalog → CatalogPage → ProductCandidate`; `ProductImage` kept as legacy |
| `prisma.config.ts` | Prisma CLI config — uses `DIRECT_URL` env var for migrations |
| `next.config.ts` | Marks `@xenova/transformers`, `onnxruntime-node`, `sharp` as `serverExternalPackages`; allows `*.supabase.co` image hostnames |

### Schema models

- **Supplier** → many **Catalog**
- **Catalog** → many **CatalogPage** (full rendered pages) + many **ProductCandidate** (indexed crops)
- **CatalogPage** → many **ProductCandidate**
- **ProductCandidate** — has `cropUrl` (cropped image), `originalUrl` (page it came from), `embedding vector(768)`, `confidence`, `cropX/Y/Width/Height` metadata, `detectedLabel`, `functionGroup` (prepared for future classification)
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
| `/catalogos/[catalogId]` | Debug view: rendered pages + extracted candidates with crop metadata |
| `/busca` | Search page (image upload → similarity results using cropUrl) |

### Deploy target

Railway (Docker). `pdftoppm` must be available — Dockerfile installs `poppler-utils`. DINOv2 model is downloaded at runtime (first request) and preloaded at startup via `src/instrumentation.ts`.
