import { prisma } from "@/lib/prisma";

export async function searchSupplierOffers(query: string) {
  const search = query.trim();

  if (!search) {
    return [];
  }

  return prisma.supplierOffer.findMany({
    where: {
      OR: [
        {
          supplierProductName: {
            contains: search,
            mode: "insensitive",
          },
        },
        {
          supplierCode: {
            contains: search,
            mode: "insensitive",
          },
        },
        {
          catalogReference: {
            contains: search,
            mode: "insensitive",
          },
        },
        {
          supplier: {
            name: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
        {
          canonicalProduct: {
            OR: [
              {
                namePt: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                descriptionPt: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                category: {
                  contains: search,
                  mode: "insensitive",
                },
              },
              {
                function: {
                  contains: search,
                  mode: "insensitive",
                },
              },
            ],
          },
        },
      ],
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
    take: 50,
  });
}
