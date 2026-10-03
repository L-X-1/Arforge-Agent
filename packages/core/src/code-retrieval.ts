export * as CodeRetrieval from "./code-retrieval"

import { createHash } from "node:crypto"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as RuntimeEmbedding from "./runtime/embedding"
import * as SourceAdapter from "./source-adapter"
import type * as SourceRegistry from "./source-registry"

export type StructureFact = {
  readonly kind: "symbol" | "definition" | "reference" | "import"
  readonly name: string
  readonly line: number
}

export interface Document {
  readonly source: SourceRegistry.SourceRecord
  readonly path: string
  readonly text: string
  readonly updatedAt: number
  readonly fingerprint?: string
  readonly structure?: ReadonlyArray<StructureFact>
  readonly evidenceID?: AgentRuntime.EvidenceID
}

export interface Query {
  readonly text: string
  readonly limit?: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly embedding?: "hashing" | "configured"
  /** Optional request assembled by an authorized caller; configuration alone never sends. */
  readonly embeddingRequest?: RuntimeEmbedding.RemoteRequest
  /**
   * Runtime-owned identity/data boundary for the configured embedding call.
   * When present, the shared embedding transport compares it before Egress,
   * credential resolution, or network I/O; callers cannot use a request bound
   * to another principal, workspace, or code scope.
   */
  readonly embeddingExpectedBinding?: RuntimeEmbedding.EmbeddingBindingContext
}

export interface Hit {
  readonly sourceID: string
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly snippet: string
  readonly lexicalScore: number
  readonly semanticScore: number
  readonly semanticBackend: RuntimeEmbedding.EmbeddingBackend
  readonly structureScore: number
  readonly freshnessScore: number
  readonly contentDigest: string
  readonly fingerprint: string
  readonly evidenceID?: AgentRuntime.EvidenceID
}

export class RetrievalError extends Error {
  readonly _tag = "Context.CodeRetrievalError"
  constructor(
    readonly category: "cancelled" | "deadline" | "invalid",
    message: string,
  ) {
    super(message)
  }
}

const MaximumLimit = 100
const MaximumSnippetBytes = 1_000

const tokens = (value: string): ReadonlyArray<string> =>
  value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_$.-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

