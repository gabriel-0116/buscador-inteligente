import { prisma } from "@/lib/prisma";

export async function getCatalogById(id: string) {
  return prisma.catalog.findUnique({
    where: {
      id,
    },
    include: {
      supplier: true,
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
      },
    },
  });
}