import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/prisma";
import { processCatalog } from "@/features/catalog-processing/process-catalog";

export async function POST(request: Request) {
  const formData = await request.formData();
  const supplierId = formData.get("supplierId") as string | null;
  const file = formData.get("file") as File | null;

  if (!supplierId || !file) {
    return NextResponse.json(
      { error: "supplierId e file são obrigatórios" },
      { status: 400 }
    );
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json(
      { error: "O arquivo deve ser um PDF" },
      { status: 400 }
    );
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) {
    return NextResponse.json({ error: "Fornecedor não encontrado" }, { status: 404 });
  }

  const catalog = await prisma.catalog.create({
    data: { supplierId, fileName: file.name, status: "PROCESSING" },
  });

  const pdfBuffer = Buffer.from(await file.arrayBuffer());
  const pdfPath = join(tmpdir(), `${catalog.id}.pdf`);
  await writeFile(pdfPath, pdfBuffer);

  // Fire-and-forget: processCatalog also saves the PDF to Supabase Storage
  processCatalog(catalog.id, pdfPath).catch(console.error);

  return NextResponse.json(catalog, { status: 201 });
}
