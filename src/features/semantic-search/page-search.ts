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
  type RerankedMention,
} from "./rerank-page-products";
import {
  buildImageQuerySearchText,
  type ImageQueryProfile,
} from "@/features/visual-search/query-image-analyzer";

// ── Page-level semantic search (hybrid: text + full-page visual) ────────────
//
// Primary signal: text/semantic similarity over PageProductMention.embedding.
// Secondary signal: DINOv2 cosine over CatalogPage.visualEmbedding. Visual
// can boost a semantic hit's score, but never promote a visual-only hit
// above "low confidence" (and only when at least one mention on the page
// has a compatible functionGroup and no mustNotMatch violation).

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
  matchedBrand: string | null;
  matchedModelCodes: string[];
  matchType: RerankMatchType;

  confidence: RerankConfidence;
  score: number;
  reason: string;

  // Hybrid signals — undefined when not applicable.
  semanticScore?: number;
  visualSimilarity?: number;
  matchedByVisualPage?: boolean;

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

type SemanticRow = {
  id: string;
  catalogId: string;
  pageId: string;
  pageNumber: number;
  namePt: string;
  originalName: string | null;
  brand: string | null;
  modelCodes: string[];
  aliases: string[];
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
  evidenceText: string | null;
  pageImageUrl: string;
  catalogFileName: string;
  supplierId: string;
  supplierName: string;
  similarity: number;
};

type VisualRow = {
  pageId: string;
  catalogId: string;
  pageNumber: number;
  pageImageUrl: string;
  catalogFileName: string;
  supplierId: string;
  supplierName: string;
  visualSimilarity: number;
};

const PGVECTOR_LIMIT = 200;
const VISUAL_LIMIT = 60;
const HARD_RESULTS_CAP = 30;

// Hybrid weights — semantic dominates, visual just nudges.
const SEMANTIC_WEIGHT = 0.75;
const VISUAL_WEIGHT = 0.25;

// Visual-only entry guards. Below this the page never shows up from visual
// alone; pages above it still need a compatible functionGroup mention.
const VISUAL_ONLY_MIN_SIMILARITY = 0.55;

// Only these reach the public search UI. `related_but_not_match` and
// `accessory` would just pollute the list — they may surface later as
// secondary "you might also like" but never as the primary answer.
// `rejected` is always hidden. Debug callers can pass
// `includeAllMatches: true` to bypass this filter.
const PUBLIC_MATCH_TYPES = new Set<RerankMatchType>([
  "exact",
  "equivalent",
  "variant",
  "kit_contains",
]);

// ── Public entry point ──────────────────────────────────────────────────────

