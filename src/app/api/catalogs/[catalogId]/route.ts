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
      candidates: {
        select: {
          id: true,
          cropUrl: true,
          originalUrl: true,
          pageId: true,
          width: true,
          height: true,
          sourceType: true,
          cropX: true,
          cropY: true,
          cropWidth: true,
          cropHeight: true,
          confidence: true,
          detectedLabel: true,
          functionGroup: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
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
    include: {
      images: { select: { imageUrl: true } },
      pages: { select: { imageUrl: true } },
      candidates: { select: { cropUrl: true, originalUrl: true } },
    },
  });

  if (!catalog) {
    return NextResponse.json({ error: "Catálogo não encontrado" }, { status: 404 });
  }

  // Collect all storage paths to delete
  const pathFromUrl = (url: string) => {
    try {
      return new URL(url).pathname.replace(/^\/storage\/v1\/object\/public\/product-images\//, "");
    } catch {
      return null;
    }
  };

  const allPaths = [
    ...catalog.images.map((i) => pathFromUrl(i.imageUrl)),
    ...catalog.pages.map((p) => pathFromUrl(p.imageUrl)),
    ...catalog.candidates.flatMap((c) => [
      pathFromUrl(c.cropUrl),
      pathFromUrl(c.originalUrl),
    ]),
  ].filter((p): p is string => p !== null);

  const uniquePaths = [...new Set(allPaths)];
  if (uniquePaths.length > 0) {
    await supabaseAdmin.storage.from("product-images").remove(uniquePaths);
  }

  await prisma.catalog.delete({ where: { id: catalogId } });

  return new NextResponse(null, { status: 204 });
}
