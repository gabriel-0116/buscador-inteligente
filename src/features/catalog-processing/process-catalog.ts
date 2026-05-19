import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";
import { generateImageEmbeddingFromPath } from "@/features/visual-search/embeddings";
import { extractImagesFromPdf } from "./extract-images";
import { isValidProductImage } from "./filter-images";

export async function processCatalog(
  catalogId: string,
  pdfPath: string
): Promise<void> {
  const outputDir = join(tmpdir(), catalogId);

  try {
    const imagePaths = await extractImagesFromPdf(pdfPath, outputDir);

    let imageCount = 0;

    for (const imagePath of imagePaths) {
      try {
        const valid = await isValidProductImage(imagePath);
        if (!valid) continue;

        const [metadata, fileStat] = await Promise.all([
          sharp(imagePath).metadata(),
          stat(imagePath),
        ]);

        const jpegBuffer = await sharp(imagePath).jpeg({ quality: 85 }).toBuffer();

        const fileName = `img-${String(imageCount + 1).padStart(3, "0")}.jpg`;
        const storagePath = `${catalogId}/${fileName}`;

        const { error: uploadError } = await supabaseAdmin.storage
          .from("product-images")
          .upload(storagePath, jpegBuffer, {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (uploadError) {
          console.error(`Upload falhou para ${fileName}:`, uploadError.message);
          continue;
        }

        const imageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/product-images/${storagePath}`;

        // Generate embedding from original file (sharp reads ppm/jpg/png)
        const embedding = await generateImageEmbeddingFromPath(imagePath);
        const vectorStr = `[${embedding.join(",")}]`;

        const image = await prisma.productImage.create({
          data: {
            catalogId,
            imageUrl,
            width: metadata.width!,
            height: metadata.height!,
            fileSize: fileStat.size,
          },
        });

        // embedding is Unsupported("vector(512)") — must use raw SQL
        await prisma.$executeRaw`
          UPDATE "ProductImage"
          SET embedding = ${vectorStr}::vector
          WHERE id = ${image.id}
        `;

        imageCount++;
      } catch (err) {
        console.error(`Erro ao processar ${imagePath}:`, err);
      }
    }

    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "READY", imageCount },
    });
  } catch (error) {
    console.error(`Falha ao processar catálogo ${catalogId}:`, error);
    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "FAILED", error: String(error) },
    });
  } finally {
    await Promise.allSettled([
      rm(outputDir, { recursive: true, force: true }),
      rm(pdfPath, { force: true }),
    ]);
  }
}
