import { NextRequest, NextResponse } from "next/server";
import { generateRawProductCardsFromPage } from "@/features/raw-products/card-extraction";

export const runtime = "nodejs";

type GenerateCardsRouteContext = {
  params: Promise<{
    pageId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: GenerateCardsRouteContext
) {
  const { pageId } = await context.params;

  try {
    await generateRawProductCardsFromPage(pageId);

    return NextResponse.redirect(
      new URL(`/paginas/${pageId}`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao gerar recortes de produtos.",
      },
      {
        status: 500,
      }
    );
  }
}
