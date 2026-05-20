import { prisma } from "@/lib/prisma";

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

// Minimum cosine similarity gap to treat two results as near-duplicates
const DEDUP_THRESHOLD = 0.97;

export async function searchSimilarImages(
  embedding: number[]
): Promise<SearchResult[]> {
  const vectorStr = `[${embedding.join(",")}]`;

  const rows = await prisma.$queryRaw<
    Array<Omit<SearchResult, "similarity"> & { similarity: unknown }>
  >`
    SELECT
      pc.id,
      pc."cropUrl",
      pc."originalUrl",
      pc."catalogId",
      pc."detectedLabel",
      pc."functionGroup",
      pc.confidence,
      (1 - (pc.embedding <=> ${vectorStr}::vector))::float8 AS similarity,
      c."fileName" AS "catalogFileName",
      s.name AS "supplierName"
    FROM "ProductCandidate" pc
    JOIN "Catalog" c ON c.id = pc."catalogId"
    JOIN "Supplier" s ON s.id = c."supplierId"
    WHERE pc.embedding IS NOT NULL
    ORDER BY
      CASE WHEN pc."sourceType" = 'PAGE_CROP' THEN 0 ELSE 1 END,
      pc.embedding <=> ${vectorStr}::vector
    LIMIT 100
  `;

  const candidates = rows.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
  }));

  // Deduplicate: skip candidates from the same catalog whose cropUrl matches
  // or whose similarity is extremely close (same crop uploaded more than once)
  const seenUrls = new Set<string>();
  const selected: SearchResult[] = [];

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.cropUrl)) continue;

    // Also dedup by near-identical similarity within the same catalog
    let isDupe = false;
    for (const prev of selected) {
      if (
        prev.catalogId === candidate.catalogId &&
        Math.abs(prev.similarity - candidate.similarity) < 1 - DEDUP_THRESHOLD
      ) {
        isDupe = true;
        break;
      }
    }

    if (!isDupe) {
      seenUrls.add(candidate.cropUrl);
      selected.push(candidate as SearchResult);
      if (selected.length === 20) break;
    }
  }

  return selected;
}
