import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { toPgVectorLiteral } from "@/features/semantic-search/text-embeddings";
import type { PdfLayoutPage } from "./pdf-layout-extractor";

// ── Page-level deduplication ────────────────────────────────────────────────
//
// Weekly catalog uploads from the same supplier are overwhelmingly reprints
// of the previous week's PDF with a price tweak here and a product
// added/removed there. Re-running the paid analyzer on every page wastes
// money. This module asks one question before the analyzer fires:
//
//   "Have I already analyzed a page that looks the same and reads the
//    same, from this same supplier, in a different (READY) catalog?"
//
// If yes, we COPY that page's PageProductMention rows into the new page
// (including the 1536-dim text embeddings, via a single UPDATE...FROM)
// and skip the analyzer. The audit trail is a PageAnalysis row with
// `_dedup` metadata pointing back at the source.
//
// Two signals, in order:
//
//   1. Visual cosine ≥ DEDUP_VISUAL_THRESHOLD (default 0.97). Gate. Done
//      via pgvector on `CatalogPage.visualEmbedding` (768d DINOv2 already
//      generated upstream in process-catalog).
//   2. SHA-1 over the page's PDF text, normalized (lowercased, letters-only,
//      whitespace-collapsed). Equal → confirm dedup. Numbers/punctuation
//      stripped so a price change (R$ 89,90 → R$ 92,00) still hashes equal.
//      Missing on either side → fall back to a stricter visual gate
//      (DEDUP_VISUAL_THRESHOLD_STRICT, default 0.99).
//
// The text hash is stashed in PageAnalysis.rawJson._meta.pdfTextHash on
// every page we process going forward. First time you run with dedup on,
// nothing matches (no historical hashes). Second run onward, weekly
// reprints start short-circuiting.

const DEFAULT_VISUAL_THRESHOLD = 0.97;
const DEFAULT_VISUAL_THRESHOLD_STRICT = 0.99;

export type DedupConfig = {
  enabled: boolean;
  visualThreshold: number;
  visualThresholdStrict: number;
};

