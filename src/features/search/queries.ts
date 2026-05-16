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
    take: 1000,
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

export async function searchSupplierOffers({
  query,
  supplierId,
  category,
}: SearchSupplierOffersParams) {
  const search = query.trim();
  const tokens = getSearchTokens(search);

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

  if (tokens.length > 0) {
    andFilters.push({
      AND: tokens.map((token) => ({
        OR: [
          {
            supplierProductName: {
              contains: token,
              mode: "insensitive",
            },
          },
          {
            supplierCode: {
              contains: token,
              mode: "insensitive",
            },
          },
          {
            catalogReference: {
              contains: token,
              mode: "insensitive",
            },
          },
          {
            supplier: {
              name: {
                contains: token,
                mode: "insensitive",
              },
            },
          },
          {
            canonicalProduct: {
              OR: [
                {
                  namePt: {
                    contains: token,
                    mode: "insensitive",
                  },
                },
                {
                  descriptionPt: {
                    contains: token,
                    mode: "insensitive",
                  },
                },
                {
                  category: {
                    contains: token,
                    mode: "insensitive",
                  },
                },
                {
                  function: {
                    contains: token,
                    mode: "insensitive",
                  },
                },
              ],
            },
          },
        ],
      })),
    });
  }

  if (andFilters.length === 0) {
    return [];
  }

  const offers = await prisma.supplierOffer.findMany({
    where: {
      AND: andFilters,
    },
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
    take: 200,
  });

  const normalizedSearch = normalizeText(search);

  return offers
    .map((offer) => {
      const supplierProductName = normalizeText(offer.supplierProductName);
      const canonicalName = normalizeText(offer.canonicalProduct.namePt);
      const supplierCode = normalizeText(offer.supplierCode);
      const supplierName = normalizeText(offer.supplier.name);
      const productCategory = normalizeText(offer.canonicalProduct.category);
      const description = normalizeText(offer.canonicalProduct.descriptionPt);
      const productFunction = normalizeText(offer.canonicalProduct.function);

      let score = 0;

      if (normalizedSearch) {
        if (supplierCode === normalizedSearch) score += 100;
        if (supplierCode.includes(normalizedSearch)) score += 80;
        if (canonicalName === normalizedSearch) score += 70;
        if (canonicalName.includes(normalizedSearch)) score += 50;
        if (supplierProductName.includes(normalizedSearch)) score += 45;
        if (productCategory.includes(normalizedSearch)) score += 25;
        if (productFunction.includes(normalizedSearch)) score += 20;
        if (description.includes(normalizedSearch)) score += 15;
        if (supplierName.includes(normalizedSearch)) score += 10;

        for (const token of tokens) {
          if (supplierCode.includes(token)) score += 20;
          if (canonicalName.includes(token)) score += 15;
          if (supplierProductName.includes(token)) score += 12;
          if (productCategory.includes(token)) score += 8;
          if (productFunction.includes(token)) score += 6;
          if (description.includes(token)) score += 4;
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
      };
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
