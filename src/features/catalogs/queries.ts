import { prisma } from "@/lib/prisma";

export async function getCatalogById(id: string) {
  return prisma.catalog.findUnique({
    where: {
      id,
    },
    include: {
      supplier: true,
      offers: {
        select: {
          id: true,
        },
      },
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
        include: {
          rawProducts: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      },
    },
  });
}

export async function getCatalogPageById(id: string) {
  return prisma.catalogPage.findUnique({
    where: {
      id,
    },
    include: {
      catalog: {
        include: {
          supplier: true,
        },
      },
      rawProducts: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });
}
