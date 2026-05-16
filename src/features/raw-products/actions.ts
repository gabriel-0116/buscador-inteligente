"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  createSupplierOfferFromRawProductId,
  createSupplierOffersFromApprovedRawProductsByCatalogId,
  deleteSupplierOfferFromRawProductId,
} from "@/features/supplier-offers/service";

function getReturnTo(formData: FormData) {
  const returnTo = String(formData.get("returnTo") ?? "").trim();

  if (!returnTo.startsWith("/")) {
    return null;
  }

  return returnTo;
}

export async function updateRawProduct(formData: FormData) {
  const rawProductId = String(formData.get("rawProductId") ?? "").trim();
  const translatedNamePt = String(
    formData.get("translatedNamePt") ?? ""
  ).trim();
  const code = String(formData.get("code") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const translatedDescriptionPt = String(
    formData.get("translatedDescriptionPt") ?? ""
  ).trim();

  if (!rawProductId) {
    throw new Error("Produto bruto é obrigatório.");
  }

  if (!translatedNamePt) {
    throw new Error("Nome em português é obrigatório.");
  }

  const rawProduct = await prisma.rawProduct.update({
    where: {
      id: rawProductId,
    },
    data: {
      translatedNamePt,
      code: code || null,
      brand: brand || null,
      category: category || null,
      translatedDescriptionPt: translatedDescriptionPt || null,
    },
    select: {
      id: true,
      catalogPageId: true,
      catalogPage: {
        select: {
          catalogId: true,
        },
      },
    },
  });

  revalidatePath(`/produtos-brutos/${rawProduct.id}`);
  revalidatePath(`/paginas/${rawProduct.catalogPageId}`);
  revalidatePath(`/catalogos/${rawProduct.catalogPage.catalogId}/revisao`);
}

export async function approveRawProduct(formData: FormData) {
  const rawProductId = String(formData.get("rawProductId") ?? "").trim();
  const returnTo = getReturnTo(formData);

  if (!rawProductId) {
    throw new Error("Produto bruto é obrigatório.");
  }

  const rawProduct = await prisma.rawProduct.update({
    where: {
      id: rawProductId,
    },
    data: {
      status: "APPROVED",
      confidence: 1,
    },
    select: {
      id: true,
      catalogPageId: true,
      catalogPage: {
        select: {
          catalogId: true,
        },
      },
    },
  });

  await createSupplierOfferFromRawProductId(rawProduct.id);

  revalidatePath(`/produtos-brutos/${rawProduct.id}`);
  revalidatePath(`/paginas/${rawProduct.catalogPageId}`);
  revalidatePath(`/catalogos/${rawProduct.catalogPage.catalogId}`);
  revalidatePath(`/catalogos/${rawProduct.catalogPage.catalogId}/revisao`);
  revalidatePath("/busca");

  if (returnTo) {
    redirect(returnTo);
  }
}

export async function rejectRawProduct(formData: FormData) {
  const rawProductId = String(formData.get("rawProductId") ?? "").trim();
  const returnTo = getReturnTo(formData);

  if (!rawProductId) {
    throw new Error("Produto bruto é obrigatório.");
  }

  await deleteSupplierOfferFromRawProductId(rawProductId);

  const rawProduct = await prisma.rawProduct.update({
    where: {
      id: rawProductId,
    },
    data: {
      status: "REJECTED",
    },
    select: {
      id: true,
      catalogPageId: true,
      catalogPage: {
        select: {
          catalogId: true,
        },
      },
    },
  });

  revalidatePath(`/produtos-brutos/${rawProduct.id}`);
  revalidatePath(`/paginas/${rawProduct.catalogPageId}`);
  revalidatePath(`/catalogos/${rawProduct.catalogPage.catalogId}`);
  revalidatePath(`/catalogos/${rawProduct.catalogPage.catalogId}/revisao`);
  revalidatePath("/busca");

  if (returnTo) {
    redirect(returnTo);
  }
}

export async function approveConfidentRawProductsFromCatalog(
  formData: FormData
) {
  const catalogId = String(formData.get("catalogId") ?? "").trim();
  const returnTo = getReturnTo(formData);

  if (!catalogId) {
    throw new Error("Catálogo é obrigatório.");
  }

  await prisma.rawProduct.updateMany({
    where: {
      status: "PENDING_REVIEW",
      confidence: {
        gte: 0.65,
      },
      code: {
        not: null,
      },
      translatedNamePt: {
        not: null,
      },
      catalogPage: {
        catalogId,
      },
    },
    data: {
      status: "APPROVED",
      confidence: 1,
    },
  });

  await createSupplierOffersFromApprovedRawProductsByCatalogId(catalogId);

  revalidatePath(`/catalogos/${catalogId}`);
  revalidatePath(`/catalogos/${catalogId}/revisao`);

  if (returnTo) {
    redirect(returnTo);
  }
}
