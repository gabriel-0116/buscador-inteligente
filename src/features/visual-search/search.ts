import { ImageSearchAnalysis } from "@/features/image-search/analyze-image";
import { prisma } from "@/lib/prisma";
import { generateImageEmbeddingFromFile } from "@/features/visual-search/embeddings";

type VisualEmbeddingRecord = {
  id: string;
  embedding: unknown;
  rawProduct: {
    id: string;
    originalText: string | null;
    translatedNamePt: string | null;
    translatedDescriptionPt: string | null;
    category: string | null;
    code: string | null;
    brand: string | null;
    imageUrl: string | null;
    status: string;
    confidence: number | null;
    catalogPage: {
      id: string;
      pageNumber: number;
      catalog: {
        id: string;
        fileName: string;
        supplier: {
          id: string;
          name: string;
        };
      };
    };
    supplierOffer: {
      id: string;
      supplierProductName: string | null;
      supplierCode: string | null;
      catalogReference: string | null;
      confidence: number | null;
      canonicalProduct: {
        id: string;
        namePt: string;
        descriptionPt: string | null;
        category: string | null;
        function: string | null;
      };
    } | null;
  };
};

export type VisualSearchResultLevel = "STRONG" | "POSSIBLE";

export type VisualSearchResult = {
  id: string;
  supplierProductName: string | null;
  supplierCode: string | null;
  catalogReference: string | null;
  confidence: number | null;
  visualSimilarity: number;
  hybridScore: number;
  resultLevel: VisualSearchResultLevel;
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
  };
  rawProduct: {
    id: string;
    imageUrl: string | null;
    status: string;
  };
};

const DEFAULT_TAKE = 8;
const DEFAULT_POOL_LIMIT = 5000;
const DEFAULT_VISUAL_CANDIDATE_POOL = 120;

const MIN_ABSOLUTE_SIMILARITY = 0.5;
const STRONG_RESULT_DELTA = 0.06;
const POSSIBLE_RESULT_DELTA = 0.12;

const STOP_WORDS = new Set([
  "para",
  "com",
  "sem",
  "uma",
  "uns",
  "das",
  "dos",
  "por",
  "de",
  "do",
  "da",
  "em",
  "no",
  "na",
  "e",
  "ou",
  "o",
  "a",
  "os",
  "as",
  "produto",
  "item",
  "modelo",
  "tipo",
  "uso",
  "kit",
  "mini",
  "portatil",
  "eletrico",
  "eletrica",
  "digital",
  "recarregavel",
]);

const GENERIC_CODE_PATTERNS = [
  /^type-?c$/i,
  /^usb-?c$/i,
  /^lightning$/i,
  /^\d+\s?pc\/?cx$/i,
  /^pcs\/?cx$/i,
  /^unid\.?cx$/i,
  /^\d+\s?g$/i,
  /^\d+\s?kg$/i,
  /^\d+\s?ml$/i,
  /^\d+\s?cm$/i,
  /^\d+$/i,
];

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
    .filter((token) => !STOP_WORDS.has(token));
}

function getUniqueTokens(values: Array<string | null | undefined>) {
  const tokens = new Set<string>();

  for (const value of values) {
    for (const token of getTokens(value)) {
      tokens.add(token);
    }
  }

  return Array.from(tokens);
}

function isGenericCode(value: string | null | undefined) {
  const code = (value ?? "").trim();

  if (!code) {
    return true;
  }

  return GENERIC_CODE_PATTERNS.some((pattern) => pattern.test(code));
}

function getStrongVisibleCodes(analysis: ImageSearchAnalysis | null) {
  if (!analysis) {
    return [];
  }

  return analysis.visibleCodes.filter((code) => !isGenericCode(code));
}

function parseEmbedding(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "number" ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
}

function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return -1;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getDisplayName(record: VisualEmbeddingRecord) {
  return (
    record.rawProduct.supplierOffer?.canonicalProduct.namePt ||
    record.rawProduct.supplierOffer?.supplierProductName ||
    record.rawProduct.translatedNamePt ||
    record.rawProduct.originalText ||
    "Produto do catálogo"
  );
}

function getDisplayCategory(record: VisualEmbeddingRecord) {
  return (
    record.rawProduct.supplierOffer?.canonicalProduct.category ||
    record.rawProduct.category ||
    null
  );
}

function getDisplayDescription(record: VisualEmbeddingRecord) {
  return (
    record.rawProduct.supplierOffer?.canonicalProduct.descriptionPt ||
    record.rawProduct.translatedDescriptionPt ||
    record.rawProduct.originalText ||
    null
  );
}

