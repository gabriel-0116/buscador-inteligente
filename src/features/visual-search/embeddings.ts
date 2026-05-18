import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { env, pipeline, RawImage } from "@xenova/transformers";

export const VISUAL_EMBEDDING_MODEL = "Xenova/clip-vit-base-patch32";

type ImageFeatureExtractionOutput = {
  data: ArrayLike<number>;
};

type ImageFeatureExtractor = (
  input: unknown,
  options: {
    pooling: "mean";
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

async function getExtractor() {
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
  const output = await extractor(image, {
    pooling: "mean",
    normalize: true,
  });

  return normalizeVector(Array.from(output.data, Number));
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
