import { prisma } from "@/lib/prisma";
import { generateRawProductCardsFromPage } from "@/features/raw-products/card-extraction";
import { runRawProductCardsOcrFromPage } from "@/features/raw-products/card-ocr";

export async function extractProductsFromCatalog(catalogId: string) {
  const catalog = await prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    include: {
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
        select: {
          id: true,
          imageUrl: true,
        },
      },
    },
  });

  if (!catalog) {
    throw new Error("Catálogo não encontrado.");
  }

  const pagesWithImages = catalog.pages.filter((page) => page.imageUrl);

  let generatedCards = 0;
  let ocrProcessedCards = 0;

  for (const page of pagesWithImages) {
    const cardResult = await generateRawProductCardsFromPage(page.id);
    generatedCards += cardResult.created;

    const ocrResult = await runRawProductCardsOcrFromPage(page.id);
    ocrProcessedCards += ocrResult.processed;
  }

  return {
    pagesProcessed: pagesWithImages.length,
    generatedCards,
    ocrProcessedCards,
  };
}
