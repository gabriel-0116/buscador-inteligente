import { NextRequest, NextResponse } from "next/server";
import {
  getVisualIndexStatus,
  indexRawProductVisualEmbeddings,
} from "@/features/visual-search/indexing";

export const runtime = "nodejs";

export async function GET() {
  const status = await getVisualIndexStatus();

  return NextResponse.json(status);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      limit?: number;
      reindex?: boolean;
    };

    const limit =
      typeof body.limit === "number" && body.limit > 0 ? body.limit : 100;

    const result = await indexRawProductVisualEmbeddings({
      limit,
      reindex: Boolean(body.reindex),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Erro ao indexar busca visual.",
      },
      {
        status: 500,
      }
    );
  }
}
