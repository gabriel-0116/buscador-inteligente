-- AlterTable Catalog: add pdfStoragePath
ALTER TABLE "Catalog" ADD COLUMN "pdfStoragePath" TEXT;

-- AlterTable ProductCandidate: add quality control fields
ALTER TABLE "ProductCandidate" ADD COLUMN "isSearchable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductCandidate" ADD COLUMN "qualityScore" DOUBLE PRECISION;
ALTER TABLE "ProductCandidate" ADD COLUMN "rejectReason" TEXT;
ALTER TABLE "ProductCandidate" ADD COLUMN "cardUrl" TEXT;
