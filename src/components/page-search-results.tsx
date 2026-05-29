import Image from "next/image";
import Link from "next/link";

// Mirror of the API payload — kept here to avoid pulling server-only types
// (Prisma, etc.) into a client component.

export type MatchType =
  | "exact"
  | "equivalent"
  | "variant"
  | "kit_contains"
  | "accessory"
  | "related_but_not_match"
  | "rejected";
export type MatchConfidence = "high" | "medium" | "low";

export type PageSearchResult = {
  pageId: string;
  catalogId: string;
  supplierId: string;
  supplierName: string;
  catalogFileName: string;
  pageNumber: number;
  pageImageUrl: string;
  matchedProductMentionId: string;
  matchedProductName: string;
  matchedFunctionGroup: string;
  matchType: MatchType;
  confidence: MatchConfidence;
  score: number;
  reason: string;
  otherMatches: Array<{
    mentionId: string;
    productName: string;
    matchType: MatchType;
    confidence: MatchConfidence;
    reason: string;
  }>;
};

export type ImageQueryProfileLite = {
  mainProductNamePt: string;
  functionGroup: string;
  category?: string | null;
  colors?: string[];
  mustNotMatch?: string[];
  confidence?: number;
};

const matchLabel: Record<MatchType, string> = {
  exact: "Produto exato",
  equivalent: "Produto equivalente",
  variant: "Variação",
  kit_contains: "Kit contém",
  accessory: "Acessório",
  related_but_not_match: "Relacionado",
  rejected: "Rejeitado",
};

const confidenceLabel: Record<MatchConfidence, string> = {
  high: "Alta",
  medium: "Média",
  low: "Baixa",
};

const confidenceClass: Record<MatchConfidence, string> = {
  high: "bg-green-100 text-green-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-zinc-100 text-zinc-700",
};

const matchClass: Record<MatchType, string> = {
  exact: "bg-emerald-100 text-emerald-700",
  equivalent: "bg-teal-100 text-teal-700",
  variant: "bg-sky-100 text-sky-700",
  kit_contains: "bg-indigo-100 text-indigo-700",
  accessory: "bg-violet-100 text-violet-700",
  related_but_not_match: "bg-zinc-100 text-zinc-700",
  rejected: "bg-red-100 text-red-700",
};

export function PageSearchResults({
  results,
  profile,
}: {
  results: PageSearchResult[];
  profile?: ImageQueryProfileLite | null;
}) {
  if (results.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-12 text-center text-muted-foreground">
        <p>Nenhuma página de catálogo corresponde ao produto procurado.</p>
        {profile && (
          <p className="text-xs">
            Busca interpretada como{" "}
            <strong className="text-foreground">
              {profile.mainProductNamePt}
            </strong>{" "}
            (função:{" "}
            <span className="font-mono">{profile.functionGroup}</span>).
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {profile && (
        <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            Busca interpretada
          </p>
          <p>
            <strong>{profile.mainProductNamePt}</strong>{" "}
            <span className="text-muted-foreground">
              · função:{" "}
              <span className="font-mono">{profile.functionGroup}</span>
            </span>
          </p>
          {profile.mustNotMatch && profile.mustNotMatch.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Não confundir com: {profile.mustNotMatch.join(", ")}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((r) => (
          <article
            key={r.pageId}
            className="flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
          >
            <Link
              href={`/catalogos/${r.catalogId}?page=${r.pageNumber}`}
              className="block"
            >
              <div className="relative aspect-[3/4] bg-muted">
                <Image
                  src={r.pageImageUrl}
                  alt={`Página ${r.pageNumber} de ${r.catalogFileName}`}
                  fill
                  className="object-contain p-1"
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                />
              </div>
            </Link>
            <div className="flex flex-col gap-2 border-t p-3 text-sm">
              <div className="flex flex-wrap gap-1">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${matchClass[r.matchType]}`}
                >
                  {matchLabel[r.matchType]}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${confidenceClass[r.confidence]}`}
                >
                  Confiança {confidenceLabel[r.confidence]}
                </span>
              </div>

              <div>
                <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
                  Produto encontrado na página
                </p>
                <p
                  className="font-semibold leading-tight"
                  title={r.matchedProductName}
                >
                  {r.matchedProductName}
                </p>
                {r.matchedFunctionGroup && (
                  <p className="text-muted-foreground font-mono text-xs">
                    {r.matchedFunctionGroup}
                  </p>
                )}
              </div>

              <div>
                <p className="text-muted-foreground text-[10px] uppercase tracking-wide">
                  Fornecedor / Catálogo
                </p>
                <p className="truncate font-medium" title={r.supplierName}>
                  {r.supplierName}
                </p>
                <p
                  className="text-muted-foreground truncate text-xs"
                  title={r.catalogFileName}
                >
                  {r.catalogFileName} · pág. {r.pageNumber}
                </p>
              </div>

              {r.reason && (
                <p className="text-muted-foreground text-xs">
                  <strong className="text-foreground">Motivo:</strong>{" "}
                  {r.reason}
                </p>
              )}

              {r.otherMatches.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    +{r.otherMatches.length} outros produtos nesta página
                  </summary>
                  <ul className="mt-1 flex flex-col gap-1 pl-3">
                    {r.otherMatches.map((o) => (
                      <li key={o.mentionId} className="text-muted-foreground">
                        <span className="text-foreground">{o.productName}</span>{" "}
                        — {matchLabel[o.matchType]} (
                        {confidenceLabel[o.confidence]})
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="mt-1 flex justify-between gap-2 text-xs">
                <Link
                  href={`/catalogos/${r.catalogId}?page=${r.pageNumber}`}
                  className="font-medium text-primary hover:underline"
                >
                  Abrir página do catálogo →
                </Link>
                <span className="text-muted-foreground">
                  {Math.round(r.score * 100)}% score
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
