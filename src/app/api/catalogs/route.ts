import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function sanitizeFileName(fileName: string) {
  return fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim();
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const supplierId = String(formData.get("supplierId") ?? "").trim();
  const file = formData.get("file");

  if (!supplierId) {
    return NextResponse.json(
      { error: "Fornecedor é obrigatório." },
      { status: 400 },
    );
  }

  const supplier = await prisma.supplier.findUnique({
    where: {
      id: supplierId,
    },
    select: {
      id: true,
    },
  });

  if (!supplier) {
    return NextResponse.json(
      { error: "Fornecedor não encontrado." },
      { status: 404 },
    );
  }

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Arquivo PDF é obrigatório." },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "Arquivo vazio." }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      { error: "Arquivo muito grande. Limite atual: 100 MB." },
      { status: 400 },
    );
  }

  const fileName = sanitizeFileName(file.name || "catalogo.pdf");
  const isPdf =
    file.type === "application/pdf" || fileName.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return NextResponse.json(
      { error: "Envie apenas arquivos PDF." },
      { status: 400 },
    );
  }

  const catalogId = randomUUID();
  const storageRoot = process.env.LOCAL_STORAGE_DIR || "storage";
  const storedFileName = `${catalogId}.pdf`;

  const relativeDir = join("catalogs", supplierId);
  const relativePath = join(relativeDir, storedFileName);

  const absoluteDir = join(process.cwd(), storageRoot, relativeDir);
  const absolutePath = join(process.cwd(), storageRoot, relativePath);

  await mkdir(absoluteDir, {
    recursive: true,
  });

  const buffer = Buffer.from(await file.arrayBuffer());

  await writeFile(absolutePath, buffer);

  await prisma.catalog.create({
    data: {
      id: catalogId,
      supplierId,
      fileName,
      filePath: join(storageRoot, relativePath),
      fileSize: file.size,
      mimeType: file.type || "application/pdf",
      status: "DRAFT",
    },
  });

  return NextResponse.redirect(
    new URL(`/fornecedores/${supplierId}`, request.url),
    303,
  );
}