function getDisplayFunction(record: VisualEmbeddingRecord) {
  return record.rawProduct.supplierOffer?.canonicalProduct.function || null;
}

function getDisplayCode(record: VisualEmbeddingRecord) {
  return (
    record.rawProduct.supplierOffer?.supplierCode ||
    record.rawProduct.code ||
    null
  );
}

function getOfferText(record: VisualEmbeddingRecord) {
  return normalizeText(
    [
      getDisplayName(record),
      getDisplayDescription(record),
      getDisplayFunction(record),
      getDisplayCode(record),
      record.rawProduct.originalText,
      record.rawProduct.brand,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getDeduplicationKey(result: VisualSearchResult) {
  const supplierId = result.supplier.id;
  const code = normalizeText(result.supplierCode);
  const name = normalizeText(result.canonicalProduct.namePt);

  if (code) {
    return `${supplierId}:code:${code}`;
  }

  if (name) {
    return `${supplierId}:name:${name}`;
  }

  return `${supplierId}:raw:${result.rawProduct.id}`;
}

function countTokenMatches(tokens: string[], text: string) {
  return tokens.filter((token) => text.includes(token)).length;
}

function getSpecificTextBonus({
  record,
  analysis,
}: {
  record: VisualEmbeddingRecord;
  analysis: ImageSearchAnalysis | null;
}) {
  if (!analysis) {
    return {
      bonus: 0,
      reasons: [] as string[],
    };
  }

  let bonus = 0;
  const reasons: string[] = [];

  const offerText = getOfferText(record);
  const candidateName = normalizeText(getDisplayName(record));
  const candidateCode = normalizeText(getDisplayCode(record));

  const productName = normalizeText(analysis.productName);
  const productNameTokens = getTokens(analysis.productName);
  const searchTermTokens = getUniqueTokens(analysis.searchTerms);
  const strongVisibleCodes = getStrongVisibleCodes(analysis);

  const hasCodeMatch = strongVisibleCodes.some(
    (code) => normalizeText(code) === candidateCode
  );

  if (hasCodeMatch) {
    bonus += 80;
    reasons.push("código confirmado");
  }

  if (productName && candidateName === productName) {
    bonus += 45;
    reasons.push("nome exato");
  } else if (productName && candidateName.includes(productName)) {
    bonus += 28;
    reasons.push("nome compatível");
  }

  const nameTokenMatches = countTokenMatches(productNameTokens, candidateName);

  if (nameTokenMatches > 0) {
    bonus += Math.min(nameTokenMatches * 16, 40);
    reasons.push("termos do nome");
  }

  const searchTokenMatches = countTokenMatches(searchTermTokens, offerText);

  if (searchTokenMatches > 0) {
    bonus += Math.min(searchTokenMatches * 8, 24);
    reasons.push("termos comerciais");
  }

  return {
    bonus,
    reasons,
  };
}

function getResultLevel({
  visualSimilarity,
  strongCutoff,
}: {
  visualSimilarity: number;
  strongCutoff: number;
}): VisualSearchResultLevel {
  return visualSimilarity >= strongCutoff ? "STRONG" : "POSSIBLE";
}

function buildMatchReason({
  visualSimilarity,
  resultLevel,
  reasons,
}: {
  visualSimilarity: number;
  resultLevel: VisualSearchResultLevel;
  reasons: string[];
}) {
  const visualText = `Similaridade visual: ${Math.round(
    visualSimilarity * 100
  )}%`;

  const levelText = resultLevel === "STRONG" ? "forte" : "possível";

  if (reasons.length === 0) {
    return `${visualText} · ${levelText}`;
  }

  return `${visualText} · ${levelText} · ${reasons.slice(0, 2).join(" · ")}`;
}

function buildResult({
  record,
  visualSimilarity,
  hybridScore,
  resultLevel,
  matchReason,
}: {
  record: VisualEmbeddingRecord;
  visualSimilarity: number;
  hybridScore: number;
  resultLevel: VisualSearchResultLevel;
  matchReason: string;
}): VisualSearchResult {
  const name = getDisplayName(record);
  const category = getDisplayCategory(record);
  const description = getDisplayDescription(record);
  const productFunction = getDisplayFunction(record);
  const code = getDisplayCode(record);

  return {
    id: record.rawProduct.id,
    supplierProductName:
      record.rawProduct.supplierOffer?.supplierProductName ||
      record.rawProduct.translatedNamePt ||
      name,
    supplierCode: code,
    catalogReference:
      record.rawProduct.supplierOffer?.catalogReference ||
      `Página ${record.rawProduct.catalogPage.pageNumber}`,
    confidence:
      record.rawProduct.supplierOffer?.confidence ??
      record.rawProduct.confidence ??
      null,
    visualSimilarity,
    hybridScore,
    resultLevel,
    matchReason,
    supplier: {
      id: record.rawProduct.catalogPage.catalog.supplier.id,
      name: record.rawProduct.catalogPage.catalog.supplier.name,
    },
    canonicalProduct: {
      id:
        record.rawProduct.supplierOffer?.canonicalProduct.id ||
        record.rawProduct.id,
      namePt: name,
      descriptionPt: description,
      category,
      function: productFunction,
    },
    catalog: {
      id: record.rawProduct.catalogPage.catalog.id,
      fileName: record.rawProduct.catalogPage.catalog.fileName,
    },
    rawProduct: {
      id: record.rawProduct.id,
      imageUrl: record.rawProduct.imageUrl,
      status: record.rawProduct.status,
    },
  };
}

export async function searchRawProductsByVisualSimilarity({
  image,
  analysis = null,
  take = DEFAULT_TAKE,
  poolLimit = DEFAULT_POOL_LIMIT,
  visualCandidatePool = DEFAULT_VISUAL_CANDIDATE_POOL,
}: {
  image: File;
  analysis?: ImageSearchAnalysis | null;
  take?: number;
  poolLimit?: number;
  visualCandidatePool?: number;
}) {
  const queryEmbedding = await generateImageEmbeddingFromFile(image);

  const records = (await prisma.rawProductVisualEmbedding.findMany({
    where: {
      rawProduct: {
        imageUrl: {
          not: null,
        },
        status: {
          not: "REJECTED",
        },
      },
    },
    include: {
      rawProduct: {
        include: {
          catalogPage: {
            include: {
              catalog: {
                include: {
                  supplier: true,
                },
              },
            },
          },
          supplierOffer: {
            include: {
              canonicalProduct: true,
            },
          },
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: poolLimit,
  })) as VisualEmbeddingRecord[];

  const visualCandidates = records
    .map((record) => {
      const embedding = parseEmbedding(record.embedding);
      const visualSimilarity = cosineSimilarity(queryEmbedding, embedding);

      return {
        record,
        visualSimilarity,
      };
    })
    .filter(
      (candidate) => candidate.visualSimilarity >= MIN_ABSOLUTE_SIMILARITY
    )
    .sort((a, b) => b.visualSimilarity - a.visualSimilarity)
    .slice(0, visualCandidatePool);

  const topSimilarity = visualCandidates[0]?.visualSimilarity ?? 0;

  if (!topSimilarity) {
    return [];
  }

  const strongCutoff = Math.max(
    MIN_ABSOLUTE_SIMILARITY,
    topSimilarity - STRONG_RESULT_DELTA
  );

  const possibleCutoff = Math.max(
    MIN_ABSOLUTE_SIMILARITY,
    topSimilarity - POSSIBLE_RESULT_DELTA
  );

  const dedupedResults = new Map<string, VisualSearchResult>();

  for (const candidate of visualCandidates) {
    if (candidate.visualSimilarity < possibleCutoff) {
      continue;
    }

    const textBonus = getSpecificTextBonus({
      record: candidate.record,
      analysis,
    });

    const resultLevel = getResultLevel({
      visualSimilarity: candidate.visualSimilarity,
      strongCutoff,
    });

    const hybridScore = candidate.visualSimilarity * 100 + textBonus.bonus;

    const result = buildResult({
      record: candidate.record,
      visualSimilarity: candidate.visualSimilarity,
      hybridScore,
      resultLevel,
      matchReason: buildMatchReason({
        visualSimilarity: candidate.visualSimilarity,
        resultLevel,
        reasons: textBonus.reasons,
      }),
    });

    const key = getDeduplicationKey(result);
    const previousResult = dedupedResults.get(key);

    if (!previousResult || result.hybridScore > previousResult.hybridScore) {
      dedupedResults.set(key, result);
    }
  }

  const results = Array.from(dedupedResults.values()).sort((a, b) => {
    if (a.resultLevel !== b.resultLevel) {
      return a.resultLevel === "STRONG" ? -1 : 1;
    }

    if (b.hybridScore !== a.hybridScore) {
      return b.hybridScore - a.hybridScore;
    }

    return b.visualSimilarity - a.visualSimilarity;
  });

  return results.slice(0, take);
}
