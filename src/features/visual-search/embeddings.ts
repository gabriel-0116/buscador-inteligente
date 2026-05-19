import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, pipeline, RawImage } from "@xenova/transformers";

// DINOv2 captures visual features without text alignment — much better for product similarity.
// CLIP was designed for text-image matching, not image-image product search.
export const VISUAL_EMBEDDING_MODEL = "Xenova/dinov2-base";
export const EMBEDDING_DIM = 768;

type ImageFeatureExtractionOutput = {
  data: ArrayLike<number>;
};

type ImageFeatureExtractor = (
  input: unknown,
  options: {
    pooling: "cls" | "mean" | "none";
    normalize: boolean;
  }
) => Promise<ImageFeatureExtractionOutput>;

env.cacheDir = join(process.cwd(), ".cache", "transformers");
env.allowRemoteModels = true;
env.allowLocalModels = true;

let extractorPromise: Promise<unknown> | null = null;

function resolveProjectPath(path: string) {
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(
    vector.reduce((total, value) => total + value * value, 0)
  );

  if (!norm) {
    return vector;
  }

  return vector.map((value) => value / norm);
}

export async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      "image-feature-extraction",
      VISUAL_EMBEDDING_MODEL
    );
  }

  return (await extractorPromise) as ImageFeatureExtractor;
}

async function generateImageEmbeddingFromResolvedPath(imagePath: string) {
  const extractor = await getExtractor();

  const image = await RawImage.read(imagePath);
  // @xenova/transformers ignores pooling for DINOv2 and returns the full [1, 257, 768] tensor.
  // The CLS token is the first 768 values; slice it manually then normalize.
  const output = await extractor(image, {
    pooling: "none",
    normalize: false,
  });

  const clsToken = Array.from(output.data as Float32Array).slice(
    0,
    EMBEDDING_DIM
  );
  return normalizeVector(clsToken);
}

export async function generateImageEmbeddingFromPath(imagePath: string) {
  return generateImageEmbeddingFromResolvedPath(resolveProjectPath(imagePath));
}

export async function generateImageEmbeddingFromBuffer(buffer: Buffer) {
  const temporaryImagePath = join(tmpdir(), `${randomUUID()}.png`);

  try {
    await writeFile(temporaryImagePath, buffer);

    return await generateImageEmbeddingFromResolvedPath(temporaryImagePath);
  } finally {
    await unlink(temporaryImagePath).catch(() => {});
  }
}

export async function generateImageEmbeddingFromFile(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());

  return generateImageEmbeddingFromBuffer(buffer);
}

export async function readImageBufferFromPath(imagePath: string) {
  return readFile(resolveProjectPath(imagePath));
}
