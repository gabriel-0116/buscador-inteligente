import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

async function runTesseract(imagePath: string) {
  const { stdout } = await execFileAsync("tesseract", [
    imagePath,
    "stdout",
    "-l",
    "por+eng+chi_sim",
  ]);

  return stdout.trim();
}

export async function runCatalogOcr(catalogId: string) {
  const catalog = await prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    include: {
      pages: {
        orderBy: {
          pageNumber: "asc",
        },
      },
    },
  });

  if (!catalog) {
    throw new Error("Catálogo não encontrado.");
  }

  if (catalog.pages.length === 0) {
    throw new Error("Catálogo ainda não possui páginas processadas.");
  }

  let processedPages = 0;

  for (const page of catalog.pages) {
    if (!page.imageUrl) {
      continue;
    }

    const imagePath = resolveProjectPath(page.imageUrl);
    const rawText = await runTesseract(imagePath);

    await prisma.catalogPage.update({
      where: {
        id: page.id,
      },
      data: {
        rawText,
      },
    });

    processedPages++;
  }

  return {
    processedPages,
  };
}
