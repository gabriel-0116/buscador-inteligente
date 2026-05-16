import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";

type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

/**
 * Primeira versão: layout aproximado para páginas tipo catálogo em grade.
 * Isso NÃO é detector final.
 * Serve para validar: página -> cards -> RawProduct com imagem recortada.
 */
function generateApproximateProductCards(
  imageWidth: number,
  imageHeight: number
): BoundingBox[] {
  const boxes: BoundingBox[] = [];

  const leftMargin = Math.round(imageWidth * 0.02);
  const rightMargin = Math.round(imageWidth * 0.02);

  const topStart = Math.round(imageHeight * 0.19);
  const bottomEnd = Math.round(imageHeight * 0.88);

  const usableWidth = imageWidth - leftMargin - rightMargin;
  const usableHeight = bottomEnd - topStart;

  const columns = 3;
  const rows = 3;

  const gapX = Math.round(imageWidth * 0.035);
  const gapY = Math.round(imageHeight * 0.025);

  const cardWidth = Math.floor((usableWidth - gapX * (columns - 1)) / columns);
  const cardHeight = Math.floor((usableHeight - gapY * (rows - 1)) / rows);

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = leftMargin + column * (cardWidth + gapX);
      const y = topStart + row * (cardHeight + gapY);

      if (y + cardHeight > imageHeight) {
        continue;
      }

      boxes.push({
        x,
        y,
        width: cardWidth,
        height: cardHeight,
      });
    }
  }

  return boxes;
}

async function isMostlyBlankImage(imagePath: string) {
  const { data, info } = await sharp(imagePath)
    .resize(80, 80, {
      fit: "inside",
    })
    .removeAlpha()
    .raw()
    .toBuffer({
      resolveWithObject: true,
    });

  let brightPixels = 0;
  const totalPixels = info.width * info.height;

  for (let index = 0; index < data.length; index += 3) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];

    if (red > 245 && green > 245 && blue > 245) {
      brightPixels++;
    }
  }

  const brightRatio = brightPixels / totalPixels;

  return brightRatio > 0.92;
}

export async function generateRawProductCardsFromPage(pageId: string) {
  const page = await prisma.catalogPage.findUnique({
    where: {
      id: pageId,
    },
    include: {
      catalog: true,
    },
  });

  if (!page) {
    throw new Error("Página não encontrada.");
  }

  if (!page.imageUrl) {
    throw new Error("Página não possui imagem.");
  }

  const imagePath = resolveProjectPath(page.imageUrl);
  const image = sharp(imagePath);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Não foi possível ler as dimensões da imagem.");
  }

  const storageRoot = process.env.LOCAL_STORAGE_DIR || "storage";
  const outputRelativeDir = join("raw-products", page.catalogId, page.id);
  const outputAbsoluteDir = join(process.cwd(), storageRoot, outputRelativeDir);

  await prisma.rawProduct.deleteMany({
    where: {
      catalogPageId: page.id,
    },
  });

  await rm(outputAbsoluteDir, {
    recursive: true,
    force: true,
  });

  await mkdir(outputAbsoluteDir, {
    recursive: true,
  });

  const boxes = generateApproximateProductCards(
    metadata.width,
    metadata.height
  );

  let createdCount = 0;

  for (let index = 0; index < boxes.length; index++) {
    const box = boxes[index];
    const temporaryCardNumber = index + 1;
    const paddedTemporaryCardNumber = String(temporaryCardNumber).padStart(
      2,
      "0"
    );

    const temporaryFileName = `card-${paddedTemporaryCardNumber}.png`;
    const temporaryRelativePath = join(outputRelativeDir, temporaryFileName);
    const temporaryAbsolutePath = join(outputAbsoluteDir, temporaryFileName);

    await sharp(imagePath)
      .extract({
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
      })
      .png()
      .toFile(temporaryAbsolutePath);

    const isBlank = await isMostlyBlankImage(temporaryAbsolutePath);

    if (isBlank) {
      await rm(temporaryAbsolutePath, {
        force: true,
      });

      continue;
    }

    createdCount++;

    await prisma.rawProduct.create({
      data: {
        catalogPageId: page.id,
        imageUrl: join(storageRoot, temporaryRelativePath),
        boundingBox: box,
        translatedNamePt: `Produto recortado ${createdCount}`,
        translatedDescriptionPt:
          "Card de produto recortado automaticamente. Revisar antes de aprovar.",
        status: "PENDING_REVIEW",
        confidence: 0.3,
      },
    });
  }

  return {
    created: createdCount,
  };
}
