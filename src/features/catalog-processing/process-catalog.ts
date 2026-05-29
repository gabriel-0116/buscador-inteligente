import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadImageToStorage, supabaseAdmin } from "@/lib/supabase";
import { generateImageEmbeddingFromPath } from "@/features/visual-search/embeddings";
import { renderPdfPagesToImages } from "./render-pages";
import {
  detectProductCandidatesFromPage,
  type DetectionDecision,
} from "./detect-product-candidates";
import { extractPdfLayout, type PdfLayoutPage } from "./pdf-layout-extractor";
import {
  getMaxVisionPagesPerCatalog,
  getVisionMode,
} from "./vision-json-detector";
import {
  analyzeCatalogPageProducts,
  buildPageProductSearchText,
  isPageAnalyzerConfigured,
} from "./page-product-analyzer";
import {
  generateTextEmbeddings,
  toPgVectorLiteral,
} from "@/features/semantic-search/text-embeddings";

// ── Processing mode ──────────────────────────────────────────────────────────
//
// `page_mentions` (default, new): page is the visual result; products are
// detected as PageProductMention rows with textual embeddings. No crops.
//
// `legacy_crops`: the old detector cascade — kept temporarily so we don't
// break existing scripts/UI that depend on ProductCandidate.

export type CatalogProcessingMode = "page_mentions" | "legacy_crops";

export function getCatalogProcessingMode(): CatalogProcessingMode {
  const raw = (
    process.env.CATALOG_PROCESSING_MODE || "page_mentions"
  )
    .toLowerCase()
    .trim();
  if (raw === "legacy_crops") return "legacy_crops";
  return "page_mentions";
}

// ── Public entry point ──────────────────────────────────────────────────────

