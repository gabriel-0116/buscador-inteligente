import type { CatalogHealth } from "@/server/services/catalog-health";

// ── Catalog processing health panel ─────────────────────────────────────────
//
// Server-rendered observability card. No client state — the parent page is
// already SSR + AutoRefresh while PROCESSING, which is enough.

const statusDotClass: Record<CatalogHealth["overallStatus"], string> = {
  green: "bg-green-500 ring-green-100",
  yellow: "bg-yellow-500 ring-yellow-100",
  red: "bg-red-500 ring-red-100",
};

const statusLabel: Record<CatalogHealth["overallStatus"], string> = {
  green: "Pronto pra busca",
  yellow: "Processado com avisos — pode usar, mas vale revisar",
  red: "Precisa reprocessar antes de usar na busca",
};

const statusTextClass: Record<CatalogHealth["overallStatus"], string> = {
  green: "text-green-700",
  yellow: "text-yellow-800",
  red: "text-red-700",
};

function rateTone(value: number): string {
  if (value >= 0.95) return "text-green-700";
  if (value >= 0.7) return "text-yellow-700";
  return "text-red-700";
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  const pct = Math.round(value * 100);
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
        {label}
      </p>
      <p className={`text-2xl font-bold ${rateTone(value)}`}>{pct}%</p>
      <p className="text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}

export function CatalogHealthPanel({ health }: { health: CatalogHealth }) {
  const { totalPages, totalProducts } = health;
  const analyzedPages = totalPages - health.pagesWithError;

  return (
    <section className="bg-card flex flex-col gap-4 rounded-xl border p-5 shadow-xs">
      <header className="flex items-start gap-4">
        <div
          className={`mt-1 h-10 w-10 flex-shrink-0 rounded-full ring-4 ${statusDotClass[health.overallStatus]}`}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Saúde do processamento</h2>
          <p
            className={`text-sm font-medium ${statusTextClass[health.overallStatus]}`}
          >
            {statusLabel[health.overallStatus]}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard
          label="Taxa de sucesso"
          value={health.pageSuccessRate}
          hint={`${analyzedPages}/${totalPages} páginas sem erro`}
        />
        <MetricCard
          label="Cobertura visual"
          value={health.visualCoverageRate}
          hint={`${health.pagesWithVisualEmbedding}/${totalPages} com embedding`}
        />
        <MetricCard
          label="Páginas produtivas"
          value={health.productiveRate}
          hint={`${health.pagesWithProducts}/${totalPages} com produtos`}
        />
        <MetricCard
          label="Qualidade de extração"
          value={health.functionGroupRate}
          hint={
            totalProducts > 0
              ? `${health.productsWithFunctionGroup}/${totalProducts} com functionGroup`
              : "sem produtos detectados"
          }
        />
      </div>

      {health.warnings.length > 0 && (
        <ul className="flex flex-col gap-2">
          {health.warnings.map((w, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900"
            >
              <span className="mt-0.5 text-amber-600" aria-hidden="true">
                ⚠
              </span>
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {health.functionGroupDistribution.length > 0 && totalProducts > 0 && (
        <details className="group">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-sm font-medium select-none">
            Ver distribuição de functionGroup (top{" "}
            {health.functionGroupDistribution.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {health.functionGroupDistribution.map((g) => {
              const pct = (g.count / totalProducts) * 100;
              return (
                <li key={g.functionGroup} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground font-mono">
                      {g.functionGroup}
                    </span>
                    <span className="text-muted-foreground">
                      {g.count} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded">
                    <div
                      className="bg-emerald-400 h-full"
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
