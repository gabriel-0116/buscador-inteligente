-- Visual order of each PageProductMention on its page (left→right, top→bottom).
-- Set by process-catalog from the analyzer's response order. Nullable so
-- existing rows survive the migration; reprocessing fills the value in.

ALTER TABLE "PageProductMention" ADD COLUMN "displayOrder" INTEGER;

CREATE INDEX "PageProductMention_pageId_displayOrder_idx"
  ON "PageProductMention"("pageId", "displayOrder");
