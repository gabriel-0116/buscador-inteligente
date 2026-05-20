/**
 * Testa o detector de candidatos em uma imagem local.
 * Uso: npx tsx scripts/test-detector.ts <caminho-da-imagem>
 * Gera os crops em /tmp/detector-test/ para inspeção visual.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import { detectProductCandidatesFromPage } from "../src/features/catalog-processing/detect-product-candidates";

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error("Uso: npx tsx scripts/test-detector.ts <caminho-da-imagem>");
    process.exit(1);
  }

  const outputDir = join(tmpdir(), "detector-test");
  await mkdir(outputDir, { recursive: true });

  console.log(`Analisando: ${imagePath}`);
  console.log(`Saída em: ${outputDir}\n`);

  const candidates = await detectProductCandidatesFromPage({
    pageImagePath: imagePath,
    outputDir,
    pageNumber: 1,
  });

  if (candidates.length === 0) {
    console.log("Nenhum candidato detectado.");
  } else {
    candidates.forEach((c, i) => {
      console.log(`Candidato ${i + 1}:`);
      console.log(`  Arquivo: ${c.imagePath}`);
      console.log(`  Posição: (${c.x}, ${c.y})`);
      console.log(`  Dimensões: ${c.width}×${c.height}`);
      console.log(`  Confiança: ${Math.round(c.confidence * 100)}%`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
