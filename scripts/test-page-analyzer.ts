/**
 * Roda o analyzer de página em um catálogo PDF SEM tocar no banco nem no
 * Supabase. Renderiza as páginas pedidas, extrai layout via PyMuPDF e
 * chama `analyzeCatalogPageProducts` em cada uma, imprimindo:
 *
 *   page <N>
 *   products=<K>
 *   - <namePt> | functionGroup=<...> | confidence=<...>
 *
 * Também grava o JSON de debug em /tmp/page-analyzer-<pageNumber>.json
 * para inspeção manual.
 *
 * Uso:
 *   npx tsx scripts/test-page-analyzer.ts <PDF> [page page ...]
 *
 * Exemplo:
 *   npx tsx scripts/test-page-analyzer.ts ~/Downloads/catalogo.pdf 3 4 5
 *
 * Requisitos:
 *   VISION_DETECTOR_PROVIDER, VISION_DETECTOR_API_KEY e um modelo
 *   (PAGE_ANALYZER_MODEL ou VISION_DETECTOR_MODEL_CHEAP) no .env.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { renderPdfPagesToImages } from "../src/features/catalog-processing/render-pages";
import {
  extractPdfLayout,
  type PdfLayoutPage,
} from "../src/features/catalog-processing/pdf-layout-extractor";
import {
  analyzeCatalogPageProducts,
  isPageAnalyzerConfigured,
} from "../src/features/catalog-processing/page-product-analyzer";

async function main() {
  const [, , pdfArg, ...rest] = process.argv;
  if (!pdfArg) {
    console.error(
      "uso: npx tsx scripts/test-page-analyzer.ts <pdf> [page page ...]"
    );
    process.exit(2);
  }
  if (!isPageAnalyzerConfigured()) {
    console.error(
      "config faltando: defina VISION_DETECTOR_PROVIDER, VISION_DETECTOR_API_KEY e PAGE_ANALYZER_MODEL (ou VISION_DETECTOR_MODEL_CHEAP) no .env"
    );
    process.exit(2);
  }

  const wantedPages = rest
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const baseDir = join(tmpdir(), `page-analyzer-${process.pid}`);
  const pagesDir = join(baseDir, "pages");
  await mkdir(pagesDir, { recursive: true });

  try {
    console.log(`[render] rendering ${pdfArg} → ${pagesDir}`);
    const rendered = await renderPdfPagesToImages(pdfArg, pagesDir);

    const layout = await extractPdfLayout({
      pdfPath: pdfArg,
      outputDir: baseDir,
    });
    const layoutByPage = new Map<number, PdfLayoutPage>();
    if (layout) {
      for (const p of layout.pages) layoutByPage.set(p.pageNumber, p);
    } else {
      console.warn("[pdf-layout] indisponível — analisando sem texto do PDF");
    }

    const targets =
      wantedPages.length > 0
        ? rendered.filter((p) => wantedPages.includes(p.pageNumber))
        : rendered;

    if (targets.length === 0) {
      console.warn("[render] nenhuma página renderizada bate com o pedido");
      return;
    }

    for (const { pageNumber, imagePath } of targets) {
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

      let result;
      try {
        result = await analyzeCatalogPageProducts({
          pageImagePath: imagePath,
          pageNumber,
          pdfTextBlocks,
        });
      } catch (err) {
        console.error(`page ${pageNumber} ERROR:`, err);
        continue;
      }

      const { products, pageSummary, hasProducts } = result.analysis;
      console.log("");
      console.log(`page ${pageNumber}`);
      console.log(`provider=${result.provider} model=${result.model}`);
      console.log(`hasProducts=${hasProducts} products=${products.length}`);
      if (pageSummary) console.log(`summary=${pageSummary}`);
      for (const p of products) {
        const kit = p.isKit ? " [KIT]" : "";
        const cols = p.colors.length ? ` colors=${p.colors.join("/")}` : "";
        console.log(
          `- ${p.namePt}${kit} | functionGroup=${p.functionGroup} | confidence=${p.confidence.toFixed(2)}${cols}`
        );
      }

      const debugPath = join(tmpdir(), `page-analyzer-${pageNumber}.json`);
      await writeFile(
        debugPath,
        JSON.stringify(
          {
            pageNumber,
            provider: result.provider,
            model: result.model,
            analysis: result.analysis,
            rawText: result.rawText,
            usage: result.usage,
          },
          null,
          2
        ),
        "utf-8"
      );
      console.log(`debug → ${debugPath}`);
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
