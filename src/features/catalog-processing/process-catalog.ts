import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { uploadImageToStorage, supabaseAdmin } from "@/lib/supabase";
import { generateImageEmbeddingFromPath } from "@/features/visual-search/embeddings";
import { renderPdfPagesToImages } from "./render-pages";
import { detectProductCandidatesFromPage } from "./detect-product-candidates";

export async function processCatalog(
  catalogId: string,
  pdfPath: string
): Promise<void> {
  const baseDir = join(tmpdir(), catalogId);
  const pagesDir = join(baseDir, "pages");
  const candidatesDir = join(baseDir, "candidates");

  try {
    // ── Save original PDF to Supabase Storage ──────────────────────────────
    const pdfBuffer = await readFile(pdfPath);
    const pdfStoragePath = `${catalogId}/original/catalog.pdf`;
    const { error: pdfUploadError } = await supabaseAdmin.storage
      .from("product-images")
      .upload(pdfStoragePath, pdfBuffer, { contentType: "application/pdf", upsert: true });

    if (pdfUploadError) {
      console.warn(`Aviso: não foi possível salvar PDF original: ${pdfUploadError.message}`);
    } else {
      await prisma.catalog.update({
        where: { id: catalogId },
        data: { pdfStoragePath },
      });
    }

    const renderedPages = await renderPdfPagesToImages(pdfPath, pagesDir);

    let pageCount = 0;
    let candidateCount = 0;

    for (const { pageNumber, imagePath } of renderedPages) {
      try {
        // ── Save rendered page ──────────────────────────────────────────────
        const [pageMeta, pageBuffer] = await Promise.all([
          sharp(imagePath).metadata(),
          sharp(imagePath)
            .flatten({ background: { r: 255, g: 255, b: 255 } })
            .jpeg({ quality: 85 })
            .toBuffer(),
        ]);

        const pageStoragePath = `${catalogId}/pages/page-${String(pageNumber).padStart(3, "0")}.jpg`;
        const pageUrl = await uploadImageToStorage(pageStoragePath, pageBuffer);

        const catalogPage = await prisma.catalogPage.create({
          data: {
            catalogId,
            pageNumber,
            imageUrl: pageUrl,
            width: pageMeta.width ?? 0,
            height: pageMeta.height ?? 0,
          },
        });

        pageCount++;

        // ── Detect candidates ───────────────────────────────────────────────
        const candidates = await detectProductCandidatesFromPage({
          pageImagePath: imagePath,
          outputDir: candidatesDir,
          pageNumber,
        });

        for (const candidate of candidates) {
          try {
            const [cropMeta, cropStat, cropBuffer] = await Promise.all([
              sharp(candidate.imagePath).metadata(),
              stat(candidate.imagePath),
              readFile(candidate.imagePath),
            ]);

            const candidateIndex = candidateCount + 1;
            const cropStoragePath = `${catalogId}/candidates/candidate-${String(candidateIndex).padStart(4, "0")}.jpg`;
            const cropUrl = await uploadImageToStorage(cropStoragePath, cropBuffer);

            // Upload card image if it exists
            let cardUrl: string | undefined;
            if (candidate.cardImagePath) {
              try {
                const cardBuffer = await readFile(candidate.cardImagePath);
                const cardStoragePath = `${catalogId}/candidates/card-${String(candidateIndex).padStart(4, "0")}.jpg`;
                cardUrl = await uploadImageToStorage(cardStoragePath, cardBuffer);
              } catch {
                // Card image is optional — ignore failure
              }
            }

            const record = await prisma.productCandidate.create({
              data: {
                catalogId,
                pageId: catalogPage.id,
                originalUrl: pageUrl,
                cropUrl,
                cardUrl,
                width: cropMeta.width ?? candidate.width,
                height: cropMeta.height ?? candidate.height,
                fileSize: cropStat.size,
                sourceType: "PAGE_CROP",
                cropX: candidate.x,
                cropY: candidate.y,
                cropWidth: candidate.width,
                cropHeight: candidate.height,
                confidence: candidate.confidence,
                isSearchable: candidate.isSearchable,
                qualityScore: candidate.qualityScore,
                rejectReason: candidate.rejectReason,
              },
            });

            // Only generate embedding for searchable crops with sufficient quality
            if (candidate.isSearchable && candidate.qualityScore >= 0.50) {
              const embedding = await generateImageEmbeddingFromPath(candidate.imagePath);
              const vectorStr = `[${embedding.join(",")}]`;
              await prisma.$executeRaw`
                UPDATE "ProductCandidate"
                SET embedding = ${vectorStr}::vector
                WHERE id = ${record.id}
              `;
            }

            candidateCount++;
          } catch (err) {
            console.error(`Erro ao processar candidato (pág. ${pageNumber}):`, err);
          }
        }
      } catch (err) {
        console.error(`Erro ao processar página ${pageNumber}:`, err);
      }
    }

    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "READY", pageCount, candidateCount },
    });
  } catch (error) {
    console.error(`Falha ao processar catálogo ${catalogId}:`, error);
    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "FAILED", error: String(error) },
    });
  } finally {
    await Promise.allSettled([
      rm(baseDir, { recursive: true, force: true }),
      rm(pdfPath, { force: true }),
    ]);
  }
}
