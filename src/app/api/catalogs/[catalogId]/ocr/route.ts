import { NextRequest, NextResponse } from "next/server";
import { runCatalogOcr } from "@/features/catalogs/ocr";

export const runtime = "nodejs";

type CatalogOcrRouteContext = {
  params: Promise<{
    catalogId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: CatalogOcrRouteContext
) {
  const { catalogId } = await context.params;

  try {
    await runCatalogOcr(catalogId);

    return NextResponse.redirect(
      new URL(`/catalogos/${catalogId}`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao executar OCR no catálogo.",
      },
      {
        status: 500,
      }
    );
  }
}
