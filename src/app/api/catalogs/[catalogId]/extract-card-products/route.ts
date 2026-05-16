import { NextRequest, NextResponse } from "next/server";
import { extractProductsFromCatalog } from "@/features/catalogs/product-extraction";

export const runtime = "nodejs";

type ExtractCardProductsRouteContext = {
  params: Promise<{
    catalogId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: ExtractCardProductsRouteContext
) {
  const { catalogId } = await context.params;

  try {
    await extractProductsFromCatalog(catalogId);

    return NextResponse.redirect(
      new URL(`/catalogos/${catalogId}/revisao`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao extrair produtos do catálogo.",
      },
      {
        status: 500,
      }
    );
  }
}
