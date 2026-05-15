import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type DeleteCatalogRouteContext = {
  params: Promise<{
    catalogId: string;
  }>;
};

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

async function safeRemove(path: string | null | undefined) {
  if (!path) return;

  await rm(resolveProjectPath(path), {
    force: true,
    recursive: true,
  });
}

export async function POST(
  request: NextRequest,
  context: DeleteCatalogRouteContext,
) {
  const { catalogId } = await context.params;

  const catalog = await prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    select: {
      id: true,
      supplierId: true,
      filePath: true,
    },
  });

  if (!catalog) {
    return NextResponse.json(
      {
        error: "Catálogo não encontrado.",
      },
      {
        status: 404,
      },
    );
  }

  const storageRoot = process.env.LOCAL_STORAGE_DIR || "storage";
  const generatedPagesPath = join(storageRoot, "catalog-pages", catalog.id);

  await prisma.catalog.delete({
    where: {
      id: catalog.id,
    },
  });

  await safeRemove(catalog.filePath);
  await safeRemove(generatedPagesPath);

  return NextResponse.redirect(
    new URL(`/fornecedores/${catalog.supplierId}`, request.url),
    303,
  );
}
