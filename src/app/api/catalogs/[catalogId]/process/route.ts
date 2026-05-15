import { NextRequest, NextResponse } from "next/server";
import { processCatalogPages } from "@/features/catalogs/processing";

export const runtime = "nodejs";

type ProcessCatalogRouteContext = {
  params: Promise<{
    catalogId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: ProcessCatalogRouteContext
) {
  const { catalogId } = await context.params;

  try {
    await processCatalogPages(catalogId);

    return NextResponse.redirect(
      new URL(`/catalogos/${catalogId}`, request.url)
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao processar páginas do catálogo.",
      },
      {
        status: 500,
      }
    );
  }
}