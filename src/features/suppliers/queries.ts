import { prisma } from "@/lib/prisma";

export async function getSuppliers() {
  return prisma.supplier.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });
}