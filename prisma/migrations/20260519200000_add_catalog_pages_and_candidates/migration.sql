-- CreateEnum
CREATE TYPE "CandidateSourceType" AS ENUM ('PAGE_CROP', 'EMBEDDED_IMAGE', 'MANUAL');

-- AlterTable Catalog: add candidateCount
ALTER TABLE "Catalog" ADD COLUMN "candidateCount" INTEGER;

-- CreateTable CatalogPage
CREATE TABLE "CatalogPage" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CatalogPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable ProductCandidate
CREATE TABLE "ProductCandidate" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "pageId" TEXT,
    "originalUrl" TEXT NOT NULL,
    "cropUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "fileSize" INTEGER,
    "sourceType" "CandidateSourceType" NOT NULL DEFAULT 'PAGE_CROP',
    "cropX" INTEGER,
    "cropY" INTEGER,
    "cropWidth" INTEGER,
    "cropHeight" INTEGER,
    "detectedLabel" TEXT,
    "functionGroup" TEXT,
    "confidence" DOUBLE PRECISION,
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex CatalogPage
CREATE INDEX "CatalogPage_catalogId_idx" ON "CatalogPage"("catalogId");
CREATE UNIQUE INDEX "CatalogPage_catalogId_pageNumber_key" ON "CatalogPage"("catalogId", "pageNumber");

-- CreateIndex ProductCandidate
CREATE INDEX "ProductCandidate_catalogId_idx" ON "ProductCandidate"("catalogId");
CREATE INDEX "ProductCandidate_pageId_idx" ON "ProductCandidate"("pageId");
CREATE INDEX "ProductCandidate_functionGroup_idx" ON "ProductCandidate"("functionGroup");

-- AddForeignKey CatalogPage → Catalog
ALTER TABLE "CatalogPage" ADD CONSTRAINT "CatalogPage_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey ProductCandidate → Catalog
ALTER TABLE "ProductCandidate" ADD CONSTRAINT "ProductCandidate_catalogId_fkey"
    FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey ProductCandidate → CatalogPage
ALTER TABLE "ProductCandidate" ADD CONSTRAINT "ProductCandidate_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "CatalogPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