export async function processCatalog(
  catalogId: string,
  pdfPath: string
): Promise<void> {
  const mode = getCatalogProcessingMode();
  const baseDir = join(tmpdir(), catalogId);
  const pagesDir = join(baseDir, "pages");
  const candidatesDir = join(baseDir, "candidates");

  try {
    // ── Look up catalog + supplier metadata (cheap, used by both modes) ──
    const catalogRow = await prisma.catalog.findUnique({
      where: { id: catalogId },
      select: {
        fileName: true,
        supplier: { select: { name: true } },
      },
    });
    const supplierName = catalogRow?.supplier?.name;
    const catalogFileName = catalogRow?.fileName;

    // ── Save original PDF to Supabase Storage ──────────────────────────────
    const pdfBuffer = await readFile(pdfPath);
    const pdfStoragePath = `${catalogId}/original/catalog.pdf`;
    const { error: pdfUploadError } = await supabaseAdmin.storage
      .from("product-images")
      .upload(pdfStoragePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (pdfUploadError) {
      console.warn(
        `Aviso: não foi possível salvar PDF original: ${pdfUploadError.message}`
      );
    } else {
      await prisma.catalog.update({
        where: { id: catalogId },
        data: { pdfStoragePath },
      });
    }

    const renderedPages = await renderPdfPagesToImages(pdfPath, pagesDir);

    // ── Extract PDF structure once (best-effort) ───────────────────────────
    const layout = await extractPdfLayout({ pdfPath, outputDir: baseDir });
    const layoutByPage = new Map<number, PdfLayoutPage>();
    if (layout) {
      for (const page of layout.pages) layoutByPage.set(page.pageNumber, page);
      console.log(
        `[catalog ${catalogId}] pdf-layout: ${layout.pages.length} pages extracted`
      );
    } else {
      console.warn(
        `[catalog ${catalogId}] pdf-layout unavailable → analyzer/heuristic only`
      );
    }

    console.log(
      `[catalog ${catalogId}] mode=${mode} totalPages=${renderedPages.length}`
    );

    if (mode === "page_mentions") {
      await processInPageMentionsMode({
        catalogId,
        renderedPages,
        layoutByPage,
        supplierName,
        catalogFileName,
      });
    } else {
      await processInLegacyCropsMode({
        catalogId,
        renderedPages,
        layoutByPage,
        candidatesDir,
      });
    }

    await prisma.catalog.update({
      where: { id: catalogId },
      data: { status: "READY" },
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

// ── Page-mentions mode ──────────────────────────────────────────────────────

async function processInPageMentionsMode(args: {
  catalogId: string;
  renderedPages: Array<{ pageNumber: number; imagePath: string }>;
  layoutByPage: Map<number, PdfLayoutPage>;
  supplierName: string | undefined;
  catalogFileName: string | undefined;
}): Promise<void> {
  const { catalogId, renderedPages, layoutByPage, supplierName, catalogFileName } =
    args;

  const analyzerReady = isPageAnalyzerConfigured();
  if (!analyzerReady) {
    console.warn(
      `[catalog ${catalogId}] page-mentions mode: analyzer not configured (VISION_DETECTOR_PROVIDER/API_KEY/MODEL or PAGE_ANALYZER_MODEL). Pages will be saved without products.`
    );
  }

  let pageCount = 0;
  let mentionCount = 0;
  let analyzedPages = 0;
  let emptyPages = 0;

  for (const { pageNumber, imagePath } of renderedPages) {
    try {
      const [pageMeta, pageBuffer] = await Promise.all([
        sharp(imagePath).metadata(),
        sharp(imagePath)
          .flatten({ background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality: 85 })
          .toBuffer(),
      ]);

      const pageStoragePath = `${catalogId}/pages/page-${String(
        pageNumber
      ).padStart(3, "0")}.jpg`;
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

      if (!analyzerReady) continue;

      // ── Analyze page ─────────────────────────────────────────────────────
      const pageLayout = layoutByPage.get(pageNumber);
      const pdfTextBlocks = pageLayout
        ? pageLayout.blocks
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => ({
              text: b.text as string,
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
            }))
        : undefined;

      let analyzerResult: Awaited<
        ReturnType<typeof analyzeCatalogPageProducts>
      > | null = null;
      try {
        analyzerResult = await analyzeCatalogPageProducts({
          pageImagePath: imagePath,
          pageNumber,
          supplierName,
          catalogFileName,
          pdfTextBlocks,
        });
      } catch (err) {
        console.error(
          `[catalog ${catalogId}] page ${pageNumber} analyzer error:`,
          err
        );
        // Persist the error trace in PageAnalysis so it's visible later.
        try {
          await prisma.pageAnalysis.create({
            data: {
              catalogId,
              pageId: catalogPage.id,
              pageNumber,
              provider: process.env.VISION_DETECTOR_PROVIDER ?? null,
              model:
                process.env.PAGE_ANALYZER_MODEL ??
                process.env.VISION_DETECTOR_MODEL_CHEAP ??
                null,
              productsCount: 0,
              error: String(err),
              rawJson: { products: [] } as Prisma.InputJsonValue,
            },
          });
        } catch {
          // ignore secondary failure
        }
        continue;
      }

      analyzedPages++;
      const products = analyzerResult.analysis.products;
      console.log(
        `[page-analyzer] page ${pageNumber} products=${products.length} provider=${analyzerResult.provider} model=${analyzerResult.model}`
      );

      // ── Persist raw analysis (for auditing) ──────────────────────────────
      try {
        await prisma.pageAnalysis.create({
          data: {
            catalogId,
            pageId: catalogPage.id,
            pageNumber,
            provider: analyzerResult.provider,
            model: analyzerResult.model,
            productsCount: products.length,
            rawJson: (analyzerResult.rawJson ?? {
              products: [],
            }) as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.error(
          `Erro ao salvar PageAnalysis (pág. ${pageNumber}):`,
          err
        );
      }

      if (products.length === 0) {
        emptyPages++;
        continue;
      }

      // ── Build searchTexts in order, batch-embed ──────────────────────────
      const searchTexts = products.map(buildPageProductSearchText);
      let embeddings: number[][] = [];
      try {
        embeddings = await generateTextEmbeddings(searchTexts);
      } catch (err) {
        console.error(
          `[catalog ${catalogId}] page ${pageNumber} embedding error:`,
          err
        );
      }

      // ── Insert mentions, then update embeddings via raw SQL ──────────────
      for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const searchText = searchTexts[i];
        const embedding = embeddings[i];

        try {
          const record = await prisma.pageProductMention.create({
            data: {
              catalogId,
              pageId: catalogPage.id,
              pageNumber,
              namePt: p.namePt,
              originalName: p.originalName ?? null,
              descriptionPt: p.descriptionPt ?? null,
              category: p.category ?? null,
              functionGroup: p.functionGroup ?? null,
              colors: p.colors,
              visualAttributes: p.visualAttributes,
              technicalAttributes: p.technicalAttributes,
              notConfuseWith: p.notConfuseWith,
              commercialUse: p.commercialUse ?? null,
              isKit: p.isKit,
              kitContains: p.kitContains,
              confidence: p.confidence,
              evidenceText: p.evidenceText ?? null,
              evidenceSource: p.evidenceSource,
              searchText,
              rawJson: p as unknown as Prisma.InputJsonValue,
            },
          });

          if (embedding && embedding.length > 0 && embedding.some((v) => v !== 0)) {
            const vec = toPgVectorLiteral(embedding);
            await prisma.$executeRaw`
              UPDATE "PageProductMention"
              SET embedding = ${vec}::vector
              WHERE id = ${record.id}
            `;
          }

          mentionCount++;
        } catch (err) {
          console.error(
            `Erro ao salvar PageProductMention (pág. ${pageNumber}):`,
            err
          );
        }
      }
    } catch (err) {
      console.error(`Erro ao processar página ${pageNumber}:`, err);
    }
  }

  await prisma.catalog.update({
    where: { id: catalogId },
    data: { pageCount, pageProductCount: mentionCount },
  });

  console.log(
    `[catalog ${catalogId}] summary(page_mentions): totalPages=${pageCount} analyzedPages=${analyzedPages} emptyPages=${emptyPages} mentions=${mentionCount}`
  );
}

// ── Legacy crops mode (preserved behavior) ──────────────────────────────────

async function processInLegacyCropsMode(args: {
  catalogId: string;
  renderedPages: Array<{ pageNumber: number; imagePath: string }>;
  layoutByPage: Map<number, PdfLayoutPage>;
  candidatesDir: string;
}): Promise<void> {
  const { catalogId, renderedPages, layoutByPage, candidatesDir } = args;
  let pageCount = 0;
  let candidateCount = 0;

  // Per-catalog vision call budget — protects against runaway costs.
  const maxVisionPages = getMaxVisionPagesPerCatalog();
  const visionBudget = { remaining: maxVisionPages };
  const visionMode = getVisionMode();
  const decisionCounts: Record<DetectionDecision, number> = {
    GRID_LAYOUT: 0,
    PDF_LAYOUT: 0,
    PAGE_SKIP: 0,
    HEURISTIC: 0,
    VISION_CHEAP: 0,
    VISION_PREMIUM: 0,
    FALLBACK: 0,
    BUDGET_EXCEEDED: 0,
    VISION_OFF: 0,
  };
  let totalVisionCalls = 0;
  const modelsUsed = new Set<string>();
  console.log(
    `[catalog ${catalogId}] legacy_crops mode=${visionMode} maxVisionPages=${maxVisionPages}`
  );

  for (const { pageNumber, imagePath } of renderedPages) {
    try {
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

      const { candidates, pageAnalysis, stats } =
        await detectProductCandidatesFromPage({
          pageImagePath: imagePath,
          outputDir: candidatesDir,
          pageNumber,
          pageLayout: layoutByPage.get(pageNumber),
          visionBudget,
        });

      decisionCounts[stats.decision]++;
      totalVisionCalls += stats.visionCallsMade;
      if (stats.modelUsed) modelsUsed.add(stats.modelUsed);

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
          const cropUrl = await uploadImageToStorage(
            cropStoragePath,
            cropBuffer
          );

          let cardUrl: string | undefined;
          if (candidate.cardImagePath) {
            try {
              const cardBuffer = await readFile(candidate.cardImagePath);
              const cardStoragePath = `${catalogId}/candidates/card-${String(candidateIndex).padStart(4, "0")}.jpg`;
              cardUrl = await uploadImageToStorage(
                cardStoragePath,
                cardBuffer
              );
            } catch {
              // optional
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

          if (candidate.isSearchable && candidate.qualityScore >= 0.6) {
            const embedding = await generateImageEmbeddingFromPath(
              candidate.imagePath
            );
            const vectorStr = `[${embedding.join(",")}]`;
            await prisma.$executeRaw`
              UPDATE "ProductCandidate"
              SET embedding = ${vectorStr}::vector
              WHERE id = ${record.id}
            `;
          }

          candidateCount++;
        } catch (err) {
          console.error(
            `Erro ao processar candidato (pág. ${pageNumber}):`,
            err
          );
        }
      }
    } catch (err) {
      console.error(`Erro ao processar página ${pageNumber}:`, err);
    }
  }

  await prisma.catalog.update({
    where: { id: catalogId },
    data: { pageCount, candidateCount },
  });

  console.log(
    `[catalog ${catalogId}] summary(legacy_crops): totalPages=${pageCount} gridLayoutPages=${decisionCounts.GRID_LAYOUT} pdfLayoutPages=${decisionCounts.PDF_LAYOUT} pageSkipPages=${decisionCounts.PAGE_SKIP} heuristicPages=${decisionCounts.HEURISTIC} visionCheapPages=${decisionCounts.VISION_CHEAP} visionPremiumPages=${decisionCounts.VISION_PREMIUM} fallbackPages=${decisionCounts.FALLBACK} budgetExceededPages=${decisionCounts.BUDGET_EXCEEDED} visionOffPages=${decisionCounts.VISION_OFF} estimatedVisionCalls=${totalVisionCalls} budgetRemaining=${visionBudget.remaining}/${maxVisionPages} modelsUsed=${[...modelsUsed].join(",") || "none"}`
  );
}
