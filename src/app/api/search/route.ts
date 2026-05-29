import { NextResponse } from "next/server";
import { generateImageEmbeddingFromFile } from "@/features/visual-search/embeddings";
import { searchSimilarImages } from "@/features/visual-search/search";
import { analyzeImageQueryProfileFromFile } from "@/features/visual-search/query-image-analyzer";
import { searchPagesByQueryProfile } from "@/features/semantic-search/page-search";

const MAX_SIZE = 8 * 1024 * 1024;

function getSearchMode(): "page_mentions" | "legacy_candidates" {
  const raw = (process.env.SEARCH_MODE || "page_mentions").toLowerCase().trim();
  if (raw === "legacy_candidates") return "legacy_candidates";
  return "page_mentions";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const image = formData.get("image") as File | null;

  if (!image) {
    return NextResponse.json({ error: "Imagem é obrigatória" }, { status: 400 });
  }
  if (!image.type.startsWith("image/")) {
    return NextResponse.json(
      { error: "O arquivo deve ser uma imagem" },
      { status: 400 }
    );
  }
  if (image.size > MAX_SIZE) {
    return NextResponse.json(
      { error: "Imagem deve ter menos de 8MB" },
      { status: 400 }
    );
  }

  const mode = getSearchMode();

  if (mode === "page_mentions") {
    try {
      const { profile } = await analyzeImageQueryProfileFromFile(image);
      const results = await searchPagesByQueryProfile({ profile });
      return NextResponse.json({ mode, profile, results });
    } catch (err) {
      console.error("[search] page_mentions failed:", err);
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Falha ao analisar imagem de busca",
        },
        { status: 500 }
      );
    }
  }

  // Legacy: DINOv2 → ProductCandidate cosine search.
  const embedding = await generateImageEmbeddingFromFile(image);
  const results = await searchSimilarImages(embedding);
  return NextResponse.json({ mode, results });
}
