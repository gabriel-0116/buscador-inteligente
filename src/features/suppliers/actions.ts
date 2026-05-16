"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

export async function createSupplier(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();

  if (!name) {
    throw new Error("Nome do fornecedor é obrigatório.");
  }

  await prisma.supplier.create({
    data: {
      name,
      notes: notes || null,
    },
  });

  revalidatePath("/fornecedores");
  redirect("/fornecedores");
}
