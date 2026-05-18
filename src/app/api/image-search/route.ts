import { NextRequest, NextResponse } from "next/server";
import {
  analyzeImageForProductSearch,
  buildImageSearchTerms,
} from "@/features/image-search/analyze-image";
import { searchSupplierOffers } from "@/features/search/queries";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE_MB = 8;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

function getMatchReason(term: string, visibleCodes: string[]) {
  const normalizedTerm = term.toLowerCase();

  const isCodeMatch = visibleCodes.some(
    (code) => code.toLowerCase() === normalizedTerm
  );

  if (isCodeMatch) {
    return `Código/modelo visível: ${term}`;
  }

  return `Termo visual: ${term}`;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const image = formData.get("image");

    if (!(image instanceof File)) {
      return NextResponse.json(
        {
          error: "Envie uma imagem válida.",
        },
        {
          status: 400,
        }
      );
    }

    if (!image.type.startsWith("image/")) {
      return NextResponse.json(
        {
          error: "O arquivo enviado precisa ser uma imagem.",
        },
        {
          status: 400,
        }
      );
    }

    if (image.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `A imagem precisa ter no máximo ${MAX_IMAGE_SIZE_MB}MB.`,
        },
        {
          status: 400,
        }
      );
    }

    const analysis = await analyzeImageForProductSearch(image);
    const searchTerms = buildImageSearchTerms(analysis);

    const resultsMap = new Map<
      string,
      {
        id: string;
        supplierProductName: string | null;
        supplierCode: string | null;
        catalogReference: string | null;
        confidence: number | null;
        matchReason: string;
        supplier: {
          id: string;
          name: string;
        };
        canonicalProduct: {
          id: string;
          namePt: string;
          descriptionPt: string | null;
          category: string | null;
          function: string | null;
        };
        catalog: {
          id: string;
          fileName: string;
        } | null;
        rawProduct: {
          id: string;
          imageUrl: string | null;
          status: string;
        } | null;
      }
    >();

    for (const term of searchTerms) {
      const offers = await searchSupplierOffers({
        query: term,
      });

      for (const offer of offers) {
        if (resultsMap.has(offer.id)) {
          continue;
        }

        resultsMap.set(offer.id, {
          id: offer.id,
          supplierProductName: offer.supplierProductName,
          supplierCode: offer.supplierCode,
          catalogReference: offer.catalogReference,
          confidence: offer.confidence,
          matchReason: getMatchReason(term, analysis.visibleCodes),
          supplier: {
            id: offer.supplier.id,
            name: offer.supplier.name,
          },
          canonicalProduct: {
            id: offer.canonicalProduct.id,
            namePt: offer.canonicalProduct.namePt,
            descriptionPt: offer.canonicalProduct.descriptionPt,
            category: offer.canonicalProduct.category,
            function: offer.canonicalProduct.function,
          },
          catalog: offer.catalog
            ? {
                id: offer.catalog.id,
                fileName: offer.catalog.fileName,
              }
            : null,
          rawProduct: offer.rawProduct
            ? {
                id: offer.rawProduct.id,
                imageUrl: offer.rawProduct.imageUrl,
                status: offer.rawProduct.status,
              }
            : null,
        });
      }
    }

    return NextResponse.json({
      analysis,
      searchTerms,
      results: Array.from(resultsMap.values()).slice(0, 50),
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Erro ao buscar produto por imagem.",
      },
      {
        status: 500,
      }
    );
  }
}
