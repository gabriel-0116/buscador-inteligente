-- AlterTable
ALTER TABLE "Catalog" ADD COLUMN     "filePath" TEXT,
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "mimeType" TEXT;

-- CreateIndex
CREATE INDEX "Catalog_status_idx" ON "Catalog"("status");
