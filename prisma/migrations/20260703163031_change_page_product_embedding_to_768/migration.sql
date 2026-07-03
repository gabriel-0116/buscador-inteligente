-- Switch PageProductMention.embedding from vector(1536) (OpenAI
-- text-embedding-3-small) to vector(768) (local models like Nomic
-- Embed Text v1.5 via LM Studio). Motivated by moving indexing off the
-- paid OpenAI API to a fully local runtime.
--
-- pgvector doesn't allow ALTER between dimensions (no cast exists), so
-- the existing 1536-dim vectors are dropped. Every PageProductMention
-- keeps its metadata (name, brand, codes, colors, category, etc) — only
-- the vector is cleared. Reindex by reprocessing the affected catalogs,
-- or run a script that batch-embeds every mention's `searchText`.
--
-- The ivfflat index is dependent on the column type, so drop it first
-- and recreate it after the column type change.

DROP INDEX IF EXISTS "PageProductMention_embedding_idx";

ALTER TABLE "PageProductMention" DROP COLUMN "embedding";
ALTER TABLE "PageProductMention" ADD COLUMN "embedding" vector(768);

CREATE INDEX "PageProductMention_embedding_idx"
  ON "PageProductMention"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
