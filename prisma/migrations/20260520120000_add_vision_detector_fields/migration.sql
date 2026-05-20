-- Add vision-detector metadata columns to ProductCandidate
ALTER TABLE "ProductCandidate" ADD COLUMN "productName" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "productNamePt" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "category" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "model" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "originalText" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "descriptionPt" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "sourceDetector" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "visionConfidence" DOUBLE PRECISION;
ALTER TABLE "ProductCandidate" ADD COLUMN "rawVisionJson" JSONB;

CREATE INDEX "ProductCandidate_sourceDetector_idx" ON "ProductCandidate"("sourceDetector");

-- New table to store the raw multimodal analysis per page (for auditing / retries)
CREATE TABLE "PageAnalysis" (
  "id" TEXT NOT NULL,
  "catalogId" TEXT NOT NULL,
  "pageId" TEXT NOT NULL,
  "pageNumber" INTEGER NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "rawJson" JSONB NOT NULL,
  "productsCount" INTEGER NOT NULL,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PageAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PageAnalysis_catalogId_idx" ON "PageAnalysis"("catalogId");
CREATE INDEX "PageAnalysis_pageId_idx" ON "PageAnalysis"("pageId");

ALTER TABLE "PageAnalysis"
  ADD CONSTRAINT "PageAnalysis_catalogId_fkey"
  FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PageAnalysis"
  ADD CONSTRAINT "PageAnalysis_pageId_fkey"
  FOREIGN KEY ("pageId") REFERENCES "CatalogPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
