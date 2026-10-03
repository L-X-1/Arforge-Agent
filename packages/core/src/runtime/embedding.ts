/**
 * Embedding provider for the optional semantic retrieval path.
 *
 * Default backend is deterministic feature hashing (no network, identical to
 * the historical `hashingVector` used by Memory.semantic). A remote backend
 * is never selected from environment variables alone: callers must provide an
 * explicit, already-authorized request with consent and an Egress authorizer.
 * This keeps configuration (where a model lives) separate from permission to
 * send memory/code content.
 */

import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Egress } from "../egress"
import { SecretProvider } from "../secret-provider"
import { digest as insightDigest, RuntimeInsight } from "./insight"

export type EmbeddingBackend = "hashing" | "api"
export type EmbeddingEgress = "none" | "denied" | "sent" | "unknown"

export class EmbeddingError extends Error {
  readonly _tag = "RuntimeEmbedding.Error"

  constructor(
    readonly category: "cancelled" | "deadline" | "invalid",
    message: string,
  ) {
    super(message)
  }
}

/**
 * A transport-bound credential.  The value is deliberately represented only
 * by a name and a lazy resolver so a request specification can be inspected,
 * copied or logged without carrying the secret itself.  The resolver is
 * invoked only after Egress has accepted the exact endpoint/method/scope.
 */
export type RemoteCredential = Readonly<{
  readonly name: string
  readonly resolve: () => Promise<string | undefined>
}>

/**
 * Immutable identity carried by an explicitly authorized remote embedding
 * request.  The embedding service does not infer any of these values from
 * environment configuration: callers must bind the subject, workspace and
 * data boundary together with the exact transport target and consent fact.
 */
export type EmbeddingRequestBinding = Readonly<{
  readonly principal: Readonly<{
    readonly tenantID: string
    readonly userID: string
  }>
  readonly workspaceID: string
  readonly dataScope: string
  /** Origin only; the transport path is fixed to `/embeddings`. */
  readonly origin: string
  readonly method: "POST"
  readonly model: string
  readonly credentialIdentity?: string
  readonly consent: boolean
}>

/** Freeze a binding before it crosses an Effect or process boundary. */
export const makeRequestBinding = (input: EmbeddingRequestBinding): EmbeddingRequestBinding =>
  Object.freeze({
    ...input,
    principal: Object.freeze({ ...input.principal }),
  })

/** Runtime-owned portion of a binding used to prevent cross-principal leaks. */
export type EmbeddingBindingContext = Readonly<Pick<EmbeddingRequestBinding, "principal" | "workspaceID" | "dataScope">>

/** A remote request must be assembled by an authorized caller, not by env lookup here. */
export type RemoteRequest = Readonly<{
  readonly baseUrl: string
  readonly model: string
  /** Optional credential resolved at the innermost transport boundary. */
  readonly credential?: RemoteCredential
  readonly credentialScope: ReadonlyArray<string>
  readonly egress: Egress.Authorizer
  /** User/policy consent is distinct from having a configured API key. */
  readonly consent: boolean
  /** Exact subject/workspace/data/target binding for this request. */
  readonly binding: EmbeddingRequestBinding
}>

export type EmbedBatchOptions = Readonly<{
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly remote?: RemoteRequest
  /** Expected identity/data boundary supplied by the owning service. */
  readonly expectedBinding?: EmbeddingBindingContext
  readonly maxTexts?: number
  readonly maxInputChars?: number
  readonly maxResponseBytes?: number
  readonly maxDimensions?: number
}>

/**
 * Builds a request backed by the existing SecretProvider.  Only the opaque
 * environment name crosses this seam; the secret is resolved later by the
 * transport after consent and Egress authorization have succeeded.  This is
 * intentionally an Effect constructor so callers cannot silently fall back
 * to process.env or a second credential store.
 */
export const makeSecretBackedRemoteRequest = Effect.fn("RuntimeEmbedding.makeSecretBackedRemoteRequest")(
  function* (input: {
    readonly baseUrl: string
    readonly model: string
    readonly secretName: string
    readonly credentialScope: ReadonlyArray<string>
    readonly egress: Egress.Authorizer
    readonly consent: boolean
    readonly binding: EmbeddingRequestBinding
  }) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(input.secretName))
      return yield* Effect.fail(new EmbeddingError("invalid", "embedding credential name is invalid"))
    const secrets = yield* SecretProvider.Service
    return {
      baseUrl: input.baseUrl,
      model: input.model,
      credentialScope: [...input.credentialScope],
      egress: input.egress,
      consent: input.consent,
      binding: makeRequestBinding(input.binding),
      credential: {
        name: input.secretName,
        resolve: () => Effect.runPromise(secrets.resolve(input.secretName)),
      },
    } satisfies RemoteRequest
  },
)

