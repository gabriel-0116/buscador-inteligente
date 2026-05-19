import { NextRequest, NextResponse } from "next/server";
import { analyzeImageForProductSearch } from "@/features/image-search/analyze-image";
import { searchRawProductsByVisualSimilarity } from "@/features/visual-search/search";

export const runtime = "nodejs";

const MAX_IMAGE_SIZE_MB = 8;
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const image = formData.get("image");

    if (!(image instanceof File)) {
      return NextResponse.json(
        {
          error: "Envie uma imagem válida.",
        },
        {
          status: 400,
        }
      );
    }

    if (!image.type.startsWith("image/")) {
      return NextResponse.json(
        {
          error: "O arquivo enviado precisa ser uma imagem.",
        },
        {
          status: 400,
        }
      );
    }

    if (image.size > MAX_IMAGE_SIZE_BYTES) {
      return NextResponse.json(
        {
          error: `A imagem precisa ter no máximo ${MAX_IMAGE_SIZE_MB}MB.`,
        },
        {
          status: 400,
        }
      );
    }

    const analysis = await analyzeImageForProductSearch(image).catch(
      (error) => {
        console.error("Erro ao analisar imagem para ranking híbrido:", error);
        return null;
      }
    );

    const results = await searchRawProductsByVisualSimilarity({
      image,
      analysis,
      take: 8,
      visualCandidatePool: 120,
    });

    return NextResponse.json({
      mode: "hybrid_visual",
      analysis: analysis ?? {
        productName: "Busca visual por similaridade",
        category: null,
        function:
          "Comparação visual entre a imagem enviada e os recortes dos catálogos.",
        visibleCodes: [],
        searchTerms: [],
        confidence: null,
        notes:
          "Resultado gerado por similaridade visual. A análise da imagem não foi usada nesta busca.",
      },
      searchTerms: analysis?.searchTerms ?? ["similaridade visual"],
      results,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Erro ao buscar por similaridade visual.",
      },
      {
        status: 500,
      }
    );
  }
}
