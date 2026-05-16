import { NextRequest, NextResponse } from "next/server";
import { runRawProductCardsOcrFromPage } from "@/features/raw-products/card-ocr";

export const runtime = "nodejs";

type OcrCardsRouteContext = {
  params: Promise<{
    pageId: string;
  }>;
};

export async function POST(
  request: NextRequest,
  context: OcrCardsRouteContext
) {
  const { pageId } = await context.params;

  try {
    await runRawProductCardsOcrFromPage(pageId);

    return NextResponse.redirect(
      new URL(`/paginas/${pageId}`, request.url),
      303
    );
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error: "Erro ao executar OCR nos cards da página.",
      },
      {
        status: 500,
      }
    );
  }
}
