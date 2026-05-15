import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { prisma } from "@/lib/prisma";

const execFileAsync = promisify(execFile);

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

async function getPdfPageCount(pdfPath: string) {
  const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);

  const match = stdout.match(/^Pages:\s+(\d+)/m);

  if (!match) {
    throw new Error("Não foi possível identificar a quantidade de páginas.");
  }

  return Number(match[1]);
}

export async function processCatalogPages(catalogId: string) {
  const catalog = await prisma.catalog.findUnique({
    where: {
      id: catalogId,
    },
    select: {
      id: true,
      filePath: true,
    },
  });

  if (!catalog) {
    throw new Error("Catálogo não encontrado.");
  }

  if (!catalog.filePath) {
    throw new Error("Catálogo não possui arquivo local salvo.");
  }

  const pdfPath = resolveProjectPath(catalog.filePath);
  const storageRoot = process.env.LOCAL_STORAGE_DIR || "storage";

  const outputRelativeDir = join("catalog-pages", catalog.id);
  const outputAbsoluteDir = join(process.cwd(), storageRoot, outputRelativeDir);

  await prisma.catalog.update({
    where: {
      id: catalog.id,
    },
    data: {
      status: "PROCESSING",
    },
  });

  try {
    await mkdir(outputAbsoluteDir, {
      recursive: true,
    });

    const pageCount = await getPdfPageCount(pdfPath);

    await prisma.catalogPage.deleteMany({
      where: {
        catalogId: catalog.id,
      },
    });

    const pagesToCreate = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const paddedPageNumber = String(pageNumber).padStart(3, "0");
      const fileName = `page-${paddedPageNumber}.png`;
      const outputPrefix = join(outputAbsoluteDir, `page-${paddedPageNumber}`);
      const imageRelativePath = join(storageRoot, outputRelativeDir, fileName);

      await execFileAsync("pdftoppm", [
        "-png",
        "-r",
        "144",
        "-f",
        String(pageNumber),
        "-l",
        String(pageNumber),
        "-singlefile",
        pdfPath,
        outputPrefix,
      ]);

      pagesToCreate.push({
        catalogId: catalog.id,
        pageNumber,
        imageUrl: imageRelativePath,
      });
    }

    await prisma.catalogPage.createMany({
      data: pagesToCreate,
    });

    await prisma.catalog.update({
      where: {
        id: catalog.id,
      },
      data: {
        status: "READY_FOR_REVIEW",
        pageCount,
      },
    });

    return {
      pageCount,
    };
  } catch (error) {
    await prisma.catalog.update({
      where: {
        id: catalog.id,
      },
      data: {
        status: "FAILED",
      },
    });

    throw error;
  }
}