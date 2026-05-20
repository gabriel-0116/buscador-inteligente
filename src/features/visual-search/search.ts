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
  qualityScore: number | null;
  // Structured product metadata from the vision detector (nullable when
  // the candidate came from the heuristic path).
  productName: string | null;
  productNamePt: string | null;
  category: string | null;
  model: string | null;
  descriptionPt: string | null;
  sourceDetector: string | null;
};

const DEDUP_THRESHOLD = 0.97;
const MIN_QUALITY = 0.5;

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
      pc."qualityScore",
      pc."productName",
      pc."productNamePt",
      pc."category",
      pc."model",
      pc."descriptionPt",
      pc."sourceDetector",
      (1 - (pc.embedding <=> ${vectorStr}::vector))::float8 AS similarity,
      c."fileName" AS "catalogFileName",
      s.name AS "supplierName"
    FROM "ProductCandidate" pc
    JOIN "Catalog" c ON c.id = pc."catalogId"
    JOIN "Supplier" s ON s.id = c."supplierId"
    WHERE pc.embedding IS NOT NULL
      AND pc."isSearchable" = true
      AND pc."qualityScore" >= ${MIN_QUALITY}
    ORDER BY
      CASE WHEN pc."sourceType" = 'PAGE_CROP' THEN 0 ELSE 1 END,
      pc.embedding <=> ${vectorStr}::vector
    LIMIT 100
  `;

  const candidates = rows.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
  }));

  // Deduplicate by cropUrl and near-identical similarity within same catalog
  const seenUrls = new Set<string>();
  const selected: SearchResult[] = [];

  for (const candidate of candidates) {
    if (seenUrls.has(candidate.cropUrl)) continue;

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
