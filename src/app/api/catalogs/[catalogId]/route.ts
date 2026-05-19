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
      images: {
        select: { id: true, imageUrl: true, width: true, height: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!catalog) {
    return NextResponse.json(
      { error: "Catálogo não encontrado" },
      { status: 404 }
    );
  }

  return NextResponse.json(catalog);
}

export async function DELETE(_request: Request, { params }: Params) {
  const { catalogId } = await params;

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    include: { images: { select: { imageUrl: true } } },
  });

  if (!catalog) {
    return NextResponse.json(
      { error: "Catálogo não encontrado" },
      { status: 404 }
    );
  }

  if (catalog.images.length > 0) {
    const storagePaths = catalog.images.map((img) => {
      const url = new URL(img.imageUrl);
      return url.pathname.replace(
        /^\/storage\/v1\/object\/public\/product-images\//,
        ""
      );
    });
    await supabaseAdmin.storage.from("product-images").remove(storagePaths);
  }

  await prisma.catalog.delete({ where: { id: catalogId } });

  return new NextResponse(null, { status: 204 });
}
