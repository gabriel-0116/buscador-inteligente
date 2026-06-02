/**
 * Imprime um relatório de processamento de um catálogo:
 *   - status / contagens (pageCount, pageProductCount)
 *   - Catalog.error (avisos)
 *   - todas as páginas com erro de analyzer (PageAnalysis.error não nulo)
 *
 * Uso:
 *   npx tsx scripts/debug-catalog-processing.ts <catalogId>
 *
 * Resolve o motivo do clássico
 *   "Processado com avisos: 1 página falharam no analyzer."
 * sem precisar abrir o banco manualmente.
 *
 * Nota: `src/lib/prisma.ts` cria um pg.Pool já no carregamento do módulo,
 * lendo `DATABASE_URL`. Por isso o dotenv precisa rodar ANTES de qualquer
 * import desse módulo — usamos import dinâmico dentro de `main()`.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const { prisma } = await import("../src/lib/prisma");

  const [, , catalogId] = process.argv;
  if (!catalogId) {
    console.error("uso: npx tsx scripts/debug-catalog-processing.ts <catalogId>");
    process.exit(2);
  }

  const catalog = await prisma.catalog.findUnique({
    where: { id: catalogId },
    select: {
      id: true,
      fileName: true,
      status: true,
      pageCount: true,
      candidateCount: true,
      pageProductCount: true,
      pdfStoragePath: true,
      error: true,
      createdAt: true,
      updatedAt: true,
      supplier: { select: { name: true } },
    },
  });

  if (!catalog) {
    console.error(`Catálogo não encontrado: ${catalogId}`);
    process.exit(1);
  }

  console.log(`Catalog: ${catalog.fileName}`);
  console.log(`  id:              ${catalog.id}`);
  console.log(`  supplier:        ${catalog.supplier?.name ?? "—"}`);
  console.log(`  status:          ${catalog.status}`);
  console.log(`  pageCount:       ${catalog.pageCount ?? "—"}`);
  console.log(`  pageProductCount:${catalog.pageProductCount ?? "—"}`);
  console.log(`  candidateCount:  ${catalog.candidateCount ?? "—"} (legado)`);
  console.log(`  pdfStoragePath:  ${catalog.pdfStoragePath ?? "—"}`);
  console.log(`  createdAt:       ${catalog.createdAt.toISOString()}`);
  console.log(`  updatedAt:       ${catalog.updatedAt.toISOString()}`);
  if (catalog.error) {
    console.log("");
    console.log("Avisos de processamento (Catalog.error):");
    console.log(`  ${catalog.error}`);
  }

  // ── Pages with analyzer errors ───────────────────────────────────────────
  const erroredAnalyses = await prisma.pageAnalysis.findMany({
    where: { catalogId, error: { not: null } },
    select: {
      pageNumber: true,
      provider: true,
      model: true,
      error: true,
      createdAt: true,
    },
    orderBy: { pageNumber: "asc" },
  });

  console.log("");
  if (erroredAnalyses.length === 0) {
    console.log("Analyzer errors: nenhum");
  } else {
    console.log(`Analyzer errors: ${erroredAnalyses.length}`);
    for (const a of erroredAnalyses) {
      console.log(
        `- page ${a.pageNumber} | ${a.provider ?? "?"} / ${a.model ?? "?"} | ${a.createdAt.toISOString()}`
      );
      const trimmed = (a.error ?? "")
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n");
      console.log(trimmed);
    }
  }

  // ── Visual / text embedding sanity (raw SQL, since Unsupported columns) ──
  const embeddingStats = await prisma.$queryRaw<
    Array<{
      pageCount: bigint;
      withVisual: bigint;
      mentionCount: bigint;
      withText: bigint;
    }>
  >`
    SELECT
      (SELECT COUNT(*) FROM "CatalogPage" WHERE "catalogId" = ${catalogId})       AS "pageCount",
      (SELECT COUNT(*) FROM "CatalogPage" WHERE "catalogId" = ${catalogId} AND "visualEmbedding" IS NOT NULL) AS "withVisual",
      (SELECT COUNT(*) FROM "PageProductMention" WHERE "catalogId" = ${catalogId})       AS "mentionCount",
      (SELECT COUNT(*) FROM "PageProductMention" WHERE "catalogId" = ${catalogId} AND embedding IS NOT NULL) AS "withText"
  `;
  const stats = embeddingStats[0];
  if (stats) {
    console.log("");
    console.log("Embeddings:");
    console.log(
      `  pages com visualEmbedding: ${stats.withVisual}/${stats.pageCount}`
    );
    console.log(
      `  mentions com embedding texto: ${stats.withText}/${stats.mentionCount}`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    // Re-dynamic-import to disconnect — the module is already cached so this
    // is just grabbing the singleton.
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect().catch(() => {});
  });
