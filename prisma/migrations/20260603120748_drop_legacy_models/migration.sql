-- Drop the legacy crop pipeline schema. ProductCandidate + ProductImage
-- haven't been written in weeks; PageProductMention is the only search
-- unit. Verified empty rows before issuing DROP (see corresponding chore
-- commit's audit step).

-- ── Drop indexes (idempotent in case Prisma already pruned them) ─────────
DROP INDEX IF EXISTS "ProductCandidate_catalogId_idx";
DROP INDEX IF EXISTS "ProductCandidate_pageId_idx";
DROP INDEX IF EXISTS "ProductCandidate_functionGroup_idx";
DROP INDEX IF EXISTS "ProductCandidate_sourceDetector_idx";
DROP INDEX IF EXISTS "ProductImage_catalogId_idx";

-- ── Drop tables (CASCADE clears any lingering FK refs from old data) ─────
DROP TABLE IF EXISTS "ProductCandidate" CASCADE;
DROP TABLE IF EXISTS "ProductImage" CASCADE;

-- ── Drop the enum used only by ProductCandidate.sourceType ───────────────
DROP TYPE IF EXISTS "CandidateSourceType";

-- ── Drop legacy counter columns on Catalog ───────────────────────────────
ALTER TABLE "Catalog" DROP COLUMN IF EXISTS "candidateCount";
ALTER TABLE "Catalog" DROP COLUMN IF EXISTS "imageCount";
