import Image from "next/image";

export type SearchResult = {
  id: string;
  imageUrl: string;
  catalogId: string;
  similarity: number;
  catalogFileName: string;
  supplierName: string;
};

export function SearchResults({ results }: { results: SearchResult[] }) {
  if (results.length === 0) {
    return (
      <p className="py-12 text-center text-muted-foreground">
        Nenhum resultado encontrado.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
      {results.map((r) => (
        <a
          key={r.id}
          href={r.imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
        >
          <div className="relative aspect-square bg-muted">
            <Image
              src={r.imageUrl}
              alt={`Produto de ${r.supplierName}`}
              fill
              className="object-contain p-1"
              sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, 25vw"
            />
          </div>
          <div className="border-t p-2">
            <p className="truncate text-xs font-semibold">{r.supplierName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {r.catalogFileName}
            </p>
            <p className="mt-0.5 text-xs font-medium text-primary">
              {Math.round(r.similarity * 100)}% similar
            </p>
          </div>
        </a>
      ))}
    </div>
  );
}
