"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

function getReturnTo(formData: FormData) {
  const returnTo = String(formData.get("returnTo") ?? "").trim();

  if (!returnTo.startsWith("/")) {
    return null;
  }

  return returnTo;
}

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

async function createSupplierOfferFromRawProductId(rawProductId: string) {
  const rawProduct = await prisma.rawProduct.findUnique({
    where: {
      id: rawProductId,
    },
    include: {
      supplierOffer: true,
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

export async function createSupplierOfferFromRawProduct(formData: FormData) {
  const rawProductId = String(formData.get("rawProductId") ?? "").trim();
  const returnTo = getReturnTo(formData);

  if (!rawProductId) {
    throw new Error("Produto bruto é obrigatório.");
  }

  const offer = await createSupplierOfferFromRawProductId(rawProductId);

  revalidatePath(`/produtos-brutos/${rawProductId}`);
  revalidatePath(`/catalogos/${offer.catalogId}/revisao`);
  revalidatePath(`/catalogos/${offer.catalogId}`);

  if (returnTo) {
    redirect(returnTo);
  }
}

export async function createSupplierOffersFromApprovedRawProducts(
  formData: FormData
) {
  const catalogId = String(formData.get("catalogId") ?? "").trim();
  const returnTo = getReturnTo(formData);

  if (!catalogId) {
    throw new Error("Catálogo é obrigatório.");
  }

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

  revalidatePath(`/catalogos/${catalogId}`);
  revalidatePath(`/catalogos/${catalogId}/revisao`);

  if (returnTo) {
    redirect(returnTo);
  }
}
