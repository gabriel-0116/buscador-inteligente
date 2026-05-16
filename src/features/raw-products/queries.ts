import { prisma } from "@/lib/prisma";

export async function getRawProductById(id: string) {
  return prisma.rawProduct.findUnique({
    where: {
      id,
    },
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
    },
  });
}

export async function getRawProductsReviewByCatalogId(catalogId: string) {
  return prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    include: {
      supplier: true,
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
        include: {
          rawProducts: {
            orderBy: {
              createdAt: "asc",
            },
            include: {
              supplierOffer: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
    },
  });
}
