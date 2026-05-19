import { prisma } from "@/lib/prisma";

type SearchResult = {
  id: string;
  imageUrl: string;
  catalogId: string;
  similarity: number;
  catalogFileName: string;
  supplierName: string;
};

// Minimum cosine similarity to treat two results as duplicates (same product, different page)
const DEDUP_THRESHOLD = 0.97;

export async function searchSimilarImages(
  embedding: number[]
): Promise<SearchResult[]> {
  const vectorStr = `[${embedding.join(",")}]`;

  // Fetch a larger candidate pool so deduplication doesn't reduce final count too much
  const rows = await prisma.$queryRaw<
    Array<Omit<SearchResult, "similarity"> & { similarity: unknown }>
  >`
    SELECT
      pi.id,
      pi."imageUrl",
      pi."catalogId",
      (1 - (pi.embedding <=> ${vectorStr}::vector))::float8 AS similarity,
      c."fileName" AS "catalogFileName",
      s.name AS "supplierName"
    FROM "ProductImage" pi
    JOIN "Catalog" c ON c.id = pi."catalogId"
    JOIN "Supplier" s ON s.id = c."supplierId"
    WHERE pi.embedding IS NOT NULL
    ORDER BY pi.embedding <=> ${vectorStr}::vector
    LIMIT 60
  `;

  const candidates = rows.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
  }));

  // Deduplicate: two images from the same catalog with the same similarity score
  // have identical embeddings (same product on multiple PDF pages) — keep only the first.
  const seen = new Set<string>();
  const selected: SearchResult[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.catalogId}:${candidate.similarity.toFixed(8)}`;
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(candidate as SearchResult);
      if (selected.length === 20) break;
    }
  }

  return selected;
}
