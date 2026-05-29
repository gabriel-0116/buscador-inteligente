/**
 * Valida a detecção estrutural página-a-página de um catálogo em PDF, SEM tocar
 * no banco nem no Supabase. Renderiza as páginas, roda extractPdfLayout +
 * detectProductCandidatesFromPage e imprime uma tabela:
 *
 *   page  type           decision     searchable/total  flags
 *
 * Uso:
 *   npx tsx scripts/test-eletromex.ts <caminho-do-pdf.pdf> [pág pág ...]
 *
 * Exemplos:
 *   npx tsx scripts/test-eletromex.ts ~/Downloads/ELETROMEX-13.05.2026.pdf
 *   npx tsx scripts/test-eletromex.ts ~/Downloads/ELETROMEX-13.05.2026.pdf 3 4 5 17
 *
 * Por padrão NÃO chama vision (VISION_DETECTOR_MODE=off) para não gerar custo.
 * Para incluir o fallback de vision, rode com: TEST_VISION=1 npx tsx ...
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, rm } from "node:fs/promises";

import { renderPdfPagesToImages } from "../src/features/catalog-processing/render-pages";
import { extractPdfLayout } from "../src/features/catalog-processing/pdf-layout-extractor";
import {
  detectProductCandidatesFromPage,
  type DetectedCandidate,
} from "../src/features/catalog-processing/detect-product-candidates";
import { classifyCatalogPage } from "../src/features/catalog-processing/page-type-classifier";

// Resultados esperados do task-pdf.md (item 10), para comparação.
// type=null quando o task aceita mais de um tipo.
const EXPECTED: Record<number, { type: string | null; searchable: number }> = {
  1: { type: "cover", searchable: 0 },
  2: { type: "summary", searchable: 0 },
  3: { type: "category_grid", searchable: 9 },
  4: { type: "category_grid", searchable: 9 },
  5: { type: "partial_grid", searchable: 4 },
  6: { type: "category_grid", searchable: 9 },
  17: { type: "partial_grid", searchable: 7 },
  26: { type: "partial_grid", searchable: 5 },
  28: { type: "partial_grid", searchable: 3 },
  58: { type: "partial_grid", searchable: 3 },
  60: { type: "category_grid", searchable: 9 },
  61: { type: null, searchable: 1 }, // single_product | partial_grid
  62: { type: "single_product", searchable: 1 },
  80: { type: "single_product", searchable: 1 },
  87: { type: "partial_grid", searchable: 2 },
};

// Um crop pesquisável grande demais é o sintoma do bug do task: "crop com
// vários produtos aprovado como 1". Sinalizamos para inspeção visual.
function isSuspiciouslyBig(c: DetectedCandidate): boolean {
  return c.isSearchable && (c.width >= 700 || c.height >= 900);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error("Uso: npx tsx scripts/test-eletromex.ts <pdf> [pág ...]");
    process.exit(1);
  }
  const onlyPages = process.argv
    .slice(3)
    .map((a) => parseInt(a, 10))
    .filter((n) => Number.isFinite(n));

  if (!process.env.TEST_VISION) {
    process.env.VISION_DETECTOR_MODE = "off"; // sem custo por padrão
  }
  const visionMode = process.env.VISION_DETECTOR_MODE ?? "auto";

  const outputDir = join(tmpdir(), `eletromex-test-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });

  console.log(`PDF:        ${pdfPath}`);
  console.log(`Saída/crops: ${outputDir}`);
  console.log(`Vision mode: ${visionMode}${process.env.TEST_VISION ? "" : " (forçado off — use TEST_VISION=1 para incluir vision)"}`);
  if (onlyPages.length) console.log(`Páginas:    ${onlyPages.join(", ")}`);
  console.log("");

  console.log("Renderizando páginas (pdftoppm)...");
  const pages = await renderPdfPagesToImages(pdfPath, join(outputDir, "pages"));
  console.log(`${pages.length} páginas renderizadas.`);

  console.log("Extraindo estrutura do PDF (PyMuPDF)...");
  const layout = await extractPdfLayout({ pdfPath, outputDir });
  if (!layout) {
    console.warn(
      "⚠ extractPdfLayout retornou null (Python/PyMuPDF ausente?). " +
        "Sem layout, GRID_LAYOUT/PDF_LAYOUT não rodam — só heurística/vision."
    );
  }
  const layoutByPage = new Map(
    (layout?.pages ?? []).map((p) => [p.pageNumber, p])
  );
  console.log("");

  const header = `${pad("page", 5)}${pad("type", 16)}${pad("decision", 15)}${pad("search/total", 14)}flags`;
  console.log(header);
  console.log("-".repeat(header.length + 10));

  const bigCrops: Array<{ page: number; w: number; h: number; detector?: string }> = [];
  const mismatches: string[] = [];

  for (const { pageNumber, imagePath } of pages) {
    if (onlyPages.length && !onlyPages.includes(pageNumber)) continue;

    const pageLayout = layoutByPage.get(pageNumber);

    // pageType: replicamos a classificação para exibir (não vem em stats).
    let pageType = "unknown";
    if (pageLayout) {
      const pageText = pageLayout.blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text as string)
        .join("\n");
      // tamanho renderizado: usamos width/height do layout em pontos só p/ razão;
      // o classificador aceita os renderizados, mas a proporção é a mesma.
      pageType = classifyCatalogPage({
        pageNumber,
        pageText,
        pageLayout,
        renderedWidth: pageLayout.width,
        renderedHeight: pageLayout.height,
      });
    }

    const { candidates, stats } = await detectProductCandidatesFromPage({
      pageImagePath: imagePath,
      outputDir: join(outputDir, "crops"),
      pageNumber,
      pageLayout,
    });

    const searchable = candidates.filter((c) => c.isSearchable).length;
    const total = candidates.length;

    const flags: string[] = [];
    const big = candidates.filter(isSuspiciouslyBig);
    for (const c of big) {
      bigCrops.push({ page: pageNumber, w: c.width, h: c.height, detector: c.sourceDetector });
    }
    if (big.length) flags.push(`⚠ ${big.length} crop(s) grande(s) pesquisável(is)`);

    // qualquer crop pesquisável com rejectReason é uma violação dura
    const badSearchable = candidates.filter((c) => c.isSearchable && c.rejectReason);
    if (badSearchable.length) flags.push(`✗ ${badSearchable.length} pesquisável c/ rejectReason`);

    const exp = EXPECTED[pageNumber];
    let mark = "";
    if (exp) {
      const okCount = searchable === exp.searchable;
      const okType = exp.type === null || pageType === exp.type;
      mark = okCount && okType ? "✓" : "✗";
      if (!okCount || !okType) {
        mismatches.push(
          `page ${pageNumber}: esperado type=${exp.type ?? "(single/partial)"} search=${exp.searchable} | obtido type=${pageType} search=${searchable}`
        );
      }
    }

    console.log(
      `${pad(String(pageNumber), 5)}${pad(pageType, 16)}${pad(stats.decision, 15)}${pad(`${searchable}/${total} ${mark}`, 14)}${flags.join("  ")}`
    );
  }

  console.log("");
  console.log("=".repeat(60));
  if (bigCrops.length) {
    console.log(`⚠ ${bigCrops.length} crop(s) pesquisável(is) grande(s) (possível multi-produto):`);
    for (const b of bigCrops) {
      console.log(`   page ${b.page}  ${b.w}x${b.h}  ${b.detector ?? ""}`);
    }
  } else {
    console.log("✓ Nenhum crop pesquisável grande detectado.");
  }
  console.log("");
  if (mismatches.length) {
    console.log(`✗ ${mismatches.length} divergência(s) vs. esperado (item 10):`);
    for (const m of mismatches) console.log(`   ${m}`);
  } else if (onlyPages.length || pages.length) {
    console.log("✓ Nenhuma divergência vs. esperado nas páginas com gabarito.");
  }
  console.log("");
  console.log(`Crops salvos em: ${outputDir}/crops — inspecione visualmente se quiser.`);
  console.log(`(Apague depois com: rm -rf ${outputDir})`);

  // não removemos o outputDir para permitir inspeção; só o JSON intermediário
  await rm(join(outputDir, "pdf-layout.json"), { force: true }).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
