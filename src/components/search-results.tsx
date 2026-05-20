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
};

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
      {results.map((r) => (
        <div
          key={r.id}
          className="overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
        >
          <a href={r.cropUrl} target="_blank" rel="noopener noreferrer">
            <div className="relative aspect-square bg-muted">
              <Image
                src={r.cropUrl}
                alt={`Candidato de ${r.supplierName}`}
                fill
                className="object-contain p-1"
                sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
              />
            </div>
          </a>
          <div className="border-t p-2 flex flex-col gap-0.5">
            <p className="truncate text-xs font-semibold">{r.supplierName}</p>
            <p className="truncate text-xs text-muted-foreground">{r.catalogFileName}</p>
            {r.detectedLabel && (
              <p className="truncate text-xs text-muted-foreground">{r.detectedLabel}</p>
            )}
            <p className="mt-0.5 text-xs font-medium text-primary">
              {Math.round(r.similarity * 100)}% similar
            </p>
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
      ))}
    </div>
  );
}
