import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type RawProductImageRouteContext = {
  params: Promise<{
    rawProductId: string;
  }>;
};

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

export async function GET(
  _request: NextRequest,
  context: RawProductImageRouteContext
) {
  const { rawProductId } = await context.params;

  const rawProduct = await prisma.rawProduct.findUnique({
    where: {
      id: rawProductId,
    },
    select: {
      imageUrl: true,
    },
  });

  if (!rawProduct?.imageUrl) {
    return NextResponse.json(
      {
        error: "Imagem do produto bruto não encontrada.",
      },
      {
        status: 404,
      }
    );
  }

  const imagePath = resolveProjectPath(rawProduct.imageUrl);
  const imageBuffer = await readFile(imagePath);

  return new NextResponse(new Uint8Array(imageBuffer), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
