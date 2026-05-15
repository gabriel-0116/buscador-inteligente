import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type CatalogPageImageRouteContext = {
  params: Promise<{
    pageId: string;
  }>;
};

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

export async function GET(
  _request: NextRequest,
  context: CatalogPageImageRouteContext,
) {
  const { pageId } = await context.params;

  const page = await prisma.catalogPage.findUnique({
    where: {
      id: pageId,
    },
    select: {
      imageUrl: true,
    },
  });

  if (!page?.imageUrl) {
    return NextResponse.json(
      {
        error: "Imagem da página não encontrada.",
      },
      {
        status: 404,
      },
    );
  }

  const imagePath = resolveProjectPath(page.imageUrl);
  const imageBuffer = await readFile(imagePath);

  return new NextResponse(new Uint8Array(imageBuffer), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
