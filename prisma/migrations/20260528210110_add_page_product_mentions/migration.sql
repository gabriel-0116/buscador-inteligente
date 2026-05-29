-- Page-level search strategy: see PAGE_LEVEL_SEARCH_REFACTOR.md.
-- Adds the PageProductMention table (textual/semantic embedding) and a
-- per-catalog counter. The vector column needs the pgvector extension; the
-- earlier migrations already created it, so we only declare the column.

-- AlterTable Catalog
ALTER TABLE "Catalog" ADD COLUMN "pageProductCount" INTEGER;

-- CreateTable PageProductMention
CREATE TABLE "PageProductMention" (
  "id"                  TEXT NOT NULL,
  "catalogId"           TEXT NOT NULL,
  "pageId"              TEXT NOT NULL,
  "pageNumber"          INTEGER NOT NULL,

  "namePt"              TEXT NOT NULL,
  "originalName"        TEXT,
  "descriptionPt"       TEXT,
  "category"            TEXT,
  "functionGroup"       TEXT,

  "colors"              TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "visualAttributes"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "technicalAttributes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "notConfuseWith"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "commercialUse"       TEXT,

  "isKit"               BOOLEAN NOT NULL DEFAULT false,
  "kitContains"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "confidence"          DOUBLE PRECISION,
  "evidenceText"        TEXT,
  "evidenceSource"      TEXT,

  "searchText"          TEXT NOT NULL,
  "embedding"           vector(1536),

  "rawJson"             JSONB,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PageProductMention_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "PageProductMention_catalogId_idx"     ON "PageProductMention"("catalogId");
CREATE INDEX "PageProductMention_pageId_idx"        ON "PageProductMention"("pageId");
CREATE INDEX "PageProductMention_functionGroup_idx" ON "PageProductMention"("functionGroup");
CREATE INDEX "PageProductMention_category_idx"      ON "PageProductMention"("category");
CREATE INDEX "PageProductMention_pageNumber_idx"    ON "PageProductMention"("pageNumber");

-- Foreign keys
ALTER TABLE "PageProductMention"
  ADD CONSTRAINT "PageProductMention_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageProductMention"
  ADD CONSTRAINT "PageProductMention_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "CatalogPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
