import {
  rateStatus,
  HEALTH_THRESHOLDS,
  type CatalogHealth,
  type MetricStatus,
} from "@/server/services/catalog-health";

// ── Catalog processing health panel ─────────────────────────────────────────
//
// Minimalist server-rendered observability card. Colors come from one place
// (`rateStatus`), shared with the overall-status calculation in the service.
// Productive-rate chip stays neutral on purpose — it's informational, not a
// gate.

// ── Status tokens ──────────────────────────────────────────────────────────

const badgeClass: Record<CatalogHealth["overallStatus"], string> = {
  green:
    "bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-900",
  yellow:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  red: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
};

const badgeDotClass: Record<CatalogHealth["overallStatus"], string> = {
  green: "bg-green-500",
  yellow: "bg-amber-500",
  red: "bg-red-500",
};

const statusLabel: Record<CatalogHealth["overallStatus"], string> = {
  green: "Pronto pra busca",
  yellow: "Processado com avisos",
  red: "Precisa reprocessar",
};

const metricColorClass: Record<MetricStatus, string> = {
  green: "text-green-700 dark:text-green-400",
  yellow: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
  neutral: "text-zinc-900 dark:text-zinc-100",
};

// ── KPI ─────────────────────────────────────────────────────────────────────

function pctText(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function MetricChip({
  label,
  value,
  hint,
  status,
}: {
  label: string;
  value: number;
  hint: string;
  status: MetricStatus;
}) {
  const pct = pctText(value);
  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-zinc-200 bg-zinc-50/40 p-4 dark:border-zinc-800 dark:bg-zinc-900/40"
      aria-label={`${label}: ${pct}, ${hint}`}
    >
      <p className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </p>
      <p
        className={`text-3xl font-semibold tracking-tight tabular-nums ${metricColorClass[status]}`}
      >
        {pct}
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function CatalogHealthPanel({ health }: { health: CatalogHealth }) {
  const { totalPages, totalProducts, overallStatus } = health;
  const analyzedPages = totalPages - health.pagesWithError;

  const t = HEALTH_THRESHOLDS;
  const successStatus = rateStatus(
    health.pageSuccessRate,
    t.pageSuccess.green,
    t.pageSuccess.yellow
  );
  const visualStatus = rateStatus(
    health.visualCoverageRate,
    t.visualCoverage.green,
    t.visualCoverage.yellow
  );
  const fgStatus = rateStatus(
    health.functionGroupRate,
    t.functionGroup.green,
    t.functionGroup.yellow
  );

  const warningTone = overallStatus === "red" ? "text-red-700" : "text-amber-700";
  const warningToneDark =
    overallStatus === "red" ? "dark:text-red-400" : "dark:text-amber-400";

  return (
    <section
      className="mb-6 flex flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
      aria-labelledby="catalog-health-heading"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h2
          id="catalog-health-heading"
          className="text-base font-semibold tracking-tight"
        >
          Saúde do processamento
        </h2>
        <span
          role="status"
          aria-label={`Status do catálogo: ${statusLabel[overallStatus]}`}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badgeClass[overallStatus]}`}
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${badgeDotClass[overallStatus]}`}
          />
          {statusLabel[overallStatus]}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricChip
          label="Taxa de sucesso"
          value={health.pageSuccessRate}
          hint={`${analyzedPages} de ${totalPages} páginas`}
          status={successStatus}
        />
        <MetricChip
          label="Cobertura visual"
          value={health.visualCoverageRate}
          hint={`${health.pagesWithVisualEmbedding} de ${totalPages} com embedding`}
          status={visualStatus}
        />
        <MetricChip
          label="Páginas produtivas"
          value={health.productiveRate}
          hint={`${health.pagesWithProducts} de ${totalPages} com produtos`}
          status="neutral"
        />
        <MetricChip
          label="Qualidade de extração"
          value={health.functionGroupRate}
          hint={
            totalProducts > 0
              ? `${health.productsWithFunctionGroup} de ${totalProducts} com functionGroup`
              : "sem produtos detectados"
          }
          status={fgStatus}
        />
      </div>

      {health.warnings.length > 0 && (
        <div className="flex flex-col gap-2">
          <p
            className={`text-sm font-medium ${warningTone} ${warningToneDark}`}
          >
            Atenção
          </p>
          <ul className="flex flex-col gap-1.5">
            {health.warnings.map((w, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm text-zinc-600 dark:text-zinc-400"
              >
                <span
                  aria-hidden="true"
                  className="text-zinc-400 dark:text-zinc-600"
                >
                  ─
                </span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {health.functionGroupDistribution.length > 0 && totalProducts > 0 && (
        <details className="group">
          <summary className="cursor-pointer rounded-md text-sm font-medium text-zinc-600 select-none hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:outline-none dark:text-zinc-400 dark:hover:text-zinc-100">
            Ver distribuição de functionGroup (top{" "}
            {health.functionGroupDistribution.length})
          </summary>
          <ul className="mt-4 flex flex-col gap-2">
            {health.functionGroupDistribution.map((g) => {
              const pct = (g.count / totalProducts) * 100;
              return (
                <li key={g.functionGroup} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">
                      {g.functionGroup}
                    </span>
                    <span className="text-zinc-500 tabular-nums dark:text-zinc-400">
                      {g.count} · {pct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-900">
                    <div
                      className="h-full bg-zinc-900 dark:bg-zinc-100"
                      style={{ width: `${Math.min(100, pct).toFixed(1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </section>
  );
}
