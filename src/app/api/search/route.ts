import { NextResponse } from "next/server";
import { generateImageEmbeddingFromFile } from "@/features/visual-search/embeddings";
import { searchSimilarImages } from "@/features/visual-search/search";

const MAX_SIZE = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const formData = await request.formData();
  const image = formData.get("image") as File | null;

  if (!image) {
    return NextResponse.json({ error: "Imagem é obrigatória" }, { status: 400 });
  }

  if (!image.type.startsWith("image/")) {
    return NextResponse.json({ error: "O arquivo deve ser uma imagem" }, { status: 400 });
  }

  if (image.size > MAX_SIZE) {
    return NextResponse.json({ error: "Imagem deve ter menos de 8MB" }, { status: 400 });
  }

  const embedding = await generateImageEmbeddingFromFile(image);
  const results = await searchSimilarImages(embedding);

  return NextResponse.json(results);
}
