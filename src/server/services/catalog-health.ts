import { prisma } from "@/lib/prisma";

// ── Catalog processing health ───────────────────────────────────────────────
//
// Read-only observability snapshot. Calculates per-catalog rates on the fly
// (no migration, no schema change). The catalog page calls this once per
// render; if it ever becomes the bottleneck, we can materialize the rates
// as a view or denormalize. The numbers come from four sources:
//
//   CatalogPage         — totalPages, visualEmbedding coverage
//   PageAnalysis        — analyzer error count
//   PageProductMention  — products + functionGroup/brand/colors/modelCodes
//                         coverage + functionGroup distribution

export type CatalogHealthStatus = "green" | "yellow" | "red";

export type CatalogHealth = {
  totalPages: number;
  pagesWithError: number;
  pagesWithVisualEmbedding: number;
  pagesWithProducts: number;
  totalProducts: number;
  productsWithFunctionGroup: number;
  productsWithBrand: number;
  productsWithColors: number;
  productsWithModelCodes: number;
  functionGroupDistribution: Array<{ functionGroup: string; count: number }>;

  pageSuccessRate: number; // 0..1
  visualCoverageRate: number;
  productiveRate: number;
  functionGroupRate: number;

  overallStatus: CatalogHealthStatus;
  warnings: string[];
};

type RawCountRow = { count: bigint };

export async function getCatalogHealth(
  catalogId: string
): Promise<CatalogHealth> {
  const [
    totalPages,
    pagesWithErrorRows,
    pagesWithVisualEmbeddingRows,
    pagesWithProductsRows,
    totalProducts,
    productsWithFunctionGroup,
    productsWithBrand,
    productsWithColors,
    productsWithModelCodes,
    functionGroupRows,
  ] = await Promise.all([
    prisma.catalogPage.count({ where: { catalogId } }),

    // Distinct pages with at least one analyzer error. PageAnalysis may have
    // multiple rows per page across reprocesses; DISTINCT keeps the rate
    // honest.
    prisma.$queryRaw<RawCountRow[]>`
      SELECT COUNT(DISTINCT "pageId")::bigint AS "count"
      FROM "PageAnalysis"
      WHERE "catalogId" = ${catalogId} AND "error" IS NOT NULL
    `,

    // visualEmbedding is `Unsupported("vector(768)")` so Prisma can't filter
    // by it directly — raw SQL.
    prisma.$queryRaw<RawCountRow[]>`
      SELECT COUNT(*)::bigint AS "count"
      FROM "CatalogPage"
      WHERE "catalogId" = ${catalogId} AND "visualEmbedding" IS NOT NULL
    `,

    prisma.$queryRaw<RawCountRow[]>`
      SELECT COUNT(DISTINCT "pageId")::bigint AS "count"
      FROM "PageProductMention"
      WHERE "catalogId" = ${catalogId}
    `,

    prisma.pageProductMention.count({ where: { catalogId } }),

    prisma.pageProductMention.count({
      where: { catalogId, functionGroup: { not: null } },
    }),

    prisma.pageProductMention.count({
      where: { catalogId, brand: { not: null } },
    }),

    prisma.pageProductMention.count({
      where: { catalogId, colors: { isEmpty: false } },
    }),

    prisma.pageProductMention.count({
      where: { catalogId, modelCodes: { isEmpty: false } },
    }),

    prisma.pageProductMention.groupBy({
      by: ["functionGroup"],
      where: { catalogId, functionGroup: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { functionGroup: "desc" } },
      take: 10,
    }),
  ]);

  // Raw COUNT(*) comes back as bigint via the pg adapter; coerce to Number
  // before doing arithmetic (totals never overflow Number.MAX_SAFE_INTEGER
  // at our scale).
  const pagesWithError = Number(pagesWithErrorRows[0]?.count ?? 0);
  const pagesWithVisualEmbedding = Number(
    pagesWithVisualEmbeddingRows[0]?.count ?? 0
  );
  const pagesWithProducts = Number(pagesWithProductsRows[0]?.count ?? 0);

  const functionGroupDistribution: CatalogHealth["functionGroupDistribution"] =
    functionGroupRows.map((row) => ({
      functionGroup: row.functionGroup ?? "(sem rótulo)",
      count: row._count._all,
    }));

  const safeRate = (num: number, den: number): number =>
    den > 0 ? num / den : 0;

  const pageSuccessRate =
    totalPages > 0 ? safeRate(totalPages - pagesWithError, totalPages) : 0;
  const visualCoverageRate = safeRate(pagesWithVisualEmbedding, totalPages);
  const productiveRate = safeRate(pagesWithProducts, totalPages);
  const functionGroupRate = safeRate(productsWithFunctionGroup, totalProducts);

  const overallStatus = computeStatus({
    totalPages,
    totalProducts,
    pageSuccessRate,
    visualCoverageRate,
    functionGroupRate,
  });

  const warnings = buildWarnings({
    totalPages,
    totalProducts,
    pagesWithError,
    pagesWithVisualEmbedding,
    productsWithFunctionGroup,
    functionGroupDistribution,
  });

  return {
    totalPages,
    pagesWithError,
    pagesWithVisualEmbedding,
    pagesWithProducts,
    totalProducts,
    productsWithFunctionGroup,
    productsWithBrand,
    productsWithColors,
    productsWithModelCodes,
    functionGroupDistribution,
    pageSuccessRate,
    visualCoverageRate,
    productiveRate,
    functionGroupRate,
    overallStatus,
    warnings,
  };
}

