import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type SearchSupplierOffersParams = {
  query: string;
  supplierId?: string;
  category?: string;
};

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function getSearchTokens(query: string) {
  return normalizeText(query)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getSearchableText(offer: {
  supplierProductName: string | null;
  supplierCode: string | null;
  catalogReference: string | null;
  supplier: {
    name: string;
  };
  canonicalProduct: {
    namePt: string;
    descriptionPt: string | null;
    category: string | null;
    function: string | null;
  };
}) {
  return normalizeText(
    [
      offer.supplierProductName,
      offer.supplierCode,
      offer.catalogReference,
      offer.supplier.name,
      offer.canonicalProduct.namePt,
      offer.canonicalProduct.descriptionPt,
      offer.canonicalProduct.category,
      offer.canonicalProduct.function,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

export async function getSearchFilters() {
  const offers = await prisma.supplierOffer.findMany({
    select: {
      supplier: {
        select: {
          id: true,
          name: true,
        },
      },
      canonicalProduct: {
        select: {
          category: true,
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: 5000,
  });

  const suppliersMap = new Map<string, string>();
  const categoriesSet = new Set<string>();

  for (const offer of offers) {
    suppliersMap.set(offer.supplier.id, offer.supplier.name);

    const category = offer.canonicalProduct.category?.trim();

    if (category) {
      categoriesSet.add(category);
    }
  }

  return {
    suppliers: Array.from(suppliersMap.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    categories: Array.from(categoriesSet).sort((a, b) =>
      a.localeCompare(b, "pt-BR")
    ),
  };
}

async function getCandidateOffers({
  supplierId,
  category,
}: {
  supplierId?: string;
  category?: string;
}) {
  const andFilters: Prisma.SupplierOfferWhereInput[] = [];

  if (supplierId) {
    andFilters.push({
      supplierId,
    });
  }

  if (category) {
    andFilters.push({
      canonicalProduct: {
        category: {
          equals: category,
          mode: "insensitive",
        },
      },
    });
  }

  return prisma.supplierOffer.findMany({
    where:
      andFilters.length > 0
        ? {
            AND: andFilters,
          }
        : undefined,
    include: {
      supplier: true,
      canonicalProduct: true,
      catalog: {
        select: {
          id: true,
          fileName: true,
        },
      },
      rawProduct: {
        select: {
          id: true,
          imageUrl: true,
          status: true,
        },
      },
    },
    orderBy: {
      updatedAt: "desc",
    },
    take: 5000,
  });
}

export async function searchSupplierOffers({
  query,
  supplierId,
  category,
}: SearchSupplierOffersParams) {
  const search = query.trim();
  const normalizedSearch = normalizeText(search);
  const tokens = getSearchTokens(search);

  if (!search && !supplierId && !category) {
    return [];
  }

  const offers = await getCandidateOffers({
    supplierId,
    category,
  });

  return offers
    .map((offer) => {
      const searchableText = getSearchableText(offer);

      const supplierProductName = normalizeText(offer.supplierProductName);
      const canonicalName = normalizeText(offer.canonicalProduct.namePt);
      const supplierCode = normalizeText(offer.supplierCode);
      const supplierName = normalizeText(offer.supplier.name);
      const productCategory = normalizeText(offer.canonicalProduct.category);
      const description = normalizeText(offer.canonicalProduct.descriptionPt);
      const productFunction = normalizeText(offer.canonicalProduct.function);

      const allTokensMatched =
        tokens.length === 0 ||
        tokens.every((token) => searchableText.includes(token));

      let score = 0;

      if (tokens.length === 0) {
        score += 10;
      }

      if (allTokensMatched) {
        score += 40;
      }

      if (normalizedSearch) {
        if (supplierCode === normalizedSearch) score += 120;
        if (supplierCode.includes(normalizedSearch)) score += 90;

        if (canonicalName === normalizedSearch) score += 80;
        if (canonicalName.includes(normalizedSearch)) score += 60;

        if (supplierProductName === normalizedSearch) score += 75;
        if (supplierProductName.includes(normalizedSearch)) score += 55;

        if (productCategory === normalizedSearch) score += 45;
        if (productCategory.includes(normalizedSearch)) score += 35;

        if (productFunction.includes(normalizedSearch)) score += 25;
        if (description.includes(normalizedSearch)) score += 15;
        if (supplierName.includes(normalizedSearch)) score += 10;

        for (const token of tokens) {
          if (supplierCode.includes(token)) score += 25;
          if (canonicalName.includes(token)) score += 18;
          if (supplierProductName.includes(token)) score += 15;
          if (productCategory.includes(token)) score += 12;
          if (productFunction.includes(token)) score += 8;
          if (description.includes(token)) score += 5;
          if (supplierName.includes(token)) score += 3;
        }
      }

      if (supplierId && offer.supplierId === supplierId) {
        score += 10;
      }

      if (
        category &&
        normalizeText(offer.canonicalProduct.category) ===
          normalizeText(category)
      ) {
        score += 10;
      }

      score += Math.round((offer.confidence ?? 0) * 10);

      return {
        offer,
        score,
        allTokensMatched,
      };
    })
    .filter((result) => {
      if (tokens.length === 0) {
        return true;
      }

      return result.allTokensMatched || result.score >= 60;
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return (b.offer.confidence ?? 0) - (a.offer.confidence ?? 0);
    })
    .slice(0, 50)
    .map((result) => result.offer);
}
