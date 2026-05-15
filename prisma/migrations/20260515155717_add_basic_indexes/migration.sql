/*
  Warnings:

  - A unique constraint covering the columns `[name]` on the table `Supplier` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE INDEX "Catalog_supplierId_idx" ON "Catalog"("supplierId");

-- CreateIndex
CREATE INDEX "CatalogPage_catalogId_idx" ON "CatalogPage"("catalogId");

-- CreateIndex
CREATE INDEX "RawProduct_catalogPageId_idx" ON "RawProduct"("catalogPageId");

-- CreateIndex
CREATE INDEX "RawProduct_status_idx" ON "RawProduct"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE INDEX "SupplierOffer_supplierId_idx" ON "SupplierOffer"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierOffer_canonicalProductId_idx" ON "SupplierOffer"("canonicalProductId");
