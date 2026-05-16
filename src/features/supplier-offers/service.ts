import { prisma } from "@/lib/prisma";

async function findOrCreateCanonicalProduct(input: {
  namePt: string;
  descriptionPt?: string | null;
  category?: string | null;
}) {
  const existingProduct = await prisma.canonicalProduct.findFirst({
    where: {
      namePt: input.namePt,
      category: input.category || null,
    },
  });

  if (existingProduct) {
    return existingProduct;
  }

  return prisma.canonicalProduct.create({
    data: {
      namePt: input.namePt,
      descriptionPt: input.descriptionPt || null,
      category: input.category || null,
    },
  });
}

export async function createSupplierOfferFromRawProductId(
  rawProductId: string
) {
  const rawProduct = await prisma.rawProduct.findUnique({
    where: {
      id: rawProductId,
    },
    include: {
      catalogPage: {
        include: {
          catalog: true,
        },
      },
    },
  });

  if (!rawProduct) {
    throw new Error("Produto bruto não encontrado.");
  }

  if (rawProduct.status !== "APPROVED") {
    throw new Error("Só é possível criar oferta a partir de produto aprovado.");
  }

  if (!rawProduct.translatedNamePt) {
    throw new Error("Produto bruto precisa ter nome em português.");
  }

  const canonicalProduct = await findOrCreateCanonicalProduct({
    namePt: rawProduct.translatedNamePt,
    descriptionPt: rawProduct.translatedDescriptionPt,
    category: rawProduct.category,
  });

  const catalog = rawProduct.catalogPage.catalog;

  return prisma.supplierOffer.upsert({
    where: {
      rawProductId: rawProduct.id,
    },
    create: {
      supplierId: catalog.supplierId,
      canonicalProductId: canonicalProduct.id,
      rawProductId: rawProduct.id,
      catalogId: catalog.id,
      supplierProductName: rawProduct.translatedNamePt,
      supplierCode: rawProduct.code,
      catalogReference: `${catalog.fileName} · página ${rawProduct.catalogPage.pageNumber}`,
      confidence: rawProduct.confidence ?? 1,
    },
    update: {
      supplierId: catalog.supplierId,
      canonicalProductId: canonicalProduct.id,
      catalogId: catalog.id,
      supplierProductName: rawProduct.translatedNamePt,
      supplierCode: rawProduct.code,
      catalogReference: `${catalog.fileName} · página ${rawProduct.catalogPage.pageNumber}`,
      confidence: rawProduct.confidence ?? 1,
    },
  });
}

export async function createSupplierOffersFromApprovedRawProductsByCatalogId(
  catalogId: string
) {
  const approvedRawProducts = await prisma.rawProduct.findMany({
    where: {
      status: "APPROVED",
      translatedNamePt: {
        not: null,
      },
      supplierOffer: null,
      catalogPage: {
        catalogId,
      },
    },
    select: {
      id: true,
    },
  });

  for (const rawProduct of approvedRawProducts) {
    await createSupplierOfferFromRawProductId(rawProduct.id);
  }

  return {
    created: approvedRawProducts.length,
  };
}

export async function deleteSupplierOfferFromRawProductId(
  rawProductId: string
) {
  await prisma.supplierOffer.deleteMany({
    where: {
      rawProductId,
    },
  });
}