export function backend(): EmbeddingBackend {
  const configured = (process.env.ARFORGE_EMBED_BACKEND ?? "hashing").trim().toLowerCase()
  if (configured === "api") return "api"
  return "hashing"
}

export function available(): boolean {
  // Environment configuration is only a hint for UI/configuration surfaces.
  // It is intentionally not sufficient to authorize a network request.
  return backend() === "hashing" || Boolean(process.env.EMBED_BASE_URL?.trim() && process.env.EMBED_MODEL?.trim())
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

const DEFAULT_MAX_TEXTS = 256
const DEFAULT_MAX_INPUT_CHARS = 1_000_000
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_DIMENSIONS = 8_192

const originOf = (value: string): string | undefined => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined
    return parsed.origin.toLowerCase()
  } catch {
    return undefined
  }
}

const bindingDigest = (binding: EmbeddingRequestBinding): string =>
  insightDigest({
    principal: binding.principal,
    workspaceID: binding.workspaceID,
    dataScope: binding.dataScope,
    origin: binding.origin,
    method: binding.method,
    model: binding.model,
    credentialIdentity: binding.credentialIdentity,
    consent: binding.consent,
  })

const validateBindingValue = (value: unknown, label: string, maxLength: number): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength)
    throw new EmbeddingError("invalid", `embedding request binding ${label} is invalid`)
  return value
}

/**
 * Validate the immutable request binding against the exact URL and transport
 * fields used by the executor.  This remains a pure boundary check; Egress
 * still authorizes the actual URL immediately afterwards.
 */
export const validateRequestBinding = (
  remote: RemoteRequest,
  targetURL: string,
  expectedBinding?: EmbeddingBindingContext,
): void => {
  const binding = remote.binding
  if (binding === undefined || typeof binding !== "object")
    throw new EmbeddingError("invalid", "embedding request binding is required")
  validateBindingValue(binding.principal?.tenantID, "principal tenantID", 256)
  validateBindingValue(binding.principal?.userID, "principal userID", 256)
  validateBindingValue(binding.workspaceID, "workspaceID", 1024)
  validateBindingValue(binding.dataScope, "dataScope", 1024)
  validateBindingValue(binding.model, "model", 256)
  if (binding.method !== "POST") throw new EmbeddingError("invalid", "embedding request binding method must be POST")
  if (typeof binding.consent !== "boolean")
    throw new EmbeddingError("invalid", "embedding request binding consent is invalid")
  let targetOrigin: string | undefined
  try {
    const parsed = new URL(targetURL)
    if (parsed.protocol === "http:" || parsed.protocol === "https:") targetOrigin = parsed.origin.toLowerCase()
  } catch {
    targetOrigin = undefined
  }
  const boundOrigin = originOf(binding.origin)
  if (!targetOrigin || !boundOrigin || targetOrigin !== boundOrigin)
    throw new EmbeddingError("invalid", "embedding request binding origin does not match the target")
  if (binding.model !== remote.model)
    throw new EmbeddingError("invalid", "embedding request binding model does not match the request")
  if (binding.consent !== remote.consent)
    throw new EmbeddingError("invalid", "embedding request binding consent does not match the request")
  const credentialIdentity = binding.credentialIdentity
  if (credentialIdentity !== undefined) validateBindingValue(credentialIdentity, "credential identity", 256)
  if (credentialIdentity !== remote.credential?.name)
    throw new EmbeddingError("invalid", "embedding request binding credential identity does not match the request")
  if (expectedBinding !== undefined) {
    if (
      binding.principal.tenantID !== expectedBinding.principal.tenantID ||
      binding.principal.userID !== expectedBinding.principal.userID ||
      binding.workspaceID !== expectedBinding.workspaceID ||
      binding.dataScope !== expectedBinding.dataScope
    )
      throw new EmbeddingError("invalid", "embedding request binding is outside the owning service context")
  }
}

/**
 * Keep the audit resource useful for operators without copying user content,
 * credentials, or URL query values into the durable audit chain.  Egress still
 * authorizes the exact `/embeddings` URL; this projection is deliberately
 * coarser because an endpoint path may itself contain tenant/user input.
 */
