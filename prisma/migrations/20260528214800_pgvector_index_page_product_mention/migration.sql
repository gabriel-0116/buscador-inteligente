-- Cosine-distance ANN index for PageProductMention.embedding. Idempotent so
-- it's safe to keep in the migration set alongside future ones.
--
-- `lists = 100` is a reasonable default for a few tens of thousands of rows;
-- the rule of thumb is sqrt(rowcount). Re-tune (and REINDEX) once the table
-- grows past ~100k mentions. ivfflat's max input dim is 2000 — vector(1536)
-- fits fine.

CREATE INDEX IF NOT EXISTS "PageProductMention_embedding_idx"
  ON "PageProductMention"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
