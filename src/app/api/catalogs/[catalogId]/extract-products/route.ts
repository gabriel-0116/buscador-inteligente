import { NextRequest, NextResponse } from "next/server";
import { extractRawProductsFromCatalog } from "@/features/raw-products/extraction";

export const runtime = "nodejs";

type ExtractProductsRouteContext = {
  params: Promise<{
    catalogId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: ExtractProductsRouteContext
) {
  const { catalogId } = await context.params;

  try {
    await extractRawProductsFromCatalog(catalogId);

    return NextResponse.redirect(
      new URL(`/catalogos/${catalogId}`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao extrair produtos brutos do catálogo.",
      },
      {
        status: 500,
      }
    );
  }
}
