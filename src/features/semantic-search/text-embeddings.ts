// Text/semantic embeddings for PageProductMention and image query profiles.
//
// The schema column is `vector(768)` after the 2026-07 migration off OpenAI
// text-embedding-3-small onto a local runtime (LM Studio /
// nomic-embed-text-v1.5 as the reference). Setting TEXT_EMBEDDING_BASE_URL
// to an empty string reverts to the hosted OpenAI endpoint; in that case
// bump TEXT_EMBEDDING_MODEL back to text-embedding-3-small and pair with a
// matching schema migration (there is no in-place cast between dimensions).

const DEFAULT_PROVIDER = "openai";
const DEFAULT_OPENAI_MODEL = "nomic-embed-text-v1.5";
const DEFAULT_DIMENSIONS = 768;

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
    // Local OpenAI-compatible runtimes (LM Studio, Ollama, llama-server)
    // ignore the bearer entirely but require the header to exist. When the
    // caller is going local (base URL points at localhost) there's no
    // real credential to demand, so fall back to a placeholder instead of
    // throwing.
    if (isLocalBaseUrl(getOpenAiBaseUrl())) return "local";
    throw new TextEmbeddingUnavailableError(
      "TEXT_EMBEDDING_API_KEY (or OPENAI_API_KEY / VISION_DETECTOR_API_KEY) must be set"
    );
  }
  return key;
}

// Base URL for the OpenAI-compatible embeddings endpoint. Empty / unset
// defaults to hosted OpenAI. Point at http://localhost:1234 to route
// through LM Studio, http://localhost:11434 for Ollama, etc.
function getOpenAiBaseUrl(): string {
  const raw = process.env.TEXT_EMBEDDING_BASE_URL?.trim();
  if (!raw) return "https://api.openai.com";
  return raw.replace(/\/$/, "");
}

function isLocalBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(
    baseUrl
  );
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
  const baseUrl = getOpenAiBaseUrl();
  const local = isLocalBaseUrl(baseUrl);
  const res = await fetchWithTimeout(
    `${baseUrl}/v1/embeddings`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey || "local"}`,
        "content-type": "application/json",
      },
      // OpenAI supports `dimensions` (Matryoshka truncation) on
      // text-embedding-3-*. Local runtimes usually 400 on unknown fields,
      // and the model dimension is fixed anyway — omit the field when
      // targeting localhost. We still validate the response matches the
      // configured dimension on both paths.
      body: JSON.stringify({
        model: args.model,
        input: args.inputs,
        ...(local ? {} : { dimensions: args.dimensions }),
      }),
    },
    60_000
  );
  if (!res.ok) {
    const body = await res.text();
    throw new TextEmbeddingUnavailableError(
      `Embeddings API ${res.status}: ${body.slice(0, 500)}`
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
        `Embedding provider returned ${embedding.length} dims, expected ${args.dimensions} (check TEXT_EMBEDDING_DIMENSIONS matches the model)`
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
