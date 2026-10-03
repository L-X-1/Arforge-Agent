export * as SourceAdapter from "./source-adapter"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { createHash } from "node:crypto"
import * as Evidence from "./evidence"
import { redact } from "./redact"
import * as SourceRegistry from "./source-registry"

export const ErrorCategory = {
  cancelled: "cancelled",
  deadline: "deadline",
  byte_limit: "byte_limit",
  not_found: "not_found",
  permission: "permission",
  unavailable: "unavailable",
  invalid: "invalid",
  unknown: "unknown",
} as const
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory]

export class AdapterError extends Error {
  readonly _tag = "Context.SourceAdapterError"
  constructor(
    readonly category: ErrorCategory,
    readonly sourceID: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface ReadRequest {
  readonly source: SourceRegistry.SourceRecord
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly byteLimit?: number
}

export interface ReadResult {
  readonly sourceID: string
  readonly adapter: SourceRegistry.RetrievalAdapter
  /** Bounded transient text for the next compiler stage; never persisted by the adapter. */
  readonly text: string
  readonly contentDigest: string
  readonly sourceDigest: SourceRegistry.Digest
  readonly byteLength: number
  readonly tokenEstimate: number
  readonly truncated: boolean
  readonly evidence: AgentRuntime.Evidence
}

export type Loader = (input: { readonly source: SourceRegistry.SourceRecord; readonly signal: AbortSignal }) =>
  | string
  | Promise<string>

export interface Interface {
  readonly kind: SourceRegistry.RetrievalAdapter
  readonly read: (request: ReadRequest) => Promise<ReadResult>
}

export interface Registry {
  readonly get: (kind: SourceRegistry.RetrievalAdapter) => Interface | undefined
  readonly read: (request: ReadRequest) => Promise<ReadResult>
}

const MaximumSummary = 500

const normalize = (value: string) => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")

const estimateTokens = (value: string) => Math.max(0, Math.round(value.length / 4))

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes)))
}

const redactSummary = (source: SourceRegistry.SourceRecord, text: string): string => {
  if (source.redactionPolicy.mode === "none") return text.slice(0, MaximumSummary)
  if (source.redactionPolicy.mode === "content") return "[REDACTED_SOURCE_CONTENT]"
  const bounded = text.slice(0, MaximumSummary)
  const redacted = redact(bounded)
  return source.redactionPolicy.mode !== "custom"
    ? redacted
    : source.redactionPolicy.fields.reduce((value, field) => {
        const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        return value.replace(new RegExp(`\\b${escaped}\\s*[:=]\\s*[^\\s,;]+`, "gi"), `${field}=[REDACTED_SECRET]`)
      }, redacted)
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")

function errorFrom(sourceID: string, cause: unknown): AdapterError {
  if (cause instanceof AdapterError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const lower = message.toLowerCase()
  const category: ErrorCategory = lower.includes("not found")
    ? ErrorCategory.not_found
    : lower.includes("permission") || lower.includes("access denied")
      ? ErrorCategory.permission
      : ErrorCategory.unknown
  return new AdapterError(category, sourceID, "source adapter read failed", cause)
}

function assertSignal(request: ReadRequest): void {
  if (request.signal?.aborted) throw new AdapterError(ErrorCategory.cancelled, request.source.sourceID, "source read cancelled")
  if (request.deadlineAt !== undefined && request.deadlineAt <= Date.now())
    throw new AdapterError(ErrorCategory.deadline, request.source.sourceID, "source read deadline exceeded")
}

async function readWithDeadline(request: ReadRequest, loader: Loader): Promise<string> {
  assertSignal(request)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  request.signal?.addEventListener("abort", onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = Promise.resolve().then(() => loader({ source: request.source, signal: controller.signal }))
  const deadlineAt = request.deadlineAt
  const deadline =
    deadlineAt === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new AdapterError(ErrorCategory.deadline, request.source.sourceID, "source read deadline exceeded"))
          }, Math.max(0, deadlineAt - Date.now()))
        })
  const cancelled = new Promise<never>((_, reject) => {
    if (request.signal?.aborted) {
      reject(new AdapterError(ErrorCategory.cancelled, request.source.sourceID, "source read cancelled"))
      return
    }
    request.signal?.addEventListener(
      "abort",
      () => reject(new AdapterError(ErrorCategory.cancelled, request.source.sourceID, "source read cancelled")),
      { once: true },
    )
  })
  try {
    return await Promise.race([operation, ...(deadline === undefined ? [] : [deadline]), cancelled])
  } catch (cause) {
    throw errorFrom(request.source.sourceID, cause)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    request.signal?.removeEventListener("abort", onAbort)
  }
}