export function loadDedupConfig(): DedupConfig {
  const enabled = (process.env.DEDUP_ENABLED ?? "true").toLowerCase() !== "false";
  const visualThreshold = clamp01(
    Number(process.env.DEDUP_VISUAL_THRESHOLD ?? DEFAULT_VISUAL_THRESHOLD)
  );
  const visualThresholdStrict = clamp01(
    Number(
      process.env.DEDUP_VISUAL_THRESHOLD_STRICT ??
        DEFAULT_VISUAL_THRESHOLD_STRICT
    )
  );
  return { enabled, visualThreshold, visualThresholdStrict };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_VISUAL_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

// Normalize the page's PDF text into a stable, change-tolerant signature.
// Strips digits + punctuation + whitespace runs so price/date changes don't
// invalidate the hash, but a product added (different brand/model token)
// does change it.
export function computePageTextHash(
  layout: PdfLayoutPage | undefined
): string | null {
  if (!layout) return null;
  const parts: string[] = [];
  for (const block of layout.blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;

  const normalized = parts
    .join(" ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z]+/g, " ")
    .trim();

  if (normalized.length < 8) return null;
  return createHash("sha1").update(normalized).digest("hex");
}

type DedupCandidate = {
  sourcePageId: string;
  sourceCatalogId: string;
  similarity: number;
  pdfTextHash: string | null;
  mentionCount: number;
};

// Pull the top visually-similar candidate page from a sibling catalog of the
// same supplier. We only consider READY catalogs with at least one mention
// on the candidate page (otherwise there's nothing to copy).
async function findVisualCandidate(args: {
  supplierId: string;
  excludeCatalogId: string;
  embedding: number[];
  minSimilarity: number;
}): Promise<DedupCandidate | null> {
  const vec = toPgVectorLiteral(args.embedding);
  const rows = await prisma.$queryRaw<
    Array<{
      pageId: string;
      catalogId: string;
      similarity: number;
      mentionCount: bigint;
    }>
  >`
    SELECT
      p.id              AS "pageId",
      p."catalogId"     AS "catalogId",
      (1 - (p."visualEmbedding" <=> ${vec}::vector))::float8 AS "similarity",
      COUNT(m.id)::bigint AS "mentionCount"
    FROM "CatalogPage" p
    JOIN "Catalog" c ON c.id = p."catalogId"
    LEFT JOIN "PageProductMention" m ON m."pageId" = p.id
    WHERE c."supplierId" = ${args.supplierId}
      AND c.id <> ${args.excludeCatalogId}
      AND c."status" = 'READY'
      AND p."visualEmbedding" IS NOT NULL
    GROUP BY p.id, p."catalogId"
    HAVING COUNT(m.id) > 0
       AND (1 - (p."visualEmbedding" <=> ${vec}::vector)) >= ${args.minSimilarity}
    ORDER BY p."visualEmbedding" <=> ${vec}::vector ASC
    LIMIT 1
  `;

  const row = rows[0];
  if (!row) return null;

  // Look up the candidate's stored text hash via PageAnalysis._meta. May be
  // null on legacy rows written before dedup landed — the caller falls back
  // to the strict visual threshold in that case.
  const analysis = await prisma.pageAnalysis.findFirst({
    where: { pageId: row.pageId },
    select: { rawJson: true },
    orderBy: { createdAt: "desc" },
  });
  const storedHash = extractStoredTextHash(analysis?.rawJson);

  return {
    sourcePageId: row.pageId,
    sourceCatalogId: row.catalogId,
    similarity: row.similarity,
    pdfTextHash: storedHash,
    mentionCount: Number(row.mentionCount),
  };
}

function extractStoredTextHash(rawJson: unknown): string | null {
  if (!rawJson || typeof rawJson !== "object") return null;
  const meta = (rawJson as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return null;
  const hash = (meta as Record<string, unknown>).pdfTextHash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

export type DedupDecision =
  | { matched: true; source: DedupCandidate }
  | { matched: false; reason: string };

// Decide whether the incoming page is a duplicate of an existing one. Pure
// read-only — the actual copy is done by `copyMentionsFromPage`.
export async function findDuplicatePage(args: {
  config: DedupConfig;
  supplierId: string;
  excludeCatalogId: string;
  pageEmbedding: number[] | null;
  pageTextHash: string | null;
}): Promise<DedupDecision> {
  if (!args.config.enabled) {
    return { matched: false, reason: "dedup_disabled" };
  }
  if (!args.pageEmbedding || args.pageEmbedding.length === 0) {
    return { matched: false, reason: "no_visual_embedding" };
  }

  const candidate = await findVisualCandidate({
    supplierId: args.supplierId,
    excludeCatalogId: args.excludeCatalogId,
    embedding: args.pageEmbedding,
    minSimilarity: args.config.visualThreshold,
  });
  if (!candidate) return { matched: false, reason: "no_visual_candidate" };

  const haveBothHashes =
    args.pageTextHash !== null && candidate.pdfTextHash !== null;

  if (haveBothHashes) {
    if (args.pageTextHash === candidate.pdfTextHash) {
      return { matched: true, source: candidate };
    }
    return { matched: false, reason: "text_hash_mismatch" };
  }

  // One side lacks the hash (legacy row or PyMuPDF empty). Require a very
  // high visual match before trusting the dedup.
  if (candidate.similarity >= args.config.visualThresholdStrict) {
    return { matched: true, source: candidate };
  }
  return { matched: false, reason: "no_text_hash_and_visual_below_strict" };
}

// Copy every PageProductMention from the source page into the new page,
// including the 1536-dim embedding. Returns the number of mentions copied.
// Implemented in three SQL roundtrips:
//
//   1. fetch source rows (no embedding — we don't need it in JS)
//   2. one Prisma.create per row (gets us a cuid + Json marshaling for free)
//   3. one UPDATE…FROM that copies embeddings in bulk, paired by
//      displayOrder which is unique per (pageId, displayOrder).
export async function copyMentionsFromPage(args: {
  sourcePageId: string;
  targetPageId: string;
  targetCatalogId: string;
  targetPageNumber: number;
}): Promise<number> {
  const sourceMentions = await prisma.pageProductMention.findMany({
    where: { pageId: args.sourcePageId },
    orderBy: { displayOrder: "asc" },
  });
  if (sourceMentions.length === 0) return 0;

  for (const src of sourceMentions) {
    await prisma.pageProductMention.create({
      data: {
        catalogId: args.targetCatalogId,
        pageId: args.targetPageId,
        pageNumber: args.targetPageNumber,
        displayOrder: src.displayOrder,
        namePt: src.namePt,
        originalName: src.originalName,
        descriptionPt: src.descriptionPt,
        category: src.category,
        functionGroup: src.functionGroup,
        brand: src.brand,
        modelCodes: src.modelCodes,
        aliases: src.aliases,
        colors: src.colors,
        visualAttributes: src.visualAttributes,
        technicalAttributes: src.technicalAttributes,
        notConfuseWith: src.notConfuseWith,
        commercialUse: src.commercialUse,
        isKit: src.isKit,
        kitContains: src.kitContains,
        confidence: src.confidence,
        evidenceText: src.evidenceText,
        evidenceSource: src.evidenceSource,
        searchText: src.searchText,
        rawJson: src.rawJson ?? undefined,
      },
    });
  }

  // Bulk-copy the 1536-dim embeddings via displayOrder pairing. NULL-safe:
  // mentions without an embedding stay NULL on the target side.
  await prisma.$executeRaw`
    UPDATE "PageProductMention" AS dst
    SET embedding = src.embedding
    FROM "PageProductMention" AS src
    WHERE dst."pageId" = ${args.targetPageId}
      AND src."pageId" = ${args.sourcePageId}
      AND dst."displayOrder" IS NOT NULL
      AND src."displayOrder" IS NOT NULL
      AND dst."displayOrder" = src."displayOrder"
  `;

  return sourceMentions.length;
}
