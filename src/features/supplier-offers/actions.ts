"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  createSupplierOfferFromRawProductId,
  createSupplierOffersFromApprovedRawProductsByCatalogId,
} from "@/features/supplier-offers/service";

function getReturnTo(formData: FormData) {
  const returnTo = String(formData.get("returnTo") ?? "").trim();

  if (!returnTo.startsWith("/")) {
    return null;
  }

  return returnTo;
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

  await createSupplierOffersFromApprovedRawProductsByCatalogId(catalogId);

  revalidatePath(`/catalogos/${catalogId}`);
  revalidatePath(`/catalogos/${catalogId}/revisao`);

  if (returnTo) {
    redirect(returnTo);
  }
}
