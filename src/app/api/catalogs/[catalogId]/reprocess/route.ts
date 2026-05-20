import { NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { processCatalog } from "@/features/catalog-processing/process-catalog";

type Params = { params: Promise<{ catalogId: string }> };

function pathFromUrl(url: string): string | null {
  try {
    return new URL(url).pathname.replace(
      /^\/storage\/v1\/object\/public\/product-images\//,
      ""
    );
  } catch {
    return null;
  }
}

export async function POST(_request: Request, { params }: Params) {
  const { catalogId } = await params;

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    include: {
      pages: { select: { imageUrl: true } },
      candidates: { select: { cropUrl: true, originalUrl: true, cardUrl: true } },
    },
  });

  if (!catalog) {
    return NextResponse.json({ error: "Catálogo não encontrado" }, { status: 404 });
  }

  if (!catalog.pdfStoragePath) {
    return NextResponse.json(
      {
        error:
          "PDF original não encontrado no storage. Re-envie o arquivo PDF para reprocessar.",
      },
      { status: 422 }
    );
  }

  // ── Delete old storage files ─────────────────────────────────────────────
  const storagePaths = [
    ...catalog.pages.map((p) => pathFromUrl(p.imageUrl)),
    ...catalog.candidates.flatMap((c) => [
      pathFromUrl(c.cropUrl),
      c.cardUrl ? pathFromUrl(c.cardUrl) : null,
    ]),
  ].filter((p): p is string => p !== null);

  const uniquePaths = [...new Set(storagePaths)];
  if (uniquePaths.length > 0) {
    await supabaseAdmin.storage.from("product-images").remove(uniquePaths);
  }

  // ── Delete old DB records (pages + candidates) ───────────────────────────
  await prisma.productCandidate.deleteMany({ where: { catalogId } });
  await prisma.catalogPage.deleteMany({ where: { catalogId } });

  // ── Mark as PROCESSING ───────────────────────────────────────────────────
  await prisma.catalog.update({
    where: { id: catalogId },
    data: {
      status: "PROCESSING",
      error: null,
      pageCount: null,
      candidateCount: null,
    },
  });

  // ── Download PDF and reprocess ───────────────────────────────────────────
  const { data: pdfData, error: downloadError } = await supabaseAdmin.storage
    .from("product-images")
    .download(catalog.pdfStoragePath);

  if (downloadError || !pdfData) {
    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "FAILED", error: "Falha ao baixar PDF do storage para reprocessamento." },
    });
    return NextResponse.json(
      { error: "Falha ao baixar PDF do storage." },
      { status: 500 }
    );
  }

  const pdfBuffer = Buffer.from(await pdfData.arrayBuffer());
  const pdfPath = join(tmpdir(), `${catalogId}-reprocess.pdf`);
  await writeFile(pdfPath, pdfBuffer);

  // Fire-and-forget
  processCatalog(catalogId, pdfPath).catch(console.error);

  return NextResponse.json({ ok: true, message: "Reprocessamento iniciado." });
}
