/**
 * Testa a busca por página fim-a-fim: pega uma imagem de busca, monta o
 * query profile, gera o embedding textual e consulta o banco real.
 *
 * Uso:
 *   npx tsx scripts/test-page-search.ts --image <path/da/imagem>
 *   npx tsx scripts/test-page-search.ts --image ~/Downloads/camera-rosa.jpg --limit 10
 *
 * Saída:
 *   query:
 *     mainProduct=...
 *     functionGroup=...
 *     mustNotMatch=...
 *
 *   results:
 *     1. Fornecedor p.34 | Câmera infantil rosa | exact | high
 *        reason: ...
 *
 *   rejected/debug:
 *     - Fornecedor Y p.8 | Fone rosa | rejected
 *       reason: ...
 *
 * Requisitos: as mesmas envs do analyzer + DATABASE_URL/DIRECT_URL.
 *
 * Nota: `src/lib/prisma.ts` (importado transitivamente por `page-search`)
 * cria um pg.Pool no carregamento do módulo. Por isso `dotenv` é executado
 * primeiro e todos os imports do src/* são dinâmicos dentro de `main()`.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { readFile } from "node:fs/promises";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const imagePath = getArg("image");
  if (!imagePath) {
    console.error(
      "uso: npx tsx scripts/test-page-search.ts --image <path> [--limit N] [--debug]"
    );
    process.exit(2);
  }
  const limit = Number.parseInt(getArg("limit") ?? "10", 10);
  const debug = hasFlag("debug");

  // Dynamic imports so dotenv runs before any module that touches process.env
  // at load time (prisma pool, etc.).
  const [
    { analyzeImageQueryProfile },
    { generateImageEmbeddingFromBuffer },
    { searchPagesByQueryProfile },
  ] = await Promise.all([
    import("../src/features/visual-search/query-image-analyzer"),
    import("../src/features/visual-search/embeddings"),
    import("../src/features/semantic-search/page-search"),
  ]);

  const buffer = await readFile(imagePath);
  const { profile } = await analyzeImageQueryProfile({ pathOrBuffer: buffer });

  console.log("query:");
  console.log(`  mainProduct=${profile.mainProductNamePt}`);
  console.log(`  functionGroup=${profile.functionGroup}`);
  if (profile.category) console.log(`  category=${profile.category}`);
  if (profile.brand) console.log(`  brand=${profile.brand}`);
  if (profile.modelCodes.length)
    console.log(`  modelCodes=${profile.modelCodes.join(", ")}`);
  if (profile.visibleText.length)
    console.log(`  visibleText=${profile.visibleText.join(", ")}`);
  if (profile.colors.length)
    console.log(`  colors=${profile.colors.join(", ")}`);
  if (profile.mustNotMatch.length)
    console.log(`  mustNotMatch=${profile.mustNotMatch.join(", ")}`);
  console.log("");

  // Try to compute the visual embedding too, so the public path actually
  // runs in hybrid mode (mirrors the API).
  let queryVisualEmbedding: number[] | undefined;
  try {
    queryVisualEmbedding = await generateImageEmbeddingFromBuffer(buffer);
  } catch (err) {
    console.warn(
      `(aviso) sem embedding visual da query: ${err instanceof Error ? err.message : err}`
    );
  }

  // Public path — exactly what the UI shows.
  const publicResults = await searchPagesByQueryProfile({
    profile,
    queryVisualEmbedding,
  });
  if (publicResults.length === 0) {
    console.log("results: (nenhum)");
  } else {
    console.log("results:");
    publicResults.slice(0, limit).forEach((r, i) => {
      const sem =
        r.semanticScore != null
          ? `sem=${(r.semanticScore * 100).toFixed(0)}%`
          : "";
      const vis =
        r.visualSimilarity != null
          ? `vis=${(r.visualSimilarity * 100).toFixed(0)}%`
          : "";
      const visTag = r.matchedByVisualPage ? " [visual]" : "";
      const sig = [sem, vis].filter(Boolean).join(" ");
      console.log(
        `${(i + 1).toString().padStart(2, " ")}. ${r.supplierName} p.${r.pageNumber} | ${r.matchedProductName} | ${r.matchType} | ${r.confidence}${visTag} ${sig}`
      );
      if (r.matchedBrand || r.matchedModelCodes.length > 0) {
        console.log(
          `     ${[r.matchedBrand, r.matchedModelCodes.join(", ")]
            .filter(Boolean)
            .join(" · ")}`
        );
      }
      console.log(`     reason: ${r.reason}`);
      console.log(
        `     catalog=${r.catalogFileName}  pageImage=${r.pageImageUrl}`
      );
      if (r.otherMatches.length > 0) {
        console.log(
          `     outros na pág: ${r.otherMatches
            .map((o) => `${o.productName} (${o.matchType})`)
            .join(", ")}`
        );
      }
    });
  }

  if (!debug) return;

  // Debug path — same query, but pull every match (rejected, related, accessory)
  // for tuning the reranker. Same page may appear in both blocks.
  console.log("");
  console.log("--- debug (all match types) ---");
  const allResults = await searchPagesByQueryProfile({
    profile,
    queryVisualEmbedding,
    includeAllMatches: true,
  });
  const publicIds = new Set(publicResults.map((r) => r.pageId));
  const debugOnly = allResults.filter((r) => !publicIds.has(r.pageId));

  if (debugOnly.length === 0) {
    console.log("(nenhum candidato escondido pela busca pública)");
    return;
  }

  debugOnly.slice(0, Math.max(limit, 20)).forEach((r) => {
    console.log(
      `- ${r.supplierName} p.${r.pageNumber} | ${r.matchedProductName} | ${r.matchType} | ${r.confidence}`
    );
    console.log(`  reason: ${r.reason}`);
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    // Disconnect via dynamic import (module is already cached at this point).
    const { prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect().catch(() => {});
  });
