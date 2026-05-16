"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export async function createRawProduct(formData: FormData) {
  const catalogPageId = String(formData.get("catalogPageId") ?? "").trim();
  const originalText = String(formData.get("originalText") ?? "").trim();
  const translatedNamePt = String(
    formData.get("translatedNamePt") ?? ""
  ).trim();
  const translatedDescriptionPt = String(
    formData.get("translatedDescriptionPt") ?? ""
  ).trim();
  const category = String(formData.get("category") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();

  if (!catalogPageId) {
    throw new Error("Página do catálogo é obrigatória.");
  }

  if (!translatedNamePt) {
    throw new Error("Nome do produto em português é obrigatório.");
  }

  const page = await prisma.catalogPage.findUnique({
    where: {
      id: catalogPageId,
    },
    select: {
      id: true,
    },
  });

  if (!page) {
    throw new Error("Página do catálogo não encontrada.");
  }

  await prisma.rawProduct.create({
    data: {
      catalogPageId,
      originalText: originalText || null,
      translatedNamePt,
      translatedDescriptionPt: translatedDescriptionPt || null,
      category: category || null,
      code: code || null,
      brand: brand || null,
      status: "PENDING_REVIEW",
    },
  });

  revalidatePath(`/paginas/${catalogPageId}`);
}
