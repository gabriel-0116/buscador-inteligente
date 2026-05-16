import { prisma } from "@/lib/prisma";

export async function getSuppliers() {
  return prisma.supplier.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });
}

export async function getSupplierById(id: string) {
  return prisma.supplier.findUnique({
    where: {
      id,
    },
    include: {
      catalogs: {
        orderBy: {
          createdAt: "desc",
        },
      },
    },
  });
}
