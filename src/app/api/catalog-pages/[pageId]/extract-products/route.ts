import { NextRequest, NextResponse } from "next/server";
import { extractRawProductsFromPage } from "@/features/raw-products/extraction";

export const runtime = "nodejs";

type ExtractPageProductsRouteContext = {
  params: Promise<{
    pageId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: ExtractPageProductsRouteContext
) {
  const { pageId } = await context.params;

  try {
    await extractRawProductsFromPage(pageId);

    return NextResponse.redirect(
      new URL(`/paginas/${pageId}`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao extrair produtos brutos da página.",
      },
      {
        status: 500,
      }
    );
  }
}
