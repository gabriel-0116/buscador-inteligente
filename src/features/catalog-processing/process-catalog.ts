import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Prisma } from "@prisma/client";
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
        const { candidates, pageAnalysis } = await detectProductCandidatesFromPage({
          pageImagePath: imagePath,
          outputDir: candidatesDir,
          pageNumber,
        });

        // Persist the raw analysis for auditing / future retries.
        if (pageAnalysis.rawJson !== undefined || pageAnalysis.error) {
          try {
            await prisma.pageAnalysis.create({
              data: {
                catalogId,
                pageId: catalogPage.id,
                pageNumber,
                provider: pageAnalysis.provider,
                model: pageAnalysis.model,
                productsCount: pageAnalysis.productsCount,
                error: pageAnalysis.error,
                rawJson:
                  (pageAnalysis.rawJson as Prisma.InputJsonValue | undefined) ??
                  ({ products: [] } as Prisma.InputJsonValue),
              },
            });
          } catch (err) {
            console.error(
              `Erro ao salvar PageAnalysis (pág. ${pageNumber}):`,
              err
            );
          }
        }

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

            // Upload card image if the detector provided a separate one.
            // MVP: detector emits one card-shaped crop per product and leaves
            // cardImagePath undefined → cardUrl falls back to cropUrl.
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
                cardUrl: cardUrl ?? cropUrl,
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
                // Vision-detector metadata (undefined when heuristic-only).
                productName: candidate.productName,
                productNamePt: candidate.productNamePt,
                category: candidate.category,
                functionGroup: candidate.functionGroup,
                model: candidate.model,
                originalText: candidate.originalText,
                descriptionPt: candidate.descriptionPt,
                sourceDetector: candidate.sourceDetector,
                visionConfidence: candidate.visionConfidence,
                rawVisionJson: candidate.rawVisionJson as
                  | Prisma.InputJsonValue
                  | undefined,
              },
            });

            // Only generate embedding for searchable crops with sufficient quality.
            // The gate matches detect-product-candidates' QUALITY_THRESHOLD (0.60).
            if (candidate.isSearchable && candidate.qualityScore >= 0.6) {
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
