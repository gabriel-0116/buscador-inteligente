// Text/semantic embeddings for PageProductMention and image query profiles.
//
// The schema column is `vector(1536)` (default OpenAI text-embedding-3-small).
// Override `TEXT_EMBEDDING_DIMENSIONS` AND the schema together if changing.

const DEFAULT_PROVIDER = "openai";
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 1536;

export class TextEmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextEmbeddingUnavailableError";
  }
}

export type TextEmbeddingProvider = "openai";

export function getTextEmbeddingProvider(): TextEmbeddingProvider {
  const raw = (process.env.TEXT_EMBEDDING_PROVIDER || DEFAULT_PROVIDER)
    .toLowerCase()
    .trim();
  if (raw !== "openai") {
    throw new TextEmbeddingUnavailableError(
      `Unsupported TEXT_EMBEDDING_PROVIDER: ${raw} (only 'openai' is supported)`
    );
  }
  return raw;
}

export function getTextEmbeddingModel(): string {
  return process.env.TEXT_EMBEDDING_MODEL || DEFAULT_OPENAI_MODEL;
}

export function getTextEmbeddingDimensions(): number {
  const raw = process.env.TEXT_EMBEDDING_DIMENSIONS;
  if (!raw) return DEFAULT_DIMENSIONS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 64) return DEFAULT_DIMENSIONS;
  return n;
}

function getApiKey(): string {
  const key =
    process.env.TEXT_EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.VISION_DETECTOR_API_KEY;
  if (!key) {
    throw new TextEmbeddingUnavailableError(
      "TEXT_EMBEDDING_API_KEY (or OPENAI_API_KEY / VISION_DETECTOR_API_KEY) must be set"
    );
  }
  return key;
}

function normalizeVector(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (!norm) return v;
  return v.map((x) => x / norm);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateOpenAiEmbedding(args: {
  apiKey: string;
  model: string;
  dimensions: number;
  inputs: string[];
}): Promise<number[][]> {
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        input: args.inputs,
        dimensions: args.dimensions,
      }),
    },
    60_000
  );
  if (!res.ok) {
    const body = await res.text();
    throw new TextEmbeddingUnavailableError(
      `OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`
    );
  }
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  const rows = (json.data ?? [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((row) => {
    const embedding = row.embedding ?? [];
    if (embedding.length !== args.dimensions) {
      throw new TextEmbeddingUnavailableError(
        `OpenAI returned ${embedding.length} dims, expected ${args.dimensions}`
      );
    }
    return normalizeVector(embedding);
  });
}

/**
 * Generate a single embedding. Returns a normalized vector of
 * `TEXT_EMBEDDING_DIMENSIONS` length, ready for pgvector cosine search.
 */
export async function generateTextEmbedding(text: string): Promise<number[]> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    // Embedding empty text is wasteful — return a zero vector the caller can skip.
    return new Array(getTextEmbeddingDimensions()).fill(0);
  }
  const [vec] = await generateTextEmbeddings([trimmed]);
  return vec;
}

/**
 * Batched variant — sends multiple inputs in a single API call. Keeps order.
 */
export async function generateTextEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = getTextEmbeddingProvider();
  const model = getTextEmbeddingModel();
  const dimensions = getTextEmbeddingDimensions();
  const apiKey = getApiKey();

  // Replace empty strings with a single space so the API doesn't reject the batch.
  const inputs = texts.map((t) => {
    const trimmed = (t ?? "").trim();
    return trimmed.length === 0 ? " " : trimmed;
  });

  if (provider === "openai") {
    return generateOpenAiEmbedding({ apiKey, model, dimensions, inputs });
  }
  throw new TextEmbeddingUnavailableError(`Unsupported provider: ${provider}`);
}

/**
 * Serializes a vector as a pgvector literal: `[v1,v2,…]`. Always use the
 * returned string with `::vector` in raw SQL — never interpolate raw arrays.
 */
export function toPgVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
