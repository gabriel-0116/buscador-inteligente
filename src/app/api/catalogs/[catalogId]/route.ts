import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";

type Params = { params: Promise<{ catalogId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { catalogId } = await params;

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    include: {
      supplier: { select: { id: true, name: true } },
      pages: {
        select: { id: true, imageUrl: true, pageNumber: true, width: true, height: true },
        orderBy: { pageNumber: "asc" },
      },
    },
  });

  if (!catalog) {
    return NextResponse.json({ error: "Catálogo não encontrado" }, { status: 404 });
  }

  return NextResponse.json(catalog);
}

export async function DELETE(_request: Request, { params }: Params) {
  const { catalogId } = await params;

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    select: {
      pdfStoragePath: true,
      pages: { select: { imageUrl: true } },
    },
  });

  if (!catalog) {
    return NextResponse.json({ error: "Catálogo não encontrado" }, { status: 404 });
  }

  // Public storage URLs are converted back to bucket-relative paths.
  // `pdfStoragePath` is already a bucket-relative path (e.g. "<id>/original/catalog.pdf"),
  // so it goes in raw without `pathFromUrl`.
  const pathFromUrl = (url: string) => {
    try {
      return new URL(url).pathname.replace(
        /^\/storage\/v1\/object\/public\/product-images\//,
        ""
      );
    } catch {
      return null;
    }
  };

  const allPaths = [
    catalog.pdfStoragePath ?? null,
    ...catalog.pages.map((p) => pathFromUrl(p.imageUrl)),
  ].filter((p): p is string => p !== null && p.length > 0);

  const uniquePaths = [...new Set(allPaths)];
  if (uniquePaths.length > 0) {
    await supabaseAdmin.storage.from("product-images").remove(uniquePaths);
  }

  await prisma.catalog.delete({ where: { id: catalogId } });

  return new NextResponse(null, { status: 204 });
}
