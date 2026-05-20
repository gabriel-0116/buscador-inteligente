import Image from "next/image";

export type SearchResult = {
  id: string;
  cropUrl: string;
  originalUrl: string;
  catalogId: string;
  similarity: number;
  catalogFileName: string;
  supplierName: string;
  detectedLabel: string | null;
  functionGroup: string | null;
  confidence: number | null;
  qualityScore: number | null;
  productName: string | null;
  productNamePt: string | null;
  category: string | null;
  model: string | null;
  descriptionPt: string | null;
  sourceDetector: string | null;
};

function displayName(r: SearchResult): string | null {
  return r.productNamePt ?? r.productName ?? r.detectedLabel ?? null;
}

export function SearchResults({ results }: { results: SearchResult[] }) {
  if (results.length === 0) {
    return (
      <p className="py-12 text-center text-muted-foreground">
        Nenhum resultado encontrado nos catálogos.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {results.map((r) => {
        const name = displayName(r);
        return (
          <div
            key={r.id}
            className="overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
          >
            <a href={r.cropUrl} target="_blank" rel="noopener noreferrer">
              <div className="relative aspect-square bg-muted">
                <Image
                  src={r.cropUrl}
                  alt={name ?? `Candidato de ${r.supplierName}`}
                  fill
                  className="object-contain p-1"
                  sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
                />
              </div>
            </a>
            <div className="border-t p-2 flex flex-col gap-0.5">
              {name && (
                <p className="truncate text-sm font-semibold" title={name}>
                  {name}
                </p>
              )}
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Encontrado no catálogo
              </p>
              <p className="truncate text-xs font-medium">{r.supplierName}</p>
              <p className="truncate text-xs text-muted-foreground" title={r.catalogFileName}>
                {r.catalogFileName}
              </p>

              {(r.category || r.functionGroup) && (
                <p className="truncate text-xs text-muted-foreground">
                  {[r.category, r.functionGroup].filter(Boolean).join(" · ")}
                </p>
              )}
              {r.model && (
                <p className="truncate text-xs text-muted-foreground">
                  Modelo: {r.model}
                </p>
              )}
              {r.descriptionPt && (
                <p className="line-clamp-2 text-xs text-muted-foreground" title={r.descriptionPt}>
                  {r.descriptionPt}
                </p>
              )}

              <p className="mt-0.5 text-xs font-medium text-primary">
                {Math.round(r.similarity * 100)}% similar
              </p>
              {r.qualityScore != null && (
                <p className="text-xs text-muted-foreground">
                  qualidade {Math.round(r.qualityScore * 100)}%
                </p>
              )}
              <a
                href={r.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Ver página original
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
