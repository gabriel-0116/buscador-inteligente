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
npx prisma migrate dev    # create + apply migration
npx prisma migrate deploy # apply migrations in production
npx prisma generate       # regenerate client after schema changes
npx prisma studio         # local DB browser
```

## Architecture

**Purpose:** Internal image-similarity search tool — upload supplier PDF catalogs, search for products by uploading a reference image.

**Stack:** Next.js 16 App Router · TypeScript · Tailwind v4 · shadcn/ui · Supabase (PostgreSQL + Storage) · Prisma · CLIP embeddings via `@xenova/transformers`

### Data flow

1. **Catalog upload** (`POST /api/catalogs`): receives PDF via FormData, saves to `/tmp`, runs `pdfimages -j` (poppler-utils) to extract embedded images, filters out images smaller than 150×150 or >92% white pixels, uploads keepers to Supabase Storage (`product-images/{catalogId}/img-NNN.jpg`), generates CLIP embeddings (512-dim), inserts `ProductImage` rows with vector, updates `Catalog.status` → `READY`. Processing runs in the background; API returns immediately with `PROCESSING` status.

2. **Visual search** (`POST /api/search`): receives image via FormData, generates CLIP embedding, queries pgvector with cosine distance (`<=>`), returns top 20 matches with `imageUrl`, `similarity`, `supplierName`, `catalogFileName`.

### pgvector queries

Prisma does not support vector operations natively. All similarity queries use raw SQL:

```typescript
const results = await prisma.$queryRaw`
  SELECT id, "imageUrl", "catalogId",
         1 - (embedding <=> ${queryVector}::vector) as similarity
  FROM "ProductImage"
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> ${queryVector}::vector
  LIMIT 20
`;
```

### Prisma 7 + driver adapter

Prisma 7 dropped the N-API binary engine — the default is now a Wasm engine that requires a driver adapter. `src/lib/prisma.ts` uses `@prisma/adapter-pg` with a `pg.Pool` to satisfy this requirement. Raw SQL for vectors still works normally through `$queryRaw` / `$executeRaw`.

### Key files

| File | Role |
|---|---|
| `src/features/visual-search/embeddings.ts` | CLIP model singleton + embedding helpers (`generateImageEmbeddingFromFile`, `generateImageEmbeddingFromBuffer`, `generateImageEmbeddingFromPath`) |
| `src/lib/prisma.ts` | Prisma client singleton (cached on `globalThis` for dev HMR) |
| `src/lib/supabase.ts` | Supabase admin client (service role) + `getPublicImageUrl()` |
| `prisma/schema.prisma` | Three models: `Supplier → Catalog → ProductImage`; `ProductImage.embedding` is `Unsupported("vector(512)")` |
| `prisma.config.ts` | Prisma CLI config — uses `DIRECT_URL` env var (not `DATABASE_URL`) for migrations |
| `next.config.ts` | Marks `@xenova/transformers`, `onnxruntime-node`, `sharp` as `serverExternalPackages`; allows `*.supabase.co` image hostnames |

### CLIP model

- Model: `Xenova/clip-vit-base-patch32` (512-dim embeddings)
- Downloaded on first use; cached at `.cache/transformers/` in project root
- Singleton `extractorPromise` prevents reloading across requests
- Vectors are L2-normalized before storage

### Environment variables

```
DATABASE_URL       # Supabase pooled connection (used by Prisma client at runtime)
DIRECT_URL         # Supabase direct connection (used by Prisma CLI for migrations)
SUPABASE_URL       # https://xxx.supabase.co
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY  # required for server-side storage uploads
```

### Pages

| Route | Purpose |
|---|---|
| `/` | Home with links to search and supplier management |
| `/fornecedores` | Supplier list + create supplier |
| `/fornecedores/[supplierId]` | Supplier detail + PDF upload |
| `/catalogos/[catalogId]` | Image grid for a catalog |
| `/busca` | Main search page (image upload → similarity results) |

### Deploy target

Railway (Docker). `pdfimages` must be available as a system binary — the Dockerfile installs `poppler-utils`. The CLIP model is downloaded at runtime (first request), not baked into the image.