const auditResource = (baseUrl: string | undefined): string => {
  if (baseUrl === undefined) return "embedding://local"
  try {
    const parsed = new URL(baseUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return "embedding://invalid"
  }
}

const auditEmbeddingEgress = (input: {
  readonly configuredBackend: EmbeddingBackend
  readonly remote: RemoteRequest | undefined
  readonly result: EmbeddingBatch
  readonly textCount: number
  readonly inputBytes: number
  readonly transportStarted: boolean
  readonly errorCategory?: EmbeddingError["category"]
}): void => {
  // Local hashing is the default path and creates no external fact worth
  // persisting.  When API mode is selected (or a caller supplied a remote
  // request), record the decision even when authorization denied before fetch.
  if (input.configuredBackend !== "api" && input.remote === undefined) return
  RuntimeInsight.auditRecord({
    actor: "runtime.embedding",
    action: "embedding.egress",
    resource: auditResource(input.remote?.baseUrl),
    reason: input.result.fallbackReason ?? input.result.egress,
    metadata: {
      configuredBackend: input.configuredBackend,
      resultBackend: input.result.backend,
      egress: input.result.egress,
      localOnly: input.result.localOnly,
      transportStarted: input.transportStarted,
      textCount: input.textCount,
      inputBytes: input.inputBytes,
      ...(input.remote === undefined ? {} : { consent: input.remote.consent }),
      ...(input.remote?.credential === undefined ? {} : { credentialName: input.remote.credential.name }),
      ...(input.remote?.binding === undefined ? {} : { bindingDigest: bindingDigest(input.remote.binding) }),
      ...(input.errorCategory === undefined ? {} : { errorCategory: input.errorCategory }),
    },
  })
}

const checkDeadline = (signal?: AbortSignal, deadlineAt?: number) => {
  if (signal?.aborted) throw new EmbeddingError("cancelled", "embedding request cancelled")
  if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()))
    throw new EmbeddingError("deadline", "embedding request deadline exceeded")
}

