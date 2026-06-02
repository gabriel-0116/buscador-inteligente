-- Part 1: strong textual signals on PageProductMention.
-- Brand, model codes (KM-7103…) and aliases drive the new reranker rules:
-- same modelCode → exact match regardless of language; brand + same
-- functionGroup gives a bonus; aliases multiply the recall of the text
-- embedding without inflating the prompt cost.

ALTER TABLE "PageProductMention" ADD COLUMN "brand" TEXT;
ALTER TABLE "PageProductMention"
  ADD COLUMN "modelCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "PageProductMention"
  ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "PageProductMention_brand_idx" ON "PageProductMention"("brand");

-- Part 4: full-page DINOv2 (768) visual embedding on CatalogPage.
-- Hybrid search: visual is a *supporting* signal — never the primary one.
ALTER TABLE "CatalogPage" ADD COLUMN "visualEmbedding" vector(768);

-- Mirror the ANN index pattern from PageProductMention.embedding so the
-- hybrid query plan can fall back to ivfflat once data exists.
CREATE INDEX IF NOT EXISTS "CatalogPage_visualEmbedding_idx"
  ON "CatalogPage"
  USING ivfflat ("visualEmbedding" vector_cosine_ops)
  WITH (lists = 100);
