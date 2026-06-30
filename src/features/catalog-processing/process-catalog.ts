import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { uploadImageToStorage, supabaseAdmin } from "@/lib/supabase";
import { generateImageEmbeddingFromPath } from "@/features/visual-search/embeddings";
import { renderPdfPagesToImages } from "./render-pages";
import { extractPdfLayout, type PdfLayoutPage } from "./pdf-layout-extractor";
import {
  analyzeCatalogPageProducts,
  buildPageProductSearchText,
  isPageAnalyzerConfigured,
} from "./page-product-analyzer";
import {
  generateTextEmbeddings,
  toPgVectorLiteral,
} from "@/features/semantic-search/text-embeddings";
import {
  computePageTextHash,
  copyMentionsFromPage,
  findDuplicatePage,
  loadDedupConfig,
} from "./page-dedup";

// ── Public entry point ──────────────────────────────────────────────────────
//
// page_mentions is the only mode. Each rendered page becomes the visual
// result; per-page products are persisted as PageProductMention rows with
// textual embeddings. No crops, no detector cascade.

export async function processCatalog(
  catalogId: string,
  pdfPath: string
): Promise<void> {
  const baseDir = join(tmpdir(), catalogId);
  const pagesDir = join(baseDir, "pages");

  try {
    const catalogRow = await prisma.catalog.findUnique({
      where: { id: catalogId },
      select: {
        fileName: true,
        supplierId: true,
        supplier: { select: { name: true } },
      },
    });
    const supplierId = catalogRow?.supplierId;
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

    // ── Extract PDF structure once (best-effort, feeds the analyzer's
    // ── pdfTextBlocks evidence) ────────────────────────────────────────────
    const layout = await extractPdfLayout({ pdfPath, outputDir: baseDir });
    const layoutByPage = new Map<number, PdfLayoutPage>();
    if (layout) {
      for (const page of layout.pages) layoutByPage.set(page.pageNumber, page);
      console.log(
        `[catalog ${catalogId}] pdf-layout: ${layout.pages.length} pages extracted`
      );
    } else {
      console.warn(
        `[catalog ${catalogId}] pdf-layout unavailable → analyzer runs without PDF text evidence`
      );
    }

    console.log(
      `[catalog ${catalogId}] totalPages=${renderedPages.length}`
    );

    await processInPageMentionsMode({
      catalogId,
      supplierId,
      renderedPages,
      layoutByPage,
      supplierName,
      catalogFileName,
    });

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
  supplierId: string | undefined;
  renderedPages: Array<{ pageNumber: number; imagePath: string }>;
  layoutByPage: Map<number, PdfLayoutPage>;
  supplierName: string | undefined;
  catalogFileName: string | undefined;
}): Promise<void> {
  const {
    catalogId,
    supplierId,
    renderedPages,
    layoutByPage,
    supplierName,
    catalogFileName,
  } = args;

  const analyzerReady = isPageAnalyzerConfigured();
  if (!analyzerReady) {
    console.warn(
      `[catalog ${catalogId}] page-mentions: analyzer not configured (set VISION_DETECTOR_PROVIDER + VISION_DETECTOR_API_KEY and PAGE_ANALYZER_MODEL or VISION_DETECTOR_MODEL_CHEAP). Pages will be saved without products.`
    );
  }

  const dedupConfig = loadDedupConfig();
  const dedupActive = dedupConfig.enabled && !!supplierId;
  if (dedupConfig.enabled && !supplierId) {
    console.warn(
      `[catalog ${catalogId}] dedup disabled: catalog has no supplierId.`
    );
  }

  let pageCount = 0;
  let mentionCount = 0;
  let analyzedPages = 0;
  let dedupedPages = 0;
  let dedupedMentionCount = 0;
  let emptyPages = 0;
  let analyzerErrorCount = 0;
  let embeddingErrorCount = 0;
  let embeddedMentionCount = 0;
  let pageVisualEmbeddingCount = 0;
  let pageVisualEmbeddingErrorCount = 0;

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

      // ── Full-page DINOv2 visual embedding ────────────────────────────────
      // Supports the hybrid visual signal in /api/search AND the page-dedup
      // gate below. Failure here must never abort the page: visual-only
      // matches can't promote to high confidence anyway (the reranker
      // enforces that), so a missing visualEmbedding just means this page
      // is invisible to the visual branch and can't be deduped.
      let pageVisualEmbedding: number[] | null = null;
      try {
        const emb = await generateImageEmbeddingFromPath(imagePath);
        if (emb.length > 0 && emb.some((v) => v !== 0)) {
          pageVisualEmbedding = emb;
          const vec = toPgVectorLiteral(emb);
          await prisma.$executeRaw`
            UPDATE "CatalogPage"
            SET "visualEmbedding" = ${vec}::vector
            WHERE id = ${catalogPage.id}
          `;
          pageVisualEmbeddingCount++;
        }
      } catch (err) {
        pageVisualEmbeddingErrorCount++;
        console.error(
          `[catalog ${catalogId}] page ${pageNumber} visualEmbedding error:`,
          err
        );
      }

      // ── Page layout / PDF text — used by both dedup and analyzer ─────────
      const pageLayout = layoutByPage.get(pageNumber);
      const pdfTextHash = computePageTextHash(pageLayout);

      // ── Dedup gate ───────────────────────────────────────────────────────
      // Cheapest possible question: do we already have an analyzed page from
      // this supplier with the same look + same text? If yes, copy its
      // mentions verbatim and skip the paid analyzer.
      if (dedupActive && supplierId) {
        try {
          const decision = await findDuplicatePage({
            config: dedupConfig,
            supplierId,
            excludeCatalogId: catalogId,
            pageEmbedding: pageVisualEmbedding,
            pageTextHash: pdfTextHash,
          });
          if (decision.matched) {
            const copied = await copyMentionsFromPage({
              sourcePageId: decision.source.sourcePageId,
              targetPageId: catalogPage.id,
              targetCatalogId: catalogId,
              targetPageNumber: pageNumber,
            });
            await prisma.pageAnalysis.create({
              data: {
                catalogId,
                pageId: catalogPage.id,
                pageNumber,
                provider: "dedup",
                model: "dedup",
                productsCount: copied,
                rawJson: {
                  products: [],
                  _meta: {
                    pdfTextHash,
                    _dedup: {
                      sourcePageId: decision.source.sourcePageId,
                      sourceCatalogId: decision.source.sourceCatalogId,
                      similarity: decision.source.similarity,
                      textHashMatched:
                        pdfTextHash !== null &&
                        decision.source.pdfTextHash !== null,
                    },
                  },
                } as Prisma.InputJsonValue,
              },
            });
            console.log(
              `[catalog ${catalogId}] page ${pageNumber} DEDUPED from ${decision.source.sourcePageId} (sim=${decision.source.similarity.toFixed(4)}, copied ${copied} mentions)`
            );
            dedupedPages++;
            dedupedMentionCount += copied;
            mentionCount += copied;
            continue;
          }
        } catch (err) {
          console.error(
            `[catalog ${catalogId}] page ${pageNumber} dedup error (falling back to analyzer):`,
            err
          );
        }
      }

      if (!analyzerReady) continue;

      // ── Analyze page ─────────────────────────────────────────────────────
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
        analyzerErrorCount++;
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
      // The `_meta.pdfTextHash` field is what page-dedup reads on future
      // weekly reprints to short-circuit this analyzer call. Keep it shallow
      // and stable — adding a sibling key under `_meta` doesn't disturb the
      // analyzer's own JSON shape.
      const rawWithMeta: Prisma.InputJsonValue = {
        ...((analyzerResult.rawJson as Record<string, unknown> | null) ?? {
          products: [],
        }),
        _meta: { pdfTextHash },
      } as Prisma.InputJsonValue;
      try {
        await prisma.pageAnalysis.create({
          data: {
            catalogId,
            pageId: catalogPage.id,
            pageNumber,
            provider: analyzerResult.provider,
            model: analyzerResult.model,
            productsCount: products.length,
            rawJson: rawWithMeta,
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
        embeddingErrorCount++;
        console.error(
          `[catalog ${catalogId}] page ${pageNumber} embedding error:`,
          err
        );
      }

      // ── Insert mentions, then update embeddings via raw SQL ──────────────
      // `displayOrder` mirrors the analyzer's response order — the prompt
      // asks for left→right, top→bottom, so position in the array is the
      // visual order of the product on the page.
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
              displayOrder: i + 1,
              namePt: p.namePt,
              originalName: p.originalName ?? null,
              descriptionPt: p.descriptionPt ?? null,
              category: p.category ?? null,
              functionGroup: p.functionGroup ?? null,
              brand: p.brand ?? null,
              modelCodes: p.modelCodes,
              aliases: p.aliases,
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

          if (
            embedding &&
            embedding.length > 0 &&
            embedding.some((v) => v !== 0)
          ) {
            const vec = toPgVectorLiteral(embedding);
            await prisma.$executeRaw`
              UPDATE "PageProductMention"
              SET embedding = ${vec}::vector
              WHERE id = ${record.id}
            `;
            embeddedMentionCount++;
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

  // If every page failed at the analyzer, treat the run as a hard failure —
  // there's nothing to search against. Throw so the outer catch flips status
  // to FAILED with the same error message. Deduped pages count as success
  // here: they carry mentions copied from a sibling catalog.
  if (
    analyzerReady &&
    renderedPages.length > 0 &&
    analyzedPages === 0 &&
    dedupedPages === 0 &&
    analyzerErrorCount > 0
  ) {
    throw new Error(
      `Nenhuma página foi analisada com sucesso (${analyzerErrorCount} falhas no analyzer).`
    );
  }

  // Partial failures stay READY but surface a warning in Catalog.error so
  // Rafael sees a yellow flag in the UI.
  const warningParts: string[] = [];
  if (analyzerErrorCount > 0) {
    warningParts.push(
      `${analyzerErrorCount} página${
        analyzerErrorCount === 1 ? "" : "s"
      } falharam no analyzer`
    );
  }
  if (embeddingErrorCount > 0) {
    warningParts.push(
      `${embeddingErrorCount} página${
        embeddingErrorCount === 1 ? "" : "s"
      } tiveram erro de embedding`
    );
  }
  if (pageVisualEmbeddingErrorCount > 0) {
    warningParts.push(
      `${pageVisualEmbeddingErrorCount} página${
        pageVisualEmbeddingErrorCount === 1 ? "" : "s"
      } tiveram erro de embedding visual`
    );
  }
  const errorMessage =
    warningParts.length > 0
      ? `Processado com avisos: ${warningParts.join("; ")}.`
      : null;

  await prisma.catalog.update({
    where: { id: catalogId },
    data: {
      pageCount,
      pageProductCount: mentionCount,
      error: errorMessage,
    },
  });

  console.log(
    `[catalog ${catalogId}] summary(page_mentions): totalPages=${pageCount} analyzedPages=${analyzedPages} dedupedPages=${dedupedPages} dedupedMentions=${dedupedMentionCount} emptyPages=${emptyPages} mentions=${mentionCount} embeddedMentions=${embeddedMentionCount} pageVisualEmbeddings=${pageVisualEmbeddingCount} analyzerErrors=${analyzerErrorCount} embeddingErrors=${embeddingErrorCount} pageVisualEmbeddingErrors=${pageVisualEmbeddingErrorCount}`
  );
}