export async function searchPagesByQueryProfile(args: {
  profile: ImageQueryProfile;
  // Pre-computed DINOv2 embedding of the query image. When provided, the
  // search runs in hybrid mode. When undefined, semantic-only.
  queryVisualEmbedding?: number[];
  includeAllMatches?: boolean;
}): Promise<PageSearchResult[]> {
  const includeAll = args.includeAllMatches === true;

  const [reranked, visualResults] = await Promise.all([
    runSemanticAndRerank(args.profile),
    args.queryVisualEmbedding && args.queryVisualEmbedding.length > 0
      ? searchCatalogPagesByVisualEmbedding({
          embedding: args.queryVisualEmbedding,
          limit: VISUAL_LIMIT,
        })
      : Promise.resolve([] as VisualRow[]),
  ]);

  const visualByPageId = new Map<string, VisualRow>();
  for (const v of visualResults) visualByPageId.set(v.pageId, v);

  // 1) Group semantic results by page (top by score per page).
  type PageBucket = {
    primary: RerankedMention;
    extras: RerankedMention[];
    semanticOnly: boolean;
  };
  const byPage = new Map<string, PageBucket>();
  for (const r of reranked) {
    if (r.matchType === "rejected" && !includeAll) continue;
    if (!includeAll && !PUBLIC_MATCH_TYPES.has(r.matchType)) continue;
    const bucket = byPage.get(r.mention.pageId);
    if (!bucket) {
      byPage.set(r.mention.pageId, {
        primary: r,
        extras: [],
        semanticOnly: !visualByPageId.has(r.mention.pageId),
      });
    } else {
      bucket.extras.push(r);
    }
  }

  // 2) Visual-only pages: try to elevate them to low-confidence variants
  //    when there's a mention on the page with a compatible functionGroup
  //    AND no mustNotMatch violation. Otherwise drop.
  if (visualResults.length > 0) {
    const semanticPageIds = new Set(byPage.keys());
    const visualOnlyPageIds = visualResults
      .filter((v) => !semanticPageIds.has(v.pageId))
      .filter((v) => v.visualSimilarity >= VISUAL_ONLY_MIN_SIMILARITY)
      .map((v) => v.pageId);

    if (visualOnlyPageIds.length > 0) {
      const visualOnlyMentions = await fetchMentionsForPages(visualOnlyPageIds);
      const visualOnlyResults = buildVisualOnlyResults({
        profile: args.profile,
        visualResults,
        mentionsByPageId: visualOnlyMentions,
      });
      for (const r of visualOnlyResults) {
        if (!includeAll && !PUBLIC_MATCH_TYPES.has(r.primary.matchType)) {
          continue;
        }
        byPage.set(r.primary.mention.pageId, {
          primary: r.primary,
          extras: [],
          semanticOnly: false,
        });
      }
    }
  }

  // 3) Apply hybrid score where both signals exist.
  const grouped = Array.from(byPage.entries()).map(([pageId, bucket]) => {
    const visual = visualByPageId.get(pageId);
    const semanticScore = bucket.primary.score;
    const visualSimilarity = visual?.visualSimilarity;
    const matchedByVisualPage =
      bucket.primary.reason.startsWith("[visual]") ||
      (visual != null && !bucket.semanticOnly);

    let finalScore = semanticScore;
    if (visual && !bucket.primary.reason.startsWith("[visual]")) {
      finalScore =
        semanticScore * SEMANTIC_WEIGHT + visual.visualSimilarity * VISUAL_WEIGHT;
    }

    return {
      bucket,
      visual,
      semanticScore,
      visualSimilarity,
      matchedByVisualPage,
      finalScore,
    };
  });

  grouped.sort((a, b) => b.finalScore - a.finalScore);

  // 4) Materialize PageSearchResult.
  const results: PageSearchResult[] = grouped
    .slice(0, HARD_RESULTS_CAP)
    .map(({ bucket, visualSimilarity, matchedByVisualPage, semanticScore, finalScore }) => {
      const m = bucket.primary.mention as PageProductMentionLike & {
        pageImageUrl?: string;
        catalogFileName?: string;
        supplierId?: string;
        supplierName?: string;
      };
      const pageImageUrl =
        m.pageImageUrl ?? visualByPageId.get(m.pageId)?.pageImageUrl ?? "";
      const catalogFileName =
        m.catalogFileName ??
        visualByPageId.get(m.pageId)?.catalogFileName ??
        "";
      const supplierId =
        m.supplierId ?? visualByPageId.get(m.pageId)?.supplierId ?? "";
      const supplierName =
        m.supplierName ?? visualByPageId.get(m.pageId)?.supplierName ?? "";
      return {
        pageId: m.pageId,
        catalogId: m.catalogId,
        supplierId,
        supplierName,
        catalogFileName,
        pageNumber: m.pageNumber,
        pageImageUrl,
        matchedProductMentionId: m.id,
        matchedProductName: m.namePt,
        matchedFunctionGroup: m.functionGroup ?? "",
        matchedBrand: m.brand ?? null,
        matchedModelCodes: m.modelCodes ?? [],
        matchType: bucket.primary.matchType,
        confidence: bucket.primary.confidence,
        score: finalScore,
        reason: bucket.primary.reason,
        semanticScore,
        visualSimilarity,
        matchedByVisualPage: matchedByVisualPage || undefined,
        otherMatches: bucket.extras.slice(0, 4).map((e) => ({
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

// ── Semantic branch: pgvector → rerank ──────────────────────────────────────

async function runSemanticAndRerank(
  profile: ImageQueryProfile
): Promise<RerankedMention[]> {
  const queryText = buildImageQuerySearchText(profile);
  const embedding = await generateTextEmbedding(queryText);
  const vector = toPgVectorLiteral(embedding);

  const rows = await prisma.$queryRaw<
    Array<Omit<SemanticRow, "similarity"> & { similarity: unknown }>
  >`
    SELECT
      m.id,
      m."catalogId",
      m."pageId",
      m."pageNumber",
      m."namePt",
      m."originalName",
      m."brand",
      m."modelCodes",
      m."aliases",
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
      m."evidenceText",
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

  const candidates: Array<PageProductMentionLike & SemanticRow> = rows.map(
    (r) => ({
      id: r.id,
      catalogId: r.catalogId,
      pageId: r.pageId,
      pageNumber: r.pageNumber,
      namePt: r.namePt,
      originalName: r.originalName,
      brand: r.brand,
      modelCodes: r.modelCodes ?? [],
      aliases: r.aliases ?? [],
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
      evidenceText: r.evidenceText,
      pageImageUrl: r.pageImageUrl,
      catalogFileName: r.catalogFileName,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      similarity: Number(r.similarity),
    })
  );

  return rerankPageProductMentions({
    queryProfile: profile,
    candidates,
  });
}

// ── Visual branch: full-page DINOv2 cosine ──────────────────────────────────

export async function searchCatalogPagesByVisualEmbedding(args: {
  embedding: number[];
  limit?: number;
}): Promise<VisualRow[]> {
  if (args.embedding.length === 0) return [];
  const vector = toPgVectorLiteral(args.embedding);
  const limit = args.limit ?? VISUAL_LIMIT;

  const rows = await prisma.$queryRaw<
    Array<Omit<VisualRow, "visualSimilarity"> & { visualSimilarity: unknown }>
  >`
    SELECT
      p.id            AS "pageId",
      p."catalogId",
      p."pageNumber",
      p."imageUrl"    AS "pageImageUrl",
      c."fileName"    AS "catalogFileName",
      c."supplierId"  AS "supplierId",
      s."name"        AS "supplierName",
      (1 - (p."visualEmbedding" <=> ${vector}::vector))::float8 AS "visualSimilarity"
    FROM "CatalogPage" p
    JOIN "Catalog"  c ON c.id = p."catalogId"
    JOIN "Supplier" s ON s.id = c."supplierId"
    WHERE p."visualEmbedding" IS NOT NULL
    ORDER BY p."visualEmbedding" <=> ${vector}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    pageId: r.pageId,
    catalogId: r.catalogId,
    pageNumber: r.pageNumber,
    pageImageUrl: r.pageImageUrl,
    catalogFileName: r.catalogFileName,
    supplierId: r.supplierId,
    supplierName: r.supplierName,
    visualSimilarity: Number(r.visualSimilarity),
  }));
}

// ── Visual-only branch: elevate compatible pages ───────────────────────────

async function fetchMentionsForPages(
  pageIds: string[]
): Promise<Map<string, Array<PageProductMentionLike & SemanticRow>>> {
  if (pageIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<Omit<SemanticRow, "similarity"> & {
    similarity: unknown;
  }>>`
    SELECT
      m.id,
      m."catalogId",
      m."pageId",
      m."pageNumber",
      m."namePt",
      m."originalName",
      m."brand",
      m."modelCodes",
      m."aliases",
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
      m."evidenceText",
      p."imageUrl"    AS "pageImageUrl",
      c."fileName"    AS "catalogFileName",
      c."supplierId"  AS "supplierId",
      s."name"        AS "supplierName",
      0::float8 AS similarity
    FROM "PageProductMention" m
    JOIN "CatalogPage" p ON p.id = m."pageId"
    JOIN "Catalog"     c ON c.id = m."catalogId"
    JOIN "Supplier"    s ON s.id = c."supplierId"
    WHERE m."pageId" = ANY(${pageIds}::text[])
  `;

  const byPage = new Map<string, Array<PageProductMentionLike & SemanticRow>>();
  for (const r of rows) {
    const row: PageProductMentionLike & SemanticRow = {
      id: r.id,
      catalogId: r.catalogId,
      pageId: r.pageId,
      pageNumber: r.pageNumber,
      namePt: r.namePt,
      originalName: r.originalName,
      brand: r.brand,
      modelCodes: r.modelCodes ?? [],
      aliases: r.aliases ?? [],
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
      evidenceText: r.evidenceText,
      pageImageUrl: r.pageImageUrl,
      catalogFileName: r.catalogFileName,
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      similarity: 0,
    };
    const list = byPage.get(row.pageId) ?? [];
    list.push(row);
    byPage.set(row.pageId, list);
  }
  return byPage;
}

function buildVisualOnlyResults(args: {
  profile: ImageQueryProfile;
  visualResults: VisualRow[];
  mentionsByPageId: Map<string, Array<PageProductMentionLike & SemanticRow>>;
}): Array<{ primary: RerankedMention }> {
  // Run a tiny rerank per page on the available mentions: we feed them
  // through the same reranker (with similarity=0) and pick the best
  // *non-rejected* one whose functionGroup is compatible.
  const out: Array<{ primary: RerankedMention }> = [];
  for (const visual of args.visualResults) {
    const mentions = args.mentionsByPageId.get(visual.pageId);
    if (!mentions || mentions.length === 0) continue;
    const reranked = rerankPageProductMentions({
      queryProfile: args.profile,
      candidates: mentions,
    });
    // Need a non-rejected, non-related-but-not-match mention. variant /
    // equivalent / exact are all fine as anchors for the visual hit.
    const anchor = reranked.find(
      (r) => r.matchType !== "rejected" && r.matchType !== "related_but_not_match"
    );
    if (!anchor) continue;
    out.push({
      primary: {
        ...anchor,
        // Visual-only never promotes to high confidence per atualizacao.md.
        matchType: "variant",
        confidence: "low",
        score: visual.visualSimilarity * 0.6,
        reason: `[visual] página visualmente parecida (${Math.round(
          visual.visualSimilarity * 100
        )}%) — produto na página: ${anchor.mention.namePt}`,
      },
    });
  }
  return out;
}
