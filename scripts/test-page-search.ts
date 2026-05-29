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
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { readFile } from "node:fs/promises";
import { analyzeImageQueryProfile } from "../src/features/visual-search/query-image-analyzer";
import { searchPagesByQueryProfile } from "../src/features/semantic-search/page-search";
import { prisma } from "../src/lib/prisma";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const imagePath = getArg("image");
  if (!imagePath) {
    console.error(
      "uso: npx tsx scripts/test-page-search.ts --image <path> [--limit N]"
    );
    process.exit(2);
  }
  const limit = Number.parseInt(getArg("limit") ?? "10", 10);

  const buffer = await readFile(imagePath);
  const { profile } = await analyzeImageQueryProfile({ pathOrBuffer: buffer });

  console.log("query:");
  console.log(`  mainProduct=${profile.mainProductNamePt}`);
  console.log(`  functionGroup=${profile.functionGroup}`);
  if (profile.category) console.log(`  category=${profile.category}`);
  if (profile.colors.length)
    console.log(`  colors=${profile.colors.join(", ")}`);
  if (profile.mustNotMatch.length)
    console.log(`  mustNotMatch=${profile.mustNotMatch.join(", ")}`);
  console.log("");

  const results = await searchPagesByQueryProfile({ profile });
  if (results.length === 0) {
    console.log("results: (nenhum)");
    return;
  }

  console.log("results:");
  results.slice(0, limit).forEach((r, i) => {
    console.log(
      `${(i + 1).toString().padStart(2, " ")}. ${r.supplierName} p.${r.pageNumber} | ${r.matchedProductName} | ${r.matchType} | ${r.confidence}`
    );
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect().catch(() => {}));