export function make(kind: SourceRegistry.RetrievalAdapter, loader: Loader, evidence?: Evidence.Interface): Interface {
  return {
    kind,
    read: async (request) => {
      if (request.source.retrievalAdapter !== kind)
        throw new AdapterError(ErrorCategory.invalid, request.source.sourceID, `source requires adapter ${request.source.retrievalAdapter}`)
      const raw = normalize(await readWithDeadline(request, loader))
      const byteLimit = Math.max(0, Math.min(request.byteLimit ?? Number.MAX_SAFE_INTEGER, request.source.limits.maxBytes))
      const tokenByteLimit = Math.max(0, sourceTokenLimit(request.source.limits.maxTokens) * 4)
      const text = truncateUtf8(raw, Math.min(byteLimit, tokenByteLimit))
      const contentDigest = digest(text)
      const evidenceInput: Evidence.CreateInput = {
        sourceID: request.source.sourceID,
        contentDigest,
        extractionMethod: `source-adapter:${kind}`,
        extractionVersion: "v1",
        trust: request.source.trust,
        instructionAllowed: request.source.instructionAllowed,
        sensitivity: request.source.sensitivity,
        summary: redactSummary(request.source, text),
        artifactRef: request.source.location,
        verificationStatus: contentDigest === request.source.provenance.digest.replace(/^sha256:/, "") ? "verified" : "unverified",
      }
      const resultEvidence =
        evidence?.create(evidenceInput) ?? Evidence.create(evidenceInput, SourceRegistry.makeRegistry([request.source]))
      const bounded: ReadResult = Object.freeze({
        sourceID: request.source.sourceID,
        adapter: kind,
        text,
        contentDigest,
        sourceDigest: request.source.provenance.digest,
        byteLength: new TextEncoder().encode(text).byteLength,
        tokenEstimate: estimateTokens(text),
        truncated: text !== raw,
        evidence: resultEvidence,
      })
      return bounded
    },
  }
}

const sourceTokenLimit = (maxTokens: number) => Math.max(0, maxTokens)

export function makeRegistry(adapters: ReadonlyArray<Interface>): Registry {
  const values = new Map(adapters.map((adapter) => [adapter.kind, adapter]))
  return {
    get: (kind) => values.get(kind),
    read: async (request) => {
      const adapter = values.get(request.source.retrievalAdapter)
      if (adapter === undefined)
        throw new AdapterError(ErrorCategory.unavailable, request.source.sourceID, `no adapter for ${request.source.retrievalAdapter}`)
      return adapter.read(request)
    },
  }
}

export const fromText = (kind: SourceRegistry.RetrievalAdapter, text: string, evidence?: Evidence.Interface) =>
  make(kind, () => text, evidence)

const factory = (kind: SourceRegistry.RetrievalAdapter) =>
  (loader: Loader, evidence?: Evidence.Interface): Interface => make(kind, loader, evidence)

/** Explicit adapter seams; host services inject the existing read/search implementation. */
export const staticAdapter = factory("static")
export const sessionAdapter = factory("session")
export const filesystemAdapter = factory("filesystem")
export const gitAdapter = factory("git")
export const lspAdapter = factory("lsp")
export const mcpAdapter = factory("mcp")
export const webAdapter = factory("web")
export const memoryAdapter = factory("memory")
export const learningAdapter = factory("learning")
export const workflowAdapter = factory("workflow")
export const toolOutputAdapter = factory("tool-output")
