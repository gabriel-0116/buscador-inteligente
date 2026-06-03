import { NextResponse } from "next/server";
import { generateImageEmbeddingFromFile } from "@/features/visual-search/embeddings";
import { analyzeImageQueryProfileFromFile } from "@/features/visual-search/query-image-analyzer";
import { searchPagesByQueryProfile } from "@/features/semantic-search/page-search";

const MAX_SIZE = 8 * 1024 * 1024;

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

  try {
    // Run the structured profile (multimodal) and the DINOv2 visual
    // embedding in parallel — both consume the same File but are
    // independent calls. Visual is the *supporting* signal and is allowed
    // to fail without aborting the search.
    const [{ profile }, queryVisualEmbedding] = await Promise.all([
      analyzeImageQueryProfileFromFile(image),
      generateImageEmbeddingFromFile(image).catch((err) => {
        console.warn("[search] visual embedding failed:", err);
        return undefined as number[] | undefined;
      }),
    ]);
    const results = await searchPagesByQueryProfile({
      profile,
      queryVisualEmbedding,
    });
    return NextResponse.json({ profile, results });
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
