import { prisma } from "@/lib/prisma";
import {
  VISUAL_EMBEDDING_MODEL,
  generateImageEmbeddingFromPath,
} from "@/features/visual-search/embeddings";

type IndexRawProductVisualEmbeddingsParams = {
  limit?: number;
  reindex?: boolean;
};

export async function getVisualIndexStatus() {
  const totalIndexableRawProducts = await prisma.rawProduct.count({
    where: {
      imageUrl: {
        not: null,
      },
      status: {
        not: "REJECTED",
      },
    },
  });

  const indexedRawProducts = await prisma.rawProductVisualEmbedding.count();

  return {
    totalIndexableRawProducts,
    indexedRawProducts,
    missingEmbeddings: Math.max(
      totalIndexableRawProducts - indexedRawProducts,
      0
    ),
  };
}

export async function indexRawProductVisualEmbeddings({
  limit = 100,
  reindex = false,
}: IndexRawProductVisualEmbeddingsParams = {}) {
  const rawProducts = await prisma.rawProduct.findMany({
    where: {
      imageUrl: {
        not: null,
      },
      status: {
        not: "REJECTED",
      },
      ...(reindex
        ? {}
        : {
            visualEmbedding: {
              is: null,
            },
          }),
    },
    select: {
      id: true,
      imageUrl: true,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  let indexed = 0;
  let failed = 0;

  const errors: Array<{
    rawProductId: string;
    error: string;
  }> = [];

  for (const rawProduct of rawProducts) {
    if (!rawProduct.imageUrl) {
      continue;
    }

    try {
      const embedding = await generateImageEmbeddingFromPath(
        rawProduct.imageUrl
      );

      await prisma.rawProductVisualEmbedding.upsert({
        where: {
          rawProductId: rawProduct.id,
        },
        create: {
          rawProductId: rawProduct.id,
          imageUrl: rawProduct.imageUrl,
          model: VISUAL_EMBEDDING_MODEL,
          embedding,
        },
        update: {
          imageUrl: rawProduct.imageUrl,
          model: VISUAL_EMBEDDING_MODEL,
          embedding,
        },
      });

      indexed += 1;
    } catch (error) {
      failed += 1;

      errors.push({
        rawProductId: rawProduct.id,
        error:
          error instanceof Error
            ? error.message
            : "Erro desconhecido ao indexar imagem.",
      });
    }
  }

  const status = await getVisualIndexStatus();

  return {
    requested: limit,
    found: rawProducts.length,
    indexed,
    failed,
    errors,
    status,
  };
}
