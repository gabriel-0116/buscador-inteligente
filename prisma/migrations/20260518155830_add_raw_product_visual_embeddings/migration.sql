-- CreateTable
CREATE TABLE "RawProductVisualEmbedding" (
    "id" TEXT NOT NULL,
    "rawProductId" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RawProductVisualEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RawProductVisualEmbedding_rawProductId_key" ON "RawProductVisualEmbedding"("rawProductId");

-- CreateIndex
CREATE INDEX "RawProductVisualEmbedding_rawProductId_idx" ON "RawProductVisualEmbedding"("rawProductId");

-- CreateIndex
CREATE INDEX "RawProductVisualEmbedding_model_idx" ON "RawProductVisualEmbedding"("model");

-- AddForeignKey
ALTER TABLE "RawProductVisualEmbedding" ADD CONSTRAINT "RawProductVisualEmbedding_rawProductId_fkey" FOREIGN KEY ("rawProductId") REFERENCES "RawProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
