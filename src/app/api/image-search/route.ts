import { NextRequest, NextResponse } from "next/server";
import {
  ImageSearchAnalysis,
  analyzeImageForProductSearch,
  buildImageSearchTerms,
} from "@/features/image-search/analyze-image";
import { searchSupplierOffers } from "@/features/search/queries";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE_MB = 8;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

type ImageSearchCandidate = {
  id: string;
  supplierProductName: string | null;
  supplierCode: string | null;
  catalogReference: string | null;
  confidence: number | null;
  matchReason: string;
  imageSearchScore: number;
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
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function getTokens(value: string | null | undefined) {
  return normalizeText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter(
      (token) =>
        ![
          "para",
          "com",
          "sem",
          "uma",
          "uns",
          "das",
          "dos",
          "por",
          "preparar",
          "ingredientes",
          "outros",
        ].includes(token)
    );
}

function getOfferText(candidate: ImageSearchCandidate) {
  return normalizeText(
    [
      candidate.supplierProductName,
      candidate.supplierCode,
      candidate.catalogReference,
      candidate.canonicalProduct.namePt,
      candidate.canonicalProduct.descriptionPt,
      candidate.canonicalProduct.category,
      candidate.canonicalProduct.function,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getMatchReason(term: string, visibleCodes: string[]) {
  const normalizedTerm = normalizeText(term);

  const isCodeMatch = visibleCodes.some(
    (code) => normalizeText(code) === normalizedTerm
  );

  if (isCodeMatch) {
    return `Código/modelo visível: ${term}`;
  }

  return `Termo visual: ${term}`;
}

function scoreImageCandidate({
  candidate,
  term,
  analysis,
}: {
  candidate: ImageSearchCandidate;
  term: string;
  analysis: ImageSearchAnalysis;
}) {
  const offerText = getOfferText(candidate);

  const normalizedTerm = normalizeText(term);
  const productName = normalizeText(analysis.productName);
  const category = normalizeText(analysis.category);
  const productFunction = normalizeText(analysis.function);

  const termTokens = getTokens(term);
  const productNameTokens = getTokens(analysis.productName);
  const categoryTokens = getTokens(analysis.category);
  const functionTokens = getTokens(analysis.function);

  const supplierCode = normalizeText(candidate.supplierCode);
  const canonicalName = normalizeText(candidate.canonicalProduct.namePt);
  const supplierProductName = normalizeText(candidate.supplierProductName);
  const candidateCategory = normalizeText(candidate.canonicalProduct.category);
  const candidateFunction = normalizeText(candidate.canonicalProduct.function);

  let score = 0;

  if (
    analysis.visibleCodes.some((code) => normalizeText(code) === supplierCode)
  ) {
    score += 200;
  }

  if (normalizedTerm && supplierCode.includes(normalizedTerm)) {
    score += 140;
  }

  if (productName && canonicalName === productName) {
    score += 120;
  }

  if (productName && supplierProductName === productName) {
    score += 110;
  }

  if (productName && canonicalName.includes(productName)) {
    score += 90;
  }

  if (productName && supplierProductName.includes(productName)) {
    score += 80;
  }

  if (normalizedTerm && canonicalName.includes(normalizedTerm)) {
    score += 70;
  }

  if (normalizedTerm && supplierProductName.includes(normalizedTerm)) {
    score += 65;
  }

  for (const token of productNameTokens) {
    if (canonicalName.includes(token)) score += 25;
    if (supplierProductName.includes(token)) score += 22;
  }

  for (const token of termTokens) {
    if (canonicalName.includes(token)) score += 18;
    if (supplierProductName.includes(token)) score += 16;
    if (candidateCategory.includes(token)) score += 8;
    if (candidateFunction.includes(token)) score += 6;
  }

  for (const token of categoryTokens) {
    if (candidateCategory.includes(token)) score += 12;
  }

  for (const token of functionTokens) {
    if (offerText.includes(token)) score += 3;
  }

  if (category && candidateCategory && candidateCategory.includes(category)) {
    score += 20;
  }

  if (
    productFunction &&
    candidateFunction &&
    candidateFunction.includes(productFunction)
  ) {
    score += 15;
  }

  score += Math.round((candidate.confidence ?? 0) * 5);

  return score;
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

    const resultsMap = new Map<string, ImageSearchCandidate>();

    for (const term of searchTerms) {
      const offers = await searchSupplierOffers({
        query: term,
      });

      for (const offer of offers) {
        const candidate: ImageSearchCandidate = {
          id: offer.id,
          supplierProductName: offer.supplierProductName,
          supplierCode: offer.supplierCode,
          catalogReference: offer.catalogReference,
          confidence: offer.confidence,
          matchReason: getMatchReason(term, analysis.visibleCodes),
          imageSearchScore: 0,
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
        };

        const imageSearchScore = scoreImageCandidate({
          candidate,
          term,
          analysis,
        });

        if (imageSearchScore < 70) {
          continue;
        }

        const previousCandidate = resultsMap.get(offer.id);

        if (
          !previousCandidate ||
          imageSearchScore > previousCandidate.imageSearchScore
        ) {
          resultsMap.set(offer.id, {
            ...candidate,
            imageSearchScore,
          });
        }
      }
    }

    const results = Array.from(resultsMap.values())
      .sort((a, b) => b.imageSearchScore - a.imageSearchScore)
      .slice(0, 12);

    return NextResponse.json({
      analysis,
      searchTerms,
      results,
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
