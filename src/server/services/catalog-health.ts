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
//
// Color/status is the *same* function for individual metric chips and for
// the overall gate: `rateStatus(rate, greenAt, yellowAt)`. Three gate
// metrics (page success, visual coverage, functionGroup quality) drive the
// overall status. `productiveRate` is informational only — the catalog
// page renders its chip neutral and there's no warning for it.

export type CatalogHealthStatus = "green" | "yellow" | "red";
export type MetricStatus = "green" | "yellow" | "red" | "neutral";

// Threshold table — single source of truth for both per-chip color AND for
// the overall gate. Each entry is `{ green, yellow }`: a metric is green
// when `rate >= green`, yellow when `green > rate >= yellow`, red below.
export const HEALTH_THRESHOLDS = {
  pageSuccess: { green: 0.95, yellow: 0.85 },
  visualCoverage: { green: 0.9, yellow: 0.75 },
  functionGroup: { green: 0.9, yellow: 0.75 },
} as const;

export function rateStatus(
  rate: number,
  greenAt: number,
  yellowAt: number
): MetricStatus {
  if (rate >= greenAt) return "green";
  if (rate >= yellowAt) return "yellow";
  return "red";
}

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
  productiveRate: number; // informational only
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

  const overallStatus = computeOverallStatus({
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
    pageSuccessRate,
    visualCoverageRate,
    functionGroupRate,
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

// ── Overall status ─────────────────────────────────────────────────────────
//
// Worst-of the three gate metrics. Uses the *same* `rateStatus` helper the
// UI uses per chip, so a metric can never be visually green but counted as
// yellow in the overall — or vice versa.

function computeOverallStatus(args: {
  totalPages: number;
  totalProducts: number;
  pageSuccessRate: number;
  visualCoverageRate: number;
  functionGroupRate: number;
}): CatalogHealthStatus {
  if (args.totalPages === 0 || args.totalProducts === 0) return "red";

  const t = HEALTH_THRESHOLDS;
  const gateStatuses: MetricStatus[] = [
    rateStatus(args.pageSuccessRate, t.pageSuccess.green, t.pageSuccess.yellow),
    rateStatus(
      args.visualCoverageRate,
      t.visualCoverage.green,
      t.visualCoverage.yellow
    ),
    rateStatus(
      args.functionGroupRate,
      t.functionGroup.green,
      t.functionGroup.yellow
    ),
  ];
  if (gateStatuses.includes("red")) return "red";
  if (gateStatuses.includes("yellow")) return "yellow";
  return "green";
}

// ── Human-readable warnings (pt-BR) ────────────────────────────────────────
//
// A warning fires whenever the corresponding gate metric is not green —
// i.e., its `rateStatus` is yellow or red against `HEALTH_THRESHOLDS`. This
// keeps the warning list and the mini-card colors in lock-step.
// `productiveRate` has no warning by spec — it's informational.

function buildWarnings(args: {
  totalPages: number;
  totalProducts: number;
  pagesWithError: number;
  pagesWithVisualEmbedding: number;
  productsWithFunctionGroup: number;
  functionGroupDistribution: Array<{ functionGroup: string; count: number }>;
  pageSuccessRate: number;
  visualCoverageRate: number;
  functionGroupRate: number;
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

  const t = HEALTH_THRESHOLDS;
  const successNotGreen =
    rateStatus(
      args.pageSuccessRate,
      t.pageSuccess.green,
      t.pageSuccess.yellow
    ) !== "green";
  const visualNotGreen =
    rateStatus(
      args.visualCoverageRate,
      t.visualCoverage.green,
      t.visualCoverage.yellow
    ) !== "green";
  const fgNotGreen =
    rateStatus(
      args.functionGroupRate,
      t.functionGroup.green,
      t.functionGroup.yellow
    ) !== "green";

  if (successNotGreen && args.pagesWithError > 0) {
    const pct = Math.round((args.pagesWithError / args.totalPages) * 100);
    out.push(
      `${pct}% das páginas (${args.pagesWithError}/${args.totalPages}) falharam no analyzer — reprocesse o catálogo.`
    );
  }

  const missingVisual = args.totalPages - args.pagesWithVisualEmbedding;
  if (visualNotGreen && missingVisual > 0) {
    out.push(
      `${missingVisual} página${missingVisual === 1 ? "" : "s"} sem embedding visual — não aparecem na busca híbrida.`
    );
  }

  if (args.totalProducts > 0) {
    const missingFg = args.totalProducts - args.productsWithFunctionGroup;
    if (fgNotGreen && missingFg > 0) {
      const pct = Math.round((missingFg / args.totalProducts) * 100);
      out.push(
        `${pct}% dos produtos sem functionGroup — reranker pode classificar mal.`
      );
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