const endpoint = (baseUrl: string): string => {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new EmbeddingError("invalid", "embedding base URL is invalid")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new EmbeddingError("invalid", "embedding base URL must use http or https")
  parsed.search = ""
  parsed.hash = ""
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/embeddings`
  return parsed.toString()
}

const readBoundedBody = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = response.headers.get("content-length")
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > maxBytes)
    throw new EmbeddingError("invalid", `embedding response exceeds ${maxBytes} bytes`)
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes)
      throw new EmbeddingError("invalid", `embedding response exceeds ${maxBytes} bytes`)
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) throw new EmbeddingError("invalid", `embedding response exceeds ${maxBytes} bytes`)
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const decodeVectors = (text: string, count: number, maxDimensions: number): Float64Array[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new EmbeddingError("invalid", "embedding response is not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new EmbeddingError("invalid", "embedding response has an unexpected shape")
  const data = (parsed as { readonly data?: unknown }).data
  if (!Array.isArray(data) || data.length !== count)
    throw new EmbeddingError("invalid", "embedding response returned an unexpected vector count")
  const vectors = data.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new EmbeddingError("invalid", "embedding response contains an invalid vector")
    const values = Object.hasOwn(item, "embedding") ? item.embedding : undefined
    if (!Array.isArray(values) || values.length === 0 || values.length > maxDimensions)
      throw new EmbeddingError("invalid", "embedding response contains an invalid vector dimension")
    if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value)))
      throw new EmbeddingError("invalid", "embedding response contains a non-finite vector value")
    return Float64Array.from(values)
  })
  const first = vectors[0]
  if (!first) throw new EmbeddingError("invalid", "embedding response returned no vectors")
  const dimensions = first.length
  if (!vectors.every((vector) => vector.length === dimensions))
    throw new EmbeddingError("invalid", "embedding response vectors have inconsistent dimensions")
  return vectors
}

async function apiEmbedMany(
  texts: ReadonlyArray<string>,
  remote: RemoteRequest,
  options: EmbedBatchOptions,
  onTransportStart: () => void,
): Promise<Float64Array[]> {
  checkDeadline(options.signal, options.deadlineAt)
  const url = endpoint(remote.baseUrl)
  validateRequestBinding(remote, url, options.expectedBinding)
  await Effect.runPromise(
    remote.egress.assert({
      url,
      method: "POST",
      credentialScope: remote.credentialScope,
    }),
  )
  checkDeadline(options.signal, options.deadlineAt)
  const body = JSON.stringify({ model: remote.model, input: texts })
  const bodyBytes = new TextEncoder().encode(body)
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  if (bodyBytes.byteLength > maxInputChars)
    throw new EmbeddingError("invalid", `embedding request exceeds ${maxInputChars} bytes`)
  let apiKey: string | undefined
  if (remote.credential) {
    try {
      apiKey = await remote.credential.resolve()
    } catch {
      throw new EmbeddingError("invalid", "embedding credential could not be resolved")
    }
    if (!apiKey?.trim()) throw new EmbeddingError("invalid", "embedding credential is unavailable")
  }
  onTransportStart()
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
    },
    body,
    signal: options.signal,
  })
  if (!response.ok) throw new EmbeddingError("invalid", `embedding API HTTP ${response.status}`)
  return decodeVectors(
    await readBoundedBody(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
    texts.length,
    options.maxDimensions ?? DEFAULT_MAX_DIMENSIONS,
  )
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
  /** True only when no remote request was sent or could have been sent. */
  readonly localOnly: boolean
  readonly egress: EmbeddingEgress
  readonly fallbackReason?: "remote-not-authorized" | "remote-failed"
}

const hashingBatch = (
  query: string,
  documents: ReadonlyArray<string>,
  egress: EmbeddingEgress = "none",
  fallbackReason?: EmbeddingBatch["fallbackReason"],
): EmbeddingBatch => ({
  query: vectorForText(query),
  documents: documents.map((document) => vectorForText(document)),
  backend: "hashing",
  localOnly: egress === "none" || egress === "denied",
  egress,
  ...(fallbackReason === undefined ? {} : { fallbackReason }),
})

/** Uses a remote model only after explicit consent and Egress authorization. */
export async function embedBatch(
  query: string,
  documents: ReadonlyArray<string>,
  options: EmbedBatchOptions = {},
): Promise<EmbeddingBatch> {
  const maxTexts = options.maxTexts ?? DEFAULT_MAX_TEXTS
  if (!Number.isSafeInteger(maxTexts) || maxTexts <= 0) throw new EmbeddingError("invalid", "maxTexts must be positive")
  if (documents.length + 1 > maxTexts) throw new EmbeddingError("invalid", `embedding input exceeds ${maxTexts} texts`)
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0)
    throw new EmbeddingError("invalid", "maxInputChars must be positive")
  if (query.length + documents.reduce((sum, item) => sum + item.length, 0) > maxInputChars)
    throw new EmbeddingError("invalid", `embedding input exceeds ${maxInputChars} characters`)
  checkDeadline(options.signal, options.deadlineAt)

  const configuredBackend = backend()
  const remote = options.remote
  const inputBytes =
    remote === undefined
      ? 0
      : new TextEncoder().encode(JSON.stringify({ model: remote.model, input: [query, ...documents] })).byteLength
  if (configuredBackend !== "api" || remote === undefined) {
    const result = hashingBatch(
      query,
      documents,
      remote === undefined && configuredBackend === "api" ? "denied" : "none",
      remote === undefined && configuredBackend === "api" ? "remote-not-authorized" : undefined,
    )
    auditEmbeddingEgress({
      configuredBackend,
      remote,
      result,
      textCount: documents.length + 1,
      inputBytes,
      transportStarted: false,
    })
    return result
  }
  if (!remote.consent || !remote.model.trim() || (remote.credential !== undefined && !remote.credential.name.trim())) {
    const result = hashingBatch(query, documents, "denied", "remote-not-authorized")
    auditEmbeddingEgress({
      configuredBackend,
      remote,
      result,
      textCount: documents.length + 1,
      inputBytes,
      transportStarted: false,
    })
    return result
  }

  let egress = "denied" as EmbeddingEgress
  let transportStarted = false
  try {
    const vectors = await apiEmbedMany([query, ...documents], remote, options, () => {
      transportStarted = true
      egress = "sent"
    })
    const result: EmbeddingBatch = {
      query: vectors[0],
      documents: vectors.slice(1),
      backend: "api",
      localOnly: false,
      egress,
    }
    auditEmbeddingEgress({
      configuredBackend,
      remote,
      result,
      textCount: documents.length + 1,
      inputBytes,
      transportStarted,
    })
    return result
  } catch (error) {
    // Once fetch is entered, the outcome is conservatively external even when
    // transport or decoding fails. Callers must not report this as local-only.
    // Fetch implementations surface AbortSignal cancellation as a DOMException
    // (or another Error named AbortError), not as our EmbeddingError. Treat an
    // aborted signal after transport starts as unknown regardless of runtime so
    // the privacy report cannot incorrectly downgrade it to a local fallback.
    if (transportStarted && (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")))
      egress = "unknown"
    const result =
      egress === "denied"
        ? hashingBatch(query, documents, "denied", "remote-not-authorized")
        : hashingBatch(query, documents, egress, "remote-failed")
    auditEmbeddingEgress({
      configuredBackend,
      remote,
      result,
      textCount: documents.length + 1,
      inputBytes,
      transportStarted,
      ...(error instanceof EmbeddingError ? { errorCategory: error.category } : {}),
    })
    return result
  }
}

export function similarity(a: Float64Array, b: Float64Array): number {
  return cosine(a, b)
}
