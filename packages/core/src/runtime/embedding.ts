/**
 * Embedding provider for the optional semantic retrieval path.
 *
 * Default backend is deterministic feature hashing (no network, identical to
 * the historical `hashingVector` used by Memory.semantic). Set
 * `ARFORGE_EMBED_BACKEND=api` plus EMBED_API_KEY / EMBED_BASE_URL / EMBED_MODEL
 * for a real OpenAI-compatible embedding model. Any API failure falls back to
 * hashing, so the retrieval path never breaks.
 */

import { createHash } from "node:crypto"

export type EmbeddingBackend = "hashing" | "api"

export function backend(): EmbeddingBackend {
  const configured = (process.env.ARFORGE_EMBED_BACKEND ?? "hashing").trim().toLowerCase()
  if (configured === "api") return "api"
  return "hashing"
}

export function available(): boolean {
  if (backend() !== "api") return true
  return Boolean(process.env.EMBED_API_KEY?.trim() && process.env.EMBED_BASE_URL?.trim() && process.env.EMBED_MODEL?.trim())
}

export function featureVector(values: ReadonlyArray<string>, dimensions = 256): Float64Array {
  const vector = new Float64Array(dimensions)
  for (const value of values) {
    const digest = createHash("sha256").update(value).digest()
    const position = digest.readUInt32BE(0) % dimensions
    vector[position] += (digest[4] & 1) === 0 ? 1 : -1
  }
  return vector
}

function ngrams(text: string, min = 3, max = 5): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
  const grams: string[] = []
  for (const token of tokens) {
    for (let size = min; size <= max && size <= token.length; size++) {
      for (let i = 0; i + size <= token.length; i++) grams.push(token.slice(i, i + size))
    }
  }
  return grams
}

export function vectorForTerms(terms: ReadonlyArray<string>, dimensions = 256): Float64Array {
  return featureVector(terms, dimensions)
}

export function vectorForText(text: string, dimensions = 256): Float64Array {
  return featureVector(ngrams(text), dimensions)
}

async function apiEmbedMany(texts: ReadonlyArray<string>): Promise<Float64Array[]> {
  const baseUrl = process.env.EMBED_BASE_URL!.trim().replace(/\/$/, "")
  const apiKey = process.env.EMBED_API_KEY!.trim()
  const model = process.env.EMBED_MODEL!.trim()
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  })
  if (!response.ok) throw new Error(`embedding API HTTP ${response.status}`)
  const data = (await response.json()) as { data: Array<{ embedding: number[] }> }
  if (!Array.isArray(data.data) || data.data.length !== texts.length)
    throw new Error("embedding API returned an unexpected shape")
  return data.data.map((item) => {
    const vector = new Float64Array(item.embedding.length)
    item.embedding.forEach((value, index) => {
      vector[index] = value
    })
    return vector
  })
}

function cosine(a: Float64Array, b: Float64Array): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const magnitude = Math.sqrt(na) * Math.sqrt(nb)
  return magnitude === 0 ? 0 : dot / magnitude
}

export interface EmbeddingBatch {
  readonly query: Float64Array
  readonly documents: ReadonlyArray<Float64Array>
  readonly backend: EmbeddingBackend
}

/** Best-effort: real embeddings when configured, hashing otherwise. */
export async function embedBatch(query: string, documents: ReadonlyArray<string>): Promise<EmbeddingBatch> {
  if (backend() === "api" && available()) {
    try {
      const vectors = await apiEmbedMany([query, ...documents])
      return { query: vectors[0], documents: vectors.slice(1), backend: "api" }
    } catch {
      // fall through to hashing
    }
  }
  return {
    query: vectorForText(query),
    documents: documents.map((document) => vectorForText(document)),
    backend: "hashing",
  }
}

export function similarity(a: Float64Array, b: Float64Array): number {
  return cosine(a, b)
}
