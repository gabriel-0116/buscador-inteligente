/**
 * Re-index all ProductImages with the current embedding model.
 * Run after switching models: npx tsx scripts/reindex.ts
 */
import "dotenv/config";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env, pipeline, RawImage } from "@xenova/transformers";

env.cacheDir = join(process.cwd(), ".cache", "transformers");
env.allowRemoteModels = true;
env.allowLocalModels = true;

const MODEL = "Xenova/dinov2-base";

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(
    vector.reduce((total, value) => total + value * value, 0)
  );
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  console.log(`Carregando modelo ${MODEL}...`);
  const extractor = (await pipeline("image-feature-extraction", MODEL)) as (
    input: unknown,
    opts: { pooling: "cls" | "mean" | "none"; normalize: boolean }
  ) => Promise<{ data: ArrayLike<number> }>;
  console.log("Modelo carregado.");

  const images = await prisma.productImage.findMany({
    select: { id: true, imageUrl: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Re-indexando ${images.length} imagens...\n`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < images.length; i++) {
    const { id, imageUrl } = images[i];
    const label = `[${i + 1}/${images.length}]`;

    try {
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const tmpPath = join(tmpdir(), `${randomUUID()}.jpg`);
      await writeFile(tmpPath, buffer);

      const image = await RawImage.read(tmpPath);
      const output = await extractor(image, { pooling: "none", normalize: false });
      await unlink(tmpPath).catch(() => {});

      // @xenova/transformers returns full [1, 257, 768] tensor for DINOv2 — extract CLS token manually
      const clsToken = Array.from(output.data as Float32Array).slice(0, 768);
      const embedding = normalizeVector(clsToken);
      const vectorStr = `[${embedding.join(",")}]`;

      await prisma.$executeRaw`
        UPDATE "ProductImage"
        SET embedding = ${vectorStr}::vector
        WHERE id = ${id}
      `;

      ok++;
      if ((i + 1) % 10 === 0 || i + 1 === images.length) {
        process.stdout.write(`${label} OK: ${ok}  Falha: ${fail}\n`);
      }
    } catch (err) {
      fail++;
      console.error(`${label} ERRO ${imageUrl}: ${(err as Error).message}`);
    }
  }

  console.log(`\nConcluído. ${ok} indexadas, ${fail} falhas.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
