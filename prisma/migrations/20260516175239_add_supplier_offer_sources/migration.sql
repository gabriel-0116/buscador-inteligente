/*
  Warnings:

  - A unique constraint covering the columns `[rawProductId]` on the table `SupplierOffer` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "SupplierOffer" ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "rawProductId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOffer_rawProductId_key" ON "SupplierOffer"("rawProductId");

-- CreateIndex
CREATE INDEX "SupplierOffer_catalogId_idx" ON "SupplierOffer"("catalogId");

-- AddForeignKey
ALTER TABLE "SupplierOffer" ADD CONSTRAINT "SupplierOffer_rawProductId_fkey" FOREIGN KEY ("rawProductId") REFERENCES "RawProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOffer" ADD CONSTRAINT "SupplierOffer_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