const contentDigest = (text: string) => digest(text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"))

const fingerprint = (document: Document, normalizedDigest: string) =>
  document.fingerprint ??
  digest(`${document.source.sourceID}\0${document.path}\0${document.updatedAt}\0${normalizedDigest}`)

const structureFromText = (text: string): ReadonlyArray<StructureFact> => {
  const facts: StructureFact[] = []
  for (const [index, line] of text.split("\n").entries()) {
    const lineNumber = index + 1
    const match = line.match(/\b(?:class|interface|type|function|const|let|var|def|fn)\s+([A-Za-z_$][\w$]*)/u)
    if (match?.[1]) facts.push({ kind: "definition", name: match[1], line: lineNumber })
    if (/^\s*(?:import|from)\b/u.test(line))
      facts.push({ kind: "import", name: line.trim().slice(0, 160), line: lineNumber })
  }
  return facts
}

const similarityFromHashing = (query: string, documents: ReadonlyArray<string>): ReadonlyArray<number> => {
  const queryVector = RuntimeEmbedding.vectorForText(query)
  return documents.map((document) => RuntimeEmbedding.similarity(queryVector, RuntimeEmbedding.vectorForText(document)))
}

function checkQuery(query: Query): void {
  if (!query.text.trim()) throw new RetrievalError("invalid", "retrieval query must not be empty")
  if (query.signal?.aborted) throw new RetrievalError("cancelled", "retrieval cancelled")
  if (query.deadlineAt !== undefined && query.deadlineAt <= Date.now())
    throw new RetrievalError("deadline", "retrieval deadline exceeded")
}

const freshnessScore = (updatedAt: number, now: number) => {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return 0
  const age = Math.max(0, now - updatedAt)
  return Math.exp(-age / (1000 * 60 * 60 * 24 * 30))
}

const lexicalScore = (queryTerms: ReadonlyArray<string>, text: string): number => {
  const documentTerms = new Set(tokens(text))
  if (queryTerms.length === 0) return 0
  return queryTerms.filter((term) => documentTerms.has(term)).length / queryTerms.length
}

const structureScore = (queryTerms: ReadonlyArray<string>, facts: ReadonlyArray<StructureFact>): number => {
  if (queryTerms.length === 0 || facts.length === 0) return 0
  const names = new Set(facts.flatMap((fact) => tokens(fact.name)))
  return queryTerms.filter((term) => names.has(term)).length / queryTerms.length
}

const snippetFor = (
  queryTerms: ReadonlyArray<string>,
  text: string,
): { readonly lineStart: number; readonly lineEnd: number; readonly snippet: string } => {
  const lines = text.split("\n")
  const match = lines.findIndex((line) => queryTerms.some((term) => tokens(line).includes(term)))
  const lineStart = match < 0 ? 1 : match + 1
  const windowStart = Math.max(0, lineStart - 2)
  const snippet = lines.slice(windowStart, windowStart + 8).join("\n")
  const bounded = new TextDecoder().decode(new TextEncoder().encode(snippet).slice(0, MaximumSnippetBytes))
  return { lineStart, lineEnd: Math.min(lines.length, windowStart + 8), snippet: bounded }
}

export function fromAdapter(
  result: SourceAdapter.ReadResult,
  source: SourceRegistry.SourceRecord,
  updatedAt: number,
): Document {
  return {
    source,
    path: source.location ?? source.provenance.locator,
    text: result.text,
    updatedAt,
    evidenceID: result.evidence.id,
  }
}

export async function retrieve(query: Query, documents: ReadonlyArray<Document>): Promise<ReadonlyArray<Hit>> {
  checkQuery(query)
  const signal = query.signal
  const queryTerms = tokens(query.text)
  const now = Date.now()
  let semanticScores: ReadonlyArray<number>
  let semanticBackend: RuntimeEmbedding.EmbeddingBackend = "hashing"
  if (query.embedding === "configured") {
    const batch = await RuntimeEmbedding.embedBatch(
      query.text,
      documents.map((document) => document.text),
      {
        signal,
        deadlineAt: query.deadlineAt,
        remote: query.embeddingRequest,
        expectedBinding: query.embeddingExpectedBinding,
      },
    )
    semanticScores = batch.documents.map((vector) => RuntimeEmbedding.similarity(batch.query, vector))
    semanticBackend = batch.backend
  } else {
    semanticScores = similarityFromHashing(
      query.text,
      documents.map((document) => document.text),
    )
  }
  const hits: Hit[] = []
  for (const [index, document] of documents.entries()) {
    if (signal?.aborted) throw new RetrievalError("cancelled", "retrieval cancelled")
    if (query.deadlineAt !== undefined && query.deadlineAt <= Date.now())
      throw new RetrievalError("deadline", "retrieval deadline exceeded")
    const normalizedDigest = contentDigest(document.text)
    const facts = document.structure ?? structureFromText(document.text)
    const lexical = lexicalScore(queryTerms, document.text)
    const structure = structureScore(queryTerms, facts)
    const semantic = semanticScores[index] ?? 0
    const freshness = freshnessScore(document.updatedAt, now)
    if (lexical === 0 && structure === 0 && semantic <= 0) continue
    const location = snippetFor(queryTerms, document.text)
    hits.push({
      sourceID: document.source.sourceID,
      path: document.path,
      ...location,
      lexicalScore: lexical,
      semanticScore: semantic,
      semanticBackend,
      structureScore: structure,
      freshnessScore: freshness,
      contentDigest: normalizedDigest,
      fingerprint: fingerprint(document, normalizedDigest),
      ...(document.evidenceID === undefined ? {} : { evidenceID: document.evidenceID }),
    })
  }
  return hits
    .toSorted(
      (left, right) =>
        right.lexicalScore - left.lexicalScore ||
        right.structureScore - left.structureScore ||
        left.path.localeCompare(right.path),
    )
    .slice(0, Math.min(MaximumLimit, Math.max(1, query.limit ?? 20)))
}
