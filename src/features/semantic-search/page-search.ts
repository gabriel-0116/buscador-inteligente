import { prisma } from "@/lib/prisma";
import {
  generateTextEmbedding,
  toPgVectorLiteral,
} from "./text-embeddings";
import {
  rerankPageProductMentions,
  type PageProductMentionLike,
  type RerankConfidence,
  type RerankMatchType,
} from "./rerank-page-products";
import {
  buildImageQuerySearchText,
  type ImageQueryProfile,
} from "@/features/visual-search/query-image-analyzer";

// ── Page-level semantic search ──────────────────────────────────────────────
//
// 1. Build searchText from the query profile.
// 2. Generate text embedding.
// 3. Query PageProductMention with pgvector cosine distance (top N).
// 4. Rerank by commercial rules (functionGroup > main product > color > look).
// 5. Group by page (catalog + pageNumber). Each page surfaces its top
//    mention as the matched product.

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
  matchType: RerankMatchType;

  confidence: RerankConfidence;
  score: number;
  reason: string;

  // Additional mentions on the same page that also scored above the floor.
  // The UI shows the top one prominently and lists the rest below.
  otherMatches: Array<{
    mentionId: string;
    productName: string;
    matchType: RerankMatchType;
    confidence: RerankConfidence;
    reason: string;
  }>;
};

type SearchRow = {
  id: string;
  catalogId: string;
  pageId: string;
  pageNumber: number;
  namePt: string;
  category: string | null;
  functionGroup: string | null;
  commercialUse: string | null;
  colors: string[];
  visualAttributes: string[];
  technicalAttributes: string[];
  isKit: boolean;
  kitContains: string[];
  notConfuseWith: string[];
  descriptionPt: string | null;
  pageImageUrl: string;
  catalogFileName: string;
  supplierId: string;
  supplierName: string;
  similarity: number;
};

const PGVECTOR_LIMIT = 200;
const HARD_RESULTS_CAP = 30;

export async function searchPagesByQueryProfile(args: {
  profile: ImageQueryProfile;
}): Promise<PageSearchResult[]> {
  const queryText = buildImageQuerySearchText(args.profile);
  const embedding = await generateTextEmbedding(queryText);
  const vector = toPgVectorLiteral(embedding);

  const rows = await prisma.$queryRaw<
    Array<Omit<SearchRow, "similarity"> & { similarity: unknown }>
  >`
    SELECT
      m.id,
      m."catalogId",
      m."pageId",
      m."pageNumber",
      m."namePt",
      m."category",
      m."functionGroup",
      m."commercialUse",
      m."colors",
      m."visualAttributes",
      m."technicalAttributes",
      m."isKit",
      m."kitContains",
      m."notConfuseWith",
      m."descriptionPt",
      p."imageUrl"    AS "pageImageUrl",
      c."fileName"    AS "catalogFileName",
      c."supplierId"  AS "supplierId",
      s."name"        AS "supplierName",
      (1 - (m.embedding <=> ${vector}::vector))::float8 AS similarity
    FROM "PageProductMention" m
    JOIN "CatalogPage" p ON p.id = m."pageId"
    JOIN "Catalog"     c ON c.id = m."catalogId"
    JOIN "Supplier"    s ON s.id = c."supplierId"
    WHERE m.embedding IS NOT NULL
    ORDER BY m.embedding <=> ${vector}::vector
    LIMIT ${PGVECTOR_LIMIT}
  `;

  if (rows.length === 0) return [];

  const candidates: Array<PageProductMentionLike & SearchRow> = rows.map(
    (r) => ({
      id: r.id,
      catalogId: r.catalogId,
      pageId: r.pageId,
      pageNumber: r.pageNumber,
      namePt: r.namePt,
      category: r.category,
      functionGroup: r.functionGroup,
      commercialUse: r.commercialUse,
      colors: r.colors ?? [],
      visualAttributes: r.visualAttributes ?? [],
      technicalAttributes: r.technicalAttributes ?? [],
      isKit: r.isKit,
      kitContains: r.kitContains ?? [],
      notConfuseWith: r.notConfuseWith ?? [],
      descriptionPt: r.descriptionPt,
      pageImageUrl: r.pageImageUrl,
      catalogFileName: r.catalogFileName,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      similarity: Number(r.similarity),
    })
  );

  const reranked = rerankPageProductMentions({
    queryProfile: args.profile,
    candidates,
  });

  // Group by page, keep the top match per page.
  type PageBucket = {
    primary: (typeof reranked)[number];
    extras: Array<(typeof reranked)[number]>;
  };
  const byPage = new Map<string, PageBucket>();
  for (const r of reranked) {
    if (r.matchType === "rejected") continue;
    const bucket = byPage.get(r.mention.pageId);
    if (!bucket) {
      byPage.set(r.mention.pageId, { primary: r, extras: [] });
    } else {
      bucket.extras.push(r);
    }
  }

  const grouped = Array.from(byPage.values()).sort(
    (a, b) => b.primary.score - a.primary.score
  );

  const results: PageSearchResult[] = grouped
    .slice(0, HARD_RESULTS_CAP)
    .map(({ primary, extras }) => {
      const m = primary.mention as PageProductMentionLike & SearchRow;
      return {
        pageId: m.pageId,
        catalogId: m.catalogId,
        supplierId: m.supplierId,
        supplierName: m.supplierName,
        catalogFileName: m.catalogFileName,
        pageNumber: m.pageNumber,
        pageImageUrl: m.pageImageUrl,
        matchedProductMentionId: m.id,
        matchedProductName: m.namePt,
        matchedFunctionGroup: m.functionGroup ?? "",
        matchType: primary.matchType,
        confidence: primary.confidence,
        score: primary.score,
        reason: primary.reason,
        otherMatches: extras.slice(0, 4).map((e) => ({
          mentionId: e.mention.id,
          productName: e.mention.namePt,
          matchType: e.matchType,
          confidence: e.confidence,
          reason: e.reason,
        })),
      };
    });

  return results;
}