// ── Status thresholds ──────────────────────────────────────────────────────
//
// Three gating rates: pageSuccess, visualCoverage, functionGroup. Visual
// coverage gets a lower green threshold (0.90) because DINOv2 failures are
// the most benign — they just hide the page from the visual *boost* in the
// hybrid search; the page is still findable semantically.

function computeStatus(args: {
  totalPages: number;
  totalProducts: number;
  pageSuccessRate: number;
  visualCoverageRate: number;
  functionGroupRate: number;
}): CatalogHealthStatus {
  if (args.totalPages === 0 || args.totalProducts === 0) return "red";

  const { pageSuccessRate, visualCoverageRate, functionGroupRate } = args;

  if (
    pageSuccessRate < 0.7 ||
    visualCoverageRate < 0.7 ||
    functionGroupRate < 0.7
  ) {
    return "red";
  }
  if (
    pageSuccessRate >= 0.95 &&
    visualCoverageRate >= 0.9 &&
    functionGroupRate >= 0.95
  ) {
    return "green";
  }
  return "yellow";
}

// ── Human-readable warnings (pt-BR) ────────────────────────────────────────

function buildWarnings(args: {
  totalPages: number;
  totalProducts: number;
  pagesWithError: number;
  pagesWithVisualEmbedding: number;
  productsWithFunctionGroup: number;
  functionGroupDistribution: Array<{ functionGroup: string; count: number }>;
}): string[] {
  const out: string[] = [];

  if (args.totalPages === 0) {
    out.push("Catálogo ainda não tem páginas processadas.");
    return out;
  }
  if (args.totalProducts === 0) {
    out.push(
      "Nenhum produto foi detectado nas páginas — reprocesse o catálogo."
    );
  }

  if (args.pagesWithError > 0) {
    const pct = Math.round((args.pagesWithError / args.totalPages) * 100);
    out.push(
      `${pct}% das páginas (${args.pagesWithError}/${args.totalPages}) falharam no analyzer — reprocesse o catálogo.`
    );
  }

  const missingVisual = args.totalPages - args.pagesWithVisualEmbedding;
  if (missingVisual > 0) {
    out.push(
      `${missingVisual} página${missingVisual === 1 ? "" : "s"} sem embedding visual — não aparecem na busca híbrida.`
    );
  }

  if (args.totalProducts > 0) {
    const missingFg = args.totalProducts - args.productsWithFunctionGroup;
    if (missingFg > 0) {
      const pct = Math.round((missingFg / args.totalProducts) * 100);
      if (pct >= 5) {
        out.push(
          `${pct}% dos produtos sem functionGroup — reranker pode classificar mal.`
        );
      }
    }

    // Dominant-group warning: catches "analyzer só conhece esse rótulo".
    const top = args.functionGroupDistribution[0];
    if (top && top.count > 0) {
      const dominance = top.count / args.totalProducts;
      if (dominance > 0.5) {
        const pct = Math.round(dominance * 100);
        out.push(
          `${pct}% dos produtos em um único functionGroup (${top.functionGroup}) — analyzer pode estar agrupando demais.`
        );
      }
    }
  }

  return out;
}
