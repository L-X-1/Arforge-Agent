export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { Context, DateTime, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { Identifier } from "./util/identifier"
import type { ToolOutput } from "@arforge-ai/llm"
import { redact } from "./redact"
import { sanitizeForStorage } from "./analysis/runs"
import { OpaqueArtifact } from "./runtime/artifact-ref"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Flock } from "./util/flock"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const MAX_READ_BYTES = 10 * 1024 * 1024
/** Maximum bytes returned by one resumable range request. */
export const MAX_RANGE_BYTES = 1024 * 1024
/** Maximum size accepted when importing a non-text artifact into the managed store. */
export const MAX_ARTIFACT_BYTES = AgentRuntime.ManagedArtifactMaxBytes
/** MCP projections are already bounded by the supervisor at ten MiB. */
export const MAX_MCP_RICH_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** Default profile-wide cap for bytes physically retained by the managed store. */
export const MAX_TOTAL_ARTIFACT_BYTES = 256 * 1024 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"
export const INDEX_DIRECTORY = "index"
export const CATALOG_DIRECTORY = "catalog"
export const CATALOG_STATE_FILE = "state.json"
/**
 * A small write-ahead marker for artifact imports.  The marker is not a
 * second catalog: it only lets a new process distinguish an interrupted
 * write/index/catalog sequence from a live receipt and clean the former
 * without guessing from mtime alone.
 */
export const PENDING_DIRECTORY = "pending"
export const PENDING_PREFIX = "pending_"
export const CATALOG_MAX_ENTRIES = 10_000
export const CATALOG_MAX_AUDIT_ENTRIES = 10_000

/** Deterministic crash probes are opt-in and never active in a normal process. */
const testCrashBoundary = (boundary: "after-marker" | "after-payload" | "after-index" | "after-catalog") =>
  process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" &&
  process.env.ARFORGE_TEST_ARTIFACT_CRASH_BOUNDARY === boundary

const crashAtTestBoundary = (boundary: "after-marker" | "after-payload" | "after-index" | "after-catalog") => {
  if (testCrashBoundary(boundary)) process.kill(process.pid, "SIGKILL")
}

/** Keep crash-fixture lock recovery fast without changing production defaults. */
const testFlockOptions = (): { readonly staleMs?: number } => {
  const staleMs = Number(process.env.ARFORGE_TEST_FLOCK_STALE_MS)
  return Number.isSafeInteger(staleMs) && staleMs >= 100 ? { staleMs } : {}
}

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly toolCallID: string
  readonly output: ToolOutput
  /**
   * Storage owner for the managed receipt.  Tool calls keep the historical
   * session scope by default; profile/tenant producers may opt into their
   * already-authorized owner without creating another output store.
   */
  readonly owner?: AgentRuntime.ArtifactOwner
}

export interface BoundResult {
  readonly output: ToolOutput
  /** @deprecated Use artifactRefs; retained only for the compatibility projection. */
  readonly outputPaths: ReadonlyArray<string>
  readonly artifactRefs?: ReadonlyArray<AgentRuntime.OpaqueArtifactRef>
}

export interface ArtifactBindInput {
  readonly bytes: Uint8Array
  readonly owner: AgentRuntime.ArtifactOwner
  readonly kind: string
  readonly mime: string
  readonly label?: string
  readonly retention?: AgentRuntime.ArtifactRetention
}

export interface ArtifactReadInput {
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly owner: AgentRuntime.ArtifactOwner
  readonly maxBytes?: number
}

export interface ArtifactReadResult {
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly bytes: Uint8Array
}

export interface ArtifactReadRangeInput extends ArtifactReadInput {
  readonly offset: number
  readonly length: number
}

export interface ArtifactReadRangeResult extends ArtifactReadResult {
  readonly offset: number
  /** Exclusive end offset of the returned slice. */
  readonly endExclusive: number
  readonly totalBytes: number
}

export interface ArtifactStoreUsage {
  readonly totalBytes: number
  readonly maxTotalBytes: number
}

export interface ArtifactCatalogEntry {
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly lastSequence: number
  readonly readCount: number
}

export interface ArtifactCatalogPage {
  readonly entries: ReadonlyArray<ArtifactCatalogEntry>
  readonly nextSequence?: number
  readonly headSequence: number
  readonly headHash: string
  readonly droppedAuditEntries: number
}

export interface ArtifactAuditRecord {
  readonly sequence: number
  readonly recordedAt: number
  readonly actor: string
  readonly action: "registered" | "read" | "range" | "rejected" | "rate_limited" | "removed"
  readonly artifactID: string
  readonly digest: string
  readonly owner: AgentRuntime.ArtifactOwner
  readonly reason?: string
  readonly offset?: number
  readonly length?: number
  readonly previousHash: string
  readonly recordHash: string
}

export interface ArtifactAuditInput {
  readonly actor: string
  readonly action: ArtifactAuditRecord["action"]
  readonly reference: AgentRuntime.OpaqueArtifactRef
  readonly reason?: string
  readonly offset?: number
  readonly length?: number
}

type McpRichProjection = {
  readonly server: string
  readonly kind: string
  readonly uri?: string
}

type CatalogStoredEntry = {
  readonly reference: unknown
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly lastSequence: number
  readonly readCount: number
  /** Durable tombstone marker; survives audit-window truncation. */
  readonly removed?: true
}

type CatalogStoredAudit = ArtifactAuditRecord

type CatalogState = {
  readonly schemaVersion: 2
  readonly revision: number
  readonly nextSequence: number
  readonly headHash: string
  readonly chainAnchor: string
  readonly droppedAuditEntries: number
  readonly entries: Record<string, CatalogStoredEntry>
  readonly audit: ReadonlyArray<CatalogStoredAudit>
}

type PendingArtifact = {
  readonly schemaVersion: 1
  readonly handle: string
  readonly reference: unknown
}

const CATALOG_HASH = /^[a-f0-9]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)

/**
 * MCP rich results are marked by the existing mature-to-Core projection.
 * Keeping this narrow prevents ordinary tool media from changing its legacy
 * inline behavior while giving MCP resources/prompts/tools one Artifact
 * persistence path. The metadata is advisory only; bytes and owner are still
 * checked by ToolOutputStore before a receipt is returned.
 */
const mcpRichProjection = (structured: unknown): McpRichProjection | undefined => {
  if (!isRecord(structured) || !isRecord(structured.metadata)) return undefined
  const metadata = structured.metadata
  if (metadata.source !== "mcp-capability-registry" || typeof metadata.server !== "string") return undefined
  const server = metadata.server.trim()
  if (server.length === 0 || server.length > 160) return undefined
  const kind = typeof metadata.kind === "string" && metadata.kind.trim().length > 0 ? metadata.kind.trim() : "tool"
  if (kind.length > 80) return undefined
  const uri = typeof metadata.uri === "string" && metadata.uri.trim().length > 0 ? metadata.uri.trim() : undefined
  return { server, kind, ...(uri === undefined ? {} : { uri }) }
}

const decodeInlineBase64 = (value: string): Uint8Array | undefined => {
  const normalized = value.replace(/\s/g, "")
  if (normalized.length === 0 || normalized.length % 4 === 1) return undefined
  const estimatedBytes = Math.floor((normalized.length * 3) / 4)
  if (estimatedBytes > MAX_MCP_RICH_ATTACHMENT_BYTES) return undefined
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="),
    )
  )
    return undefined
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
  const bytes = Buffer.from(padded, "base64")
  const canonical = bytes.toString("base64").replace(/=+$/u, "")
  return canonical === normalized.replace(/=+$/u, "") ? new Uint8Array(bytes) : undefined
}

const inlineAttachment = (value: { readonly uri: string; readonly mime: string }) => {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/su.exec(value.uri)
  if (!match?.[1] || match[2] === undefined) return undefined
  const bytes = decodeInlineBase64(match[2])
  if (!bytes) return undefined
  const embeddedMime = match[1].trim()
  const mime = value.mime.trim() || embeddedMime
  if (mime !== embeddedMime) return undefined
  return { bytes, mime }
}

/** Stable JSON used for the on-disk audit hash chain. */
const catalogCanonical = (value: unknown): string => {
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Catalog hash input contains a non-finite number")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(catalogCanonical).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${catalogCanonical(value[key])}`)
      .join(",")}}`
  }
  throw new Error("Catalog hash input contains an unsupported value")
}

const catalogDigest = (value: unknown) => createHash("sha256").update(catalogCanonical(value)).digest("hex")

const emptyCatalogState = (): CatalogState => ({
  schemaVersion: 2,
  revision: 0,
  nextSequence: 1,
  headHash: "genesis",
  chainAnchor: "genesis",
  droppedAuditEntries: 0,
  entries: {},
  audit: [],
})

const failCatalog = (message: string): never => {
  throw new Error(`Invalid artifact catalog state: ${message}`)
}

const parseCatalogAudit = (value: unknown): CatalogStoredAudit => {
  if (!isRecord(value)) return failCatalog("audit record is not an object")
  const sequence = value.sequence
  const recordedAt = value.recordedAt
  const actor = value.actor
  const action = value.action
  const artifactID = value.artifactID
  const digest = value.digest
  const previousHash = value.previousHash
  const recordHash = value.recordHash
  if (!isSafeInteger(sequence) || sequence <= 0) return failCatalog("audit sequence is invalid")
  if (!isSafeInteger(recordedAt) || recordedAt < 0) return failCatalog("audit timestamp is invalid")
  if (typeof actor !== "string" || actor.length === 0 || actor.length > 160)
    return failCatalog("audit actor is invalid")
  if (!(["registered", "read", "range", "rejected", "rate_limited", "removed"] as const).includes(action as never))
    return failCatalog("audit action is invalid")
  if (typeof artifactID !== "string" || !artifactID.startsWith("art_"))
    return failCatalog("audit artifact ID is invalid")
  if (typeof digest !== "string" || !CATALOG_HASH.test(digest)) return failCatalog("audit digest is invalid")
  if (typeof previousHash !== "string" || (previousHash !== "genesis" && !CATALOG_HASH.test(previousHash)))
    return failCatalog("audit previous hash is invalid")
  if (typeof recordHash !== "string" || !CATALOG_HASH.test(recordHash))
    return failCatalog("audit record hash is invalid")
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 1000))
    return failCatalog("audit reason is invalid")
  if (value.offset !== undefined && (!isSafeInteger(value.offset) || value.offset < 0))
    return failCatalog("audit offset is invalid")
  if (value.length !== undefined && (!isSafeInteger(value.length) || value.length <= 0))
    return failCatalog("audit length is invalid")
  let owner: AgentRuntime.ArtifactOwner
  try {
    owner = Schema.decodeUnknownSync(AgentRuntime.ArtifactOwner)(value.owner)
  } catch {
    return failCatalog("audit owner is invalid")
  }
  const event = {
    sequence,
    recordedAt,
    actor,
    action,
    artifactID,
    digest,
    owner,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(value.offset === undefined ? {} : { offset: value.offset }),
    ...(value.length === undefined ? {} : { length: value.length }),
    previousHash,
  }
  if (catalogDigest(event) !== recordHash) return failCatalog("audit hash chain is invalid")
  return { ...event, recordHash } as CatalogStoredAudit
}

const parseCatalogState = (raw: string): CatalogState => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return failCatalog("state is not valid JSON")
  }
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2))
    return failCatalog("schema version is unsupported")
  if (!isSafeInteger(value.revision) || value.revision < 0) return failCatalog("revision is invalid")
  if (!isSafeInteger(value.nextSequence) || value.nextSequence <= 0) return failCatalog("next sequence is invalid")
  if (typeof value.headHash !== "string" || (value.headHash !== "genesis" && !CATALOG_HASH.test(value.headHash)))
    return failCatalog("head hash is invalid")
  if (
    typeof value.chainAnchor !== "string" ||
    (value.chainAnchor !== "genesis" && !CATALOG_HASH.test(value.chainAnchor))
  )
    return failCatalog("chain anchor is invalid")
  if (!isSafeInteger(value.droppedAuditEntries) || value.droppedAuditEntries < 0)
    return failCatalog("dropped audit count is invalid")
  if (!isRecord(value.entries)) return failCatalog("entries are invalid")
  if (Object.keys(value.entries).length > CATALOG_MAX_ENTRIES) return failCatalog("entry limit is exceeded")
  const entries: Record<string, CatalogStoredEntry> = {}
  for (const [key, rawEntry] of Object.entries(value.entries)) {
    if (!isRecord(rawEntry)) return failCatalog(`entry ${key} is invalid`)
    let reference: AgentRuntime.OpaqueArtifactRef
    try {
      reference = OpaqueArtifact.decode(rawEntry.reference)
    } catch {
      return failCatalog(`entry ${key} reference is invalid`)
    }
    // v1 keyed a single receipt by content digest, incorrectly conflating
    // different owners/imports of identical bytes. Keep those exact legacy
    // entries readable; new receipts use their existing opaque handle.
    if (reference.artifactID !== key && (value.schemaVersion === 1 || reference.retrievalHint.handle !== key))
      return failCatalog(`entry ${key} identity does not match its key`)
    if (!isSafeInteger(rawEntry.firstSeenAt) || rawEntry.firstSeenAt < 0)
      return failCatalog(`entry ${key} firstSeenAt is invalid`)
    if (!isSafeInteger(rawEntry.lastSeenAt) || rawEntry.lastSeenAt < rawEntry.firstSeenAt)
      return failCatalog(`entry ${key} lastSeenAt is invalid`)
    if (!isSafeInteger(rawEntry.lastSequence) || rawEntry.lastSequence < 0)
      return failCatalog(`entry ${key} lastSequence is invalid`)
    if (!isSafeInteger(rawEntry.readCount) || rawEntry.readCount < 0)
      return failCatalog(`entry ${key} readCount is invalid`)
    if (rawEntry.removed !== undefined && rawEntry.removed !== true)
      return failCatalog(`entry ${key} removed marker is invalid`)
    entries[key] = {
      reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
      firstSeenAt: rawEntry.firstSeenAt,
      lastSeenAt: rawEntry.lastSeenAt,
      lastSequence: rawEntry.lastSequence,
      readCount: rawEntry.readCount,
      ...(rawEntry.removed === true ? { removed: true } : {}),
    }
  }
  if (!Array.isArray(value.audit) || value.audit.length > CATALOG_MAX_AUDIT_ENTRIES)
    return failCatalog("audit list is invalid")
  const audit = value.audit.map(parseCatalogAudit)
  let previousSequence: number | undefined
  let previousHash = value.chainAnchor
  for (const record of audit) {
    if (previousSequence !== undefined && record.sequence !== previousSequence + 1)
      return failCatalog("audit sequence is not contiguous")
    if (record.previousHash !== previousHash) return failCatalog("audit previous hash does not match the chain")
    previousSequence = record.sequence
    previousHash = record.recordHash
  }
  const expectedHead = audit.length === 0 ? value.chainAnchor : audit[audit.length - 1].recordHash
  if (value.headHash !== expectedHead) return failCatalog("head hash does not match the audit tail")
  if (audit.length > 0 && value.nextSequence !== audit[audit.length - 1].sequence + 1)
    return failCatalog("next sequence does not match the audit tail")
  if (audit.length === 0 && value.nextSequence !== 1 + value.droppedAuditEntries)
    return failCatalog("empty audit sequence is inconsistent")
  return {
    schemaVersion: 2,
    revision: value.revision,
    nextSequence: value.nextSequence,
    headHash: value.headHash,
    chainAnchor: value.chainAnchor,
    droppedAuditEntries: value.droppedAuditEntries,
    entries,
    audit,
  }
}

const parsePendingArtifact = (raw: string, expectedHandle: string): AgentRuntime.OpaqueArtifactRef => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("pending artifact marker is not valid JSON")
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.handle !== expectedHandle ||
    typeof value.handle !== "string" ||
    value.handle.length === 0 ||
    value.handle.length > 256 ||
    path.basename(value.handle) !== value.handle ||
    value.handle === "." ||
    value.handle === ".." ||
    value.handle.includes("/") ||
    value.handle.includes("\\")
  )
    throw new Error("pending artifact marker identity is invalid")
  const reference = OpaqueArtifact.decode(value.reference)
  if (reference.retrievalHint.kind !== "managed" || reference.retrievalHint.handle !== expectedHandle)
    throw new Error("pending artifact marker reference does not match its handle")
  return reference
}

const readCatalogState = async (statePath: string): Promise<CatalogState> => {
  try {
    return parseCatalogState(await readFile(statePath, "utf8"))
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return emptyCatalogState()
    throw cause
  }
}

const persistCatalogState = async (statePath: string, state: CatalogState) => {
  const catalogDirectory = path.dirname(statePath)
  await mkdir(catalogDirectory, { recursive: true })
  const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" })
    await rename(temporary, statePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

const appendCatalogAudit = (
  state: CatalogState,
  input: ArtifactAuditInput,
  reference: AgentRuntime.OpaqueArtifactRef,
  now: number,
) => {
  const legacyKey = String(reference.artifactID)
  const legacy = state.entries[legacyKey]
  const key =
    legacy && OpaqueArtifact.equivalent(OpaqueArtifact.decode(legacy.reference), reference)
      ? legacyKey
      : reference.retrievalHint.handle
  const existing = state.entries[key]
  // A removed receipt remains in the read model until the entry budget is
  // under pressure so callers can still inspect the most recent catalog
  // projection.  Once the bounded catalog is full, registrations may evict
  // the oldest such tombstones while retaining their hash-chained audit
  // records.  The marker lives on the entry as well as in the audit so this
  // remains deterministic after the bounded audit window rolls forward.
  let entries = state.entries
  if (existing === undefined && input.action === "registered" && Object.keys(entries).length >= CATALOG_MAX_ENTRIES) {
    const tombstones = Object.entries(entries)
      .map(([entryKey, entry]) => {
        const indexed = OpaqueArtifact.decode(entry.reference)
        return { entryKey, lastSequence: entry.lastSequence, indexed, entry }
      })
      .filter((candidate) => candidate.entry.removed === true)
      .sort((left, right) => left.lastSequence - right.lastSequence)
    const required = Object.keys(entries).length - CATALOG_MAX_ENTRIES + 1
    if (tombstones.length >= required) {
      const evict = new Set(tombstones.slice(0, required).map((candidate) => candidate.entryKey))
      entries = Object.fromEntries(Object.entries(entries).filter(([entryKey]) => !evict.has(entryKey)))
    }
  }
  if (existing !== undefined) {
    const indexed = OpaqueArtifact.decode(existing.reference)
    if (!OpaqueArtifact.equivalent(indexed, reference)) throw new Error("Artifact catalog identity drifted")
  } else if (Object.keys(entries).length >= CATALOG_MAX_ENTRIES) {
    throw new Error("Artifact catalog entry limit exceeded")
  }

  // Retention cleanup is retried periodically. Treat a second removed event
  // for the same immutable receipt as an idempotent observation rather than
  // growing the audit chain on every maintenance tick.
  if (input.action === "removed" && existing) {
    for (let index = state.audit.length - 1; index >= 0; index--) {
      const previous = state.audit[index]
      if (
        previous?.sequence === existing.lastSequence &&
        previous.artifactID === reference.artifactID &&
        previous.owner.scope === reference.owner.scope &&
        previous.owner.id === reference.owner.id &&
        previous.action === "removed"
      )
        return { state, record: previous }
    }
  }

  const sequence = state.nextSequence
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error("Artifact audit sequence overflow")
  const event = {
    sequence,
    recordedAt: now,
    actor: input.actor,
    action: input.action,
    artifactID: String(reference.artifactID),
    digest: reference.digest,
    owner: reference.owner,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.length === undefined ? {} : { length: input.length }),
    previousHash: state.headHash,
  }
  const recordHash = catalogDigest(event)
  const record = { ...event, recordHash } satisfies ArtifactAuditRecord
  const audit = [...state.audit, record]
  let chainAnchor = state.chainAnchor
  let droppedAuditEntries = state.droppedAuditEntries
  while (audit.length > CATALOG_MAX_AUDIT_ENTRIES) {
    const dropped = audit.shift()
    if (dropped === undefined) break
    chainAnchor = dropped.recordHash
    droppedAuditEntries += 1
  }
  const previousEntry = existing
  const entry: CatalogStoredEntry = {
    reference: Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
    firstSeenAt: previousEntry?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastSequence: sequence,
    readCount: (previousEntry?.readCount ?? 0) + (input.action === "read" || input.action === "range" ? 1 : 0),
    ...(input.action === "removed" || (previousEntry?.removed === true && input.action !== "registered")
      ? { removed: true }
      : {}),
  }
  return {
    record,
    state: {
      schemaVersion: 2,
      revision: state.revision + 1,
      nextSequence: sequence + 1,
      headHash: recordHash,
      chainAnchor,
      droppedAuditEntries,
      entries: { ...entries, [key]: entry },
      audit,
    } satisfies CatalogState,
  }
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write", "read"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  /** Current physical managed-artifact occupancy and its profile-wide cap. */
  readonly usage: () => Effect.Effect<ArtifactStoreUsage, Error>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  /** Import already-authorized bytes into the same opaque receipt/catalog pipeline. */
  readonly bindBytes: (input: ArtifactBindInput) => Effect.Effect<AgentRuntime.OpaqueArtifactRef, Error>
  /** Resolve an opaque receipt only after owner, retention, index, size, and digest checks. */
  readonly read: (input: ArtifactReadInput) => Effect.Effect<ArtifactReadResult, Error>
  /** Resolve and return a bounded slice while verifying the complete artifact first. */
  readonly readRange: (input: ArtifactReadRangeInput) => Effect.Effect<ArtifactReadRangeResult, Error>
  /** Cross-process durable read model backed by the same opaque receipt owner. */
  readonly listCatalog: (input?: {
    readonly owner?: AgentRuntime.ArtifactOwner
    readonly limit?: number
    readonly beforeSequence?: number
  }) => Effect.Effect<ArtifactCatalogPage, Error>
  /** Append one monotonic, hash-chained artifact audit record across processes. */
  readonly recordAudit: (input: ArtifactAuditInput) => Effect.Effect<ArtifactAuditRecord, Error>
  readonly listAudit: (input?: {
    readonly owner?: AgentRuntime.ArtifactOwner
    readonly limit?: number
    readonly beforeSequence?: number
  }) => Effect.Effect<ReadonlyArray<ArtifactAuditRecord>, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const indexDirectory = path.join(directory, INDEX_DIRECTORY)
    const catalogDirectory = path.join(directory, CATALOG_DIRECTORY)
    const catalogStatePath = path.join(catalogDirectory, CATALOG_STATE_FILE)
    const pendingDirectory = path.join(directory, PENDING_DIRECTORY)
    const catalogLockKey = `tool-output-catalog:${catalogDirectory}`
    const pendingPath = (handle: string) => path.join(pendingDirectory, `${PENDING_PREFIX}${handle}.json`)
    const pendingHandleFromEntry = (entry: string) =>
      entry.startsWith(PENDING_PREFIX) && entry.endsWith(".json")
        ? entry.slice(PENDING_PREFIX.length, -".json".length)
        : undefined
    const withCatalogLock = <A>(body: () => Promise<A>, operation: StorageError["operation"] = "write") =>
      Effect.tryPromise({
        try: () =>
          Flock.withLock(catalogLockKey, body, { dir: path.join(global.state, "locks"), ...testFlockOptions() }),
        catch: (cause) => new StorageError({ operation, cause }),
      })
    const configuredToolOutput = Effect.fnUntraced(function* () {
      if (Option.isNone(config)) return {}
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      return Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
    })
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      const configured = yield* configuredToolOutput()
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })
    const maxTotalBytes = Effect.fn("ToolOutputStore.maxTotalBytes")(function* () {
      const configured = yield* configuredToolOutput()
      return configured.max_total_bytes ?? MAX_TOTAL_ARTIFACT_BYTES
    })

    /** Count physical managed payload bytes, including orphaned files. */
    const readManagedBytes = async () => {
      let totalBytes = 0
      let entries: string[]
      try {
        entries = await readdir(directory)
      } catch (cause) {
        if (isRecord(cause) && cause.code === "ENOENT") return 0
        throw cause
      }
      for (const entry of entries) {
        if (!entry.startsWith("artifact_") && !entry.startsWith("tool_")) continue
        try {
          const info = await lstat(path.join(directory, entry))
          if (info.isFile() && !info.isSymbolicLink()) totalBytes += info.size
        } catch (cause) {
          if (!(isRecord(cause) && cause.code === "ENOENT")) throw cause
        }
      }
      return totalBytes
    }

    /**
     * Reconcile the write-ahead markers left by a process that stopped during
     * bindBytes.  The caller must hold catalogLockKey.  A catalog entry is the
     * commit record; if it exists, the marker is only stale metadata.  Without
     * that commit record both the payload and index are uncommitted and are
     * removed immediately, even when they are newer than the normal retention
     * window.  This closes the quota leak caused by a crash between any two of
     * payload, index, and catalog persistence.
     */
    const recoverPendingLocked = async (): Promise<CatalogState> => {
      const state = await readCatalogState(catalogStatePath)
      let entries: string[]
      try {
        entries = await readdir(pendingDirectory)
      } catch (cause) {
        if (isRecord(cause) && cause.code === "ENOENT") return state
        throw cause
      }
      for (const entry of entries) {
        const handle = pendingHandleFromEntry(entry)
        if (handle === undefined) continue
        const markerPath = path.join(pendingDirectory, entry)
        const marker = parsePendingArtifact(await readFile(markerPath, "utf8"), handle)
        let committed = false
        for (const stored of Object.values(state.entries)) {
          let indexed: AgentRuntime.OpaqueArtifactRef
          try {
            indexed = OpaqueArtifact.decode(stored.reference)
          } catch {
            // A malformed unrelated catalog entry is already rejected by
            // readCatalogState.  Ignore entries for other handles here; the
            // handle-specific marker remains the only recovery authority.
            continue
          }
          if (indexed.retrievalHint.kind !== "managed" || indexed.retrievalHint.handle !== handle) continue
          if (!OpaqueArtifact.equivalent(indexed, marker))
            throw new Error("pending artifact marker does not match the committed receipt")
          committed = true
        }
        if (!committed) {
          // rm() does not follow a symlink and the handle was validated before
          // constructing either path, so recovery cannot escape the managed
          // directory even if a crashed write left a hostile replacement.
          await rm(path.join(directory, handle), { force: true })
          await rm(path.join(indexDirectory, `${handle}.json`), { force: true })
        } else {
          // The catalog is the durable commit.  Keep the committed receipt and
          // only remove the idempotent marker left after the commit.
        }
        await rm(markerPath, { force: true })
      }
      return state
    }

    const usage = Effect.fn("ToolOutputStore.usage")(function* () {
      const max = yield* maxTotalBytes()
      return yield* withCatalogLock(async () => {
        await recoverPendingLocked()
        return { totalBytes: await readManagedBytes(), maxTotalBytes: max }
      }, "read")
    })

    const writeBytes = Effect.fn("ToolOutputStore.writeBytes")(function* (bytes: Uint8Array, requestedHandle?: string) {
      const handle = requestedHandle ?? `tool_${Identifier.ascending()}`
      const file = path.join(directory, handle)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeFile(file, bytes, { flag: "wx" })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return { file, handle } as const
    })

    const writePending = Effect.fn("ToolOutputStore.writePending")(function* (
      reference: AgentRuntime.OpaqueArtifactRef,
    ) {
      const handle = reference.retrievalHint.handle
      if (
        reference.retrievalHint.kind !== "managed" ||
        handle.length === 0 ||
        handle.length > 256 ||
        path.basename(handle) !== handle ||
        handle === "." ||
        handle === ".." ||
        handle.includes("/") ||
        handle.includes("\\")
      )
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact handle is invalid") }),
        )
      const encoded = yield* Effect.try({
        try: () => Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
        catch: (cause) => new StorageError({ operation: "encode", cause }),
      })
      yield* fs
        .ensureDir(pendingDirectory)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeJson(pendingPath(handle), { schemaVersion: 1, handle, reference: encoded } satisfies PendingArtifact)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
    })

    const persistIndex = Effect.fn("ToolOutputStore.persistIndex")(function* (
      reference: AgentRuntime.OpaqueArtifactRef,
    ) {
      const encoded = yield* Effect.try({
        try: () => Schema.encodeSync(AgentRuntime.OpaqueArtifactRef)(reference),
        catch: (cause) => new StorageError({ operation: "encode", cause }),
      })
      yield* fs
        .ensureDir(indexDirectory)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* fs
        .writeJson(path.join(indexDirectory, `${reference.retrievalHint.handle}.json`), encoded)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
    })

    /** Appends catalog state while the caller already owns catalogLockKey. */
    const appendAuditState = async (input: ArtifactAuditInput, reference: AgentRuntime.OpaqueArtifactRef) => {
      const state = await readCatalogState(catalogStatePath)
      const appended = appendCatalogAudit(state, input, reference, Date.now())
      if (appended.state !== state) await persistCatalogState(catalogStatePath, appended.state)
      return appended.record
    }
    const appendAuditLocked = (input: ArtifactAuditInput, reference: AgentRuntime.OpaqueArtifactRef) =>
      Effect.tryPromise({
        try: () => appendAuditState(input, reference),
        catch: (cause) => new StorageError({ operation: "write", cause }),
      })

    const resolve = Effect.fn("ToolOutputStore.resolve")(function* (input: ArtifactReadInput) {
      let reference: AgentRuntime.OpaqueArtifactRef
      try {
        reference = OpaqueArtifact.validate(input.reference)
      } catch (cause) {
        return yield* Effect.fail(new StorageError({ operation: "read", cause }))
      }
      if (reference.owner.scope !== input.owner.scope || reference.owner.id !== input.owner.id)
        return yield* Effect.fail(
          new StorageError({
            operation: "read",
            cause: new Error("Artifact owner does not match the requesting scope"),
          }),
        )
      if (
        reference.retention.expiresAt !== undefined &&
        DateTime.toEpochMillis(reference.retention.expiresAt) <= Date.now()
      )
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact retention has expired") }),
        )
      const maxBytes = input.maxBytes ?? MAX_READ_BYTES
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact maxBytes is invalid") }),
        )
      if (reference.sizeBytes > maxBytes)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact exceeds the read limit") }),
        )

      const indexPath = path.join(indexDirectory, `${reference.retrievalHint.handle}.json`)
      const indexed = yield* fs.readJson(indexPath).pipe(
        Effect.mapError((cause) => new StorageError({ operation: "read", cause })),
        Effect.flatMap((value) =>
          Effect.try({
            try: () => OpaqueArtifact.decode(value),
            catch: (cause) => new StorageError({ operation: "read", cause }),
          }),
        ),
      )
      if (!OpaqueArtifact.equivalent(indexed, reference))
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact index identity drifted") }),
        )
      if (
        indexed.retention.expiresAt !== undefined &&
        DateTime.toEpochMillis(indexed.retention.expiresAt) <= Date.now()
      )
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact retention has expired") }),
        )

      const file = path.join(directory, indexed.retrievalHint.handle)
      const bytes = yield* fs
        .readFile(file)
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "read", cause })))
      if (bytes.byteLength > maxBytes)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact exceeds the read limit") }),
        )
      if (bytes.byteLength !== indexed.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== indexed.digest)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact bytes do not match the receipt") }),
        )
      return { reference: indexed, bytes } satisfies ArtifactReadResult
    })

    const read = Effect.fn("ToolOutputStore.read")(function* (input: ArtifactReadInput) {
      return yield* resolve(input)
    })

    const readRange = Effect.fn("ToolOutputStore.readRange")(function* (input: ArtifactReadRangeInput) {
      const maxBytes = input.maxBytes ?? MAX_RANGE_BYTES
      if (!Number.isSafeInteger(input.offset) || input.offset < 0)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact range offset is invalid") }),
        )
      if (!Number.isSafeInteger(input.length) || input.length <= 0 || input.length > MAX_RANGE_BYTES)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact range length is invalid") }),
        )
      if (input.offset > Number.MAX_SAFE_INTEGER - input.length)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact range overflows the offset space") }),
        )
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RANGE_BYTES || input.length > maxBytes)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact range exceeds the read limit") }),
        )

      // Resolve the complete file before slicing so a resumed download cannot
      // silently combine bytes from a file that changed between requests.
      const resolved = yield* resolve({
        reference: input.reference,
        owner: input.owner,
        maxBytes: MAX_READ_BYTES,
      })
      if (input.offset >= resolved.bytes.byteLength)
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Artifact range offset is outside the artifact") }),
        )
      const endExclusive = Math.min(resolved.bytes.byteLength, input.offset + input.length)
      if (endExclusive <= input.offset)
        return yield* Effect.fail(new StorageError({ operation: "read", cause: new Error("Artifact range is empty") }))
      const bytes = resolved.bytes.slice(input.offset, endExclusive)
      return {
        reference: resolved.reference,
        bytes,
        offset: input.offset,
        endExclusive,
        totalBytes: resolved.bytes.byteLength,
      } satisfies ArtifactReadRangeResult
    })

    const recordAudit = Effect.fn("ToolOutputStore.recordAudit")(function* (input: ArtifactAuditInput) {
      let reference: AgentRuntime.OpaqueArtifactRef
      try {
        reference = OpaqueArtifact.validate(input.reference)
      } catch (cause) {
        return yield* Effect.fail(new StorageError({ operation: "write", cause }))
      }
      if (typeof input.actor !== "string" || input.actor.trim().length === 0 || input.actor.length > 160)
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact audit actor is invalid") }),
        )
      const validAuditActions = ["registered", "read", "range", "rejected", "rate_limited", "removed"] as const
      if (!validAuditActions.includes(input.action))
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact audit action is invalid") }),
        )
      if (
        input.reason !== undefined &&
        (typeof input.reason !== "string" || input.reason.length > 1000 || input.reason.includes("\u0000"))
      )
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact audit reason is invalid") }),
        )
      if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact audit offset is invalid") }),
        )
      if (input.length !== undefined && (!Number.isSafeInteger(input.length) || input.length <= 0))
        return yield* Effect.fail(
          new StorageError({ operation: "write", cause: new Error("Artifact audit length is invalid") }),
        )

      return yield* withCatalogLock(() => appendAuditState(input, reference), "write")
    })

    const bindBytes = Effect.fn("ToolOutputStore.bindBytes")(function* (
      input: ArtifactBindInput,
      boundHandle?: string,
    ) {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > MAX_ARTIFACT_BYTES)
        return yield* Effect.fail(
          new StorageError({
            operation: "write",
            cause: new Error("Artifact bytes are invalid or exceed the size limit"),
          }),
        )
      let owner: AgentRuntime.ArtifactOwner
      try {
        owner = Schema.decodeUnknownSync(AgentRuntime.ArtifactOwner)(input.owner)
        if (input.retention !== undefined && !Schema.is(AgentRuntime.ArtifactRetention)(input.retention))
          throw new Error("Artifact retention is invalid")
      } catch (cause) {
        return yield* Effect.fail(new StorageError({ operation: "write", cause }))
      }
      const bytes = new Uint8Array(input.bytes)
      const createdAt = DateTime.makeUnsafe(Date.now())
      const handle = boundHandle ?? `artifact_${Identifier.ascending()}`
      const retention =
        input.retention ??
        ({
          mode: owner.scope === "session" ? "session" : "durable",
          expiresAt: DateTime.makeUnsafe(Date.now() + Duration.toMillis(RETENTION)),
        } satisfies AgentRuntime.ArtifactRetention)
      const reference = yield* Effect.try({
        try: () =>
          OpaqueArtifact.make({
            version: 1,
            kind: input.kind,
            digest: createHash("sha256").update(bytes).digest("hex"),
            mime: input.mime,
            sizeBytes: bytes.byteLength,
            owner,
            retention,
            retrievalHint: { kind: "managed", handle },
            ...(input.label === undefined ? {} : { label: input.label }),
            createdAt,
          }),
        catch: (cause) => new StorageError({ operation: "write", cause }),
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          // The quota check and physical write share the catalog lease so
          // concurrent processes cannot both observe the same free space.
          yield* Flock.effect(catalogLockKey, { dir: path.join(global.state, "locks"), ...testFlockOptions() })
          yield* Effect.tryPromise({
            try: recoverPendingLocked,
            catch: (cause) => new StorageError({ operation: "write", cause }),
          })
          const totalBytes = yield* Effect.tryPromise({
            try: readManagedBytes,
            catch: (cause) => new StorageError({ operation: "write", cause }),
          })
          const totalLimit = yield* maxTotalBytes()
          if (totalBytes > totalLimit || bytes.byteLength > totalLimit - totalBytes)
            return yield* Effect.fail(
              new StorageError({
                operation: "write",
                cause: new Error(
                  `Artifact total storage quota exceeded (${totalBytes + bytes.byteLength} > ${totalLimit} bytes)`,
                ),
              }),
            )

          const markerPath = pendingPath(handle)
          // The marker must be durable before the payload is visible.  If a
          // filesystem implementation reports a write as successful but
          // loses the marker, abort rather than publishing an untracked
          // payload that could leak quota after a crash.
          yield* writePending(reference)
          crashAtTestBoundary("after-marker")
          const written = yield* writeBytes(bytes, handle)
          crashAtTestBoundary("after-payload")
          const indexPath = path.join(indexDirectory, `${reference.retrievalHint.handle}.json`)
          yield* persistIndex(reference).pipe(
            Effect.tapError(() => fs.remove(written.file).pipe(Effect.catch(() => Effect.void))),
          )
          crashAtTestBoundary("after-index")
          yield* appendAuditLocked({ actor: "runtime", action: "registered", reference }, reference).pipe(
            Effect.tapError(() =>
              fs.remove(written.file).pipe(
                Effect.catch(() => Effect.void),
                Effect.andThen(fs.remove(indexPath).pipe(Effect.catch(() => Effect.void))),
              ),
            ),
          )
          crashAtTestBoundary("after-catalog")
          // The catalog append is the commit.  A failure to remove the marker
          // is intentionally non-fatal; the next process will observe the
          // committed entry and remove the stale marker idempotently.
          yield* fs.remove(markerPath).pipe(Effect.catch(() => Effect.void))
        }),
      )
      return reference
    })

    /**
     * Bind a projection with a deterministic handle and verify an existing
     * receipt before reusing it. The handle is derived from the complete
     * session/tool/attachment identity, so a replay cannot alias a different
     * MCP resource or silently append a second registration audit.
     */
    const bindStableMcpAttachment = Effect.fn("ToolOutputStore.bindStableMcpAttachment")(function* (input: {
      readonly bytes: Uint8Array
      readonly owner: AgentRuntime.ArtifactOwner
      readonly sessionID: string
      readonly toolCallID: string
      readonly server: string
      readonly kind: string
      readonly uri?: string
      readonly index: number
      readonly mime: string
    }) {
      const digest = createHash("sha256").update(input.bytes).digest("hex")
      const handle = `artifact_mcp_${createHash("sha256")
        .update(
          JSON.stringify([
            "mcp-rich/v1",
            input.owner.scope,
            input.owner.id,
            input.sessionID,
            input.toolCallID,
            input.server,
            input.kind,
            input.uri ?? "",
            input.index,
            digest,
          ]),
        )
        .digest("hex")}`
      yield* Flock.effect(`tool-output-mcp:${directory}:${handle}`, {
        dir: path.join(global.state, "locks"),
        ...testFlockOptions(),
      })
      const stored = yield* withCatalogLock(
        async () => (await readCatalogState(catalogStatePath)).entries[handle],
        "read",
      )
      if (!stored)
        return yield* bindBytes(
          {
            bytes: input.bytes,
            owner: input.owner,
            kind: `mcp_${input.kind}`,
            mime: input.mime,
            label: `mcp:${input.server}:${input.kind}:${input.index}`,
          },
          handle,
        )

      const reference = yield* Effect.try({
        try: () => OpaqueArtifact.decode(stored.reference),
        catch: (cause) => new StorageError({ operation: "read", cause }),
      })
      if (
        reference.digest !== digest ||
        reference.sizeBytes !== input.bytes.byteLength ||
        reference.kind !== `mcp_${input.kind}` ||
        reference.mime !== input.mime ||
        reference.owner.scope !== input.owner.scope ||
        reference.owner.id !== input.owner.id ||
        reference.retrievalHint.handle !== handle
      )
        return yield* new StorageError({ operation: "read", cause: new Error("MCP artifact identity drifted") })
      yield* resolve({ reference, owner: input.owner, maxBytes: MAX_MCP_RICH_ATTACHMENT_BYTES })
      return reference
    })

    const listCatalog = Effect.fn("ToolOutputStore.listCatalog")(function* (input?: {
      readonly owner?: AgentRuntime.ArtifactOwner
      readonly limit?: number
      readonly beforeSequence?: number
    }) {
      const limit = input?.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000)
        return yield* Effect.fail(new StorageError({ operation: "read", cause: new Error("Catalog limit is invalid") }))
      if (
        input?.beforeSequence !== undefined &&
        (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence <= 0)
      )
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Catalog beforeSequence is invalid") }),
        )
      if (input?.owner !== undefined) {
        try {
          Schema.decodeUnknownSync(AgentRuntime.ArtifactOwner)(input.owner)
        } catch (cause) {
          return yield* Effect.fail(new StorageError({ operation: "read", cause }))
        }
      }
      return yield* withCatalogLock(async () => {
        const state = await readCatalogState(catalogStatePath)
        const entries = Object.values(state.entries)
          .map(
            (entry) =>
              ({
                reference: OpaqueArtifact.decode(entry.reference),
                firstSeenAt: entry.firstSeenAt,
                lastSeenAt: entry.lastSeenAt,
                lastSequence: entry.lastSequence,
                readCount: entry.readCount,
              }) satisfies ArtifactCatalogEntry,
          )
          .filter((entry) => {
            if (
              input?.owner !== undefined &&
              (entry.reference.owner.scope !== input.owner.scope || entry.reference.owner.id !== input.owner.id)
            )
              return false
            return input?.beforeSequence === undefined || entry.lastSequence < input.beforeSequence
          })
          .sort((left, right) => right.lastSequence - left.lastSequence)
        const page = entries.slice(0, limit)
        const hasMore = entries.length > page.length
        return {
          entries: page,
          ...(hasMore && page.length > 0 ? { nextSequence: page[page.length - 1].lastSequence } : {}),
          headSequence: state.nextSequence - 1,
          headHash: state.headHash,
          droppedAuditEntries: state.droppedAuditEntries,
        } satisfies ArtifactCatalogPage
      }, "read")
    })

    const listAudit = Effect.fn("ToolOutputStore.listAudit")(function* (input?: {
      readonly owner?: AgentRuntime.ArtifactOwner
      readonly limit?: number
      readonly beforeSequence?: number
    }) {
      const limit = input?.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1000)
        return yield* Effect.fail(new StorageError({ operation: "read", cause: new Error("Audit limit is invalid") }))
      if (
        input?.beforeSequence !== undefined &&
        (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence <= 0)
      )
        return yield* Effect.fail(
          new StorageError({ operation: "read", cause: new Error("Audit beforeSequence is invalid") }),
        )
      if (input?.owner !== undefined) {
        try {
          Schema.decodeUnknownSync(AgentRuntime.ArtifactOwner)(input.owner)
        } catch (cause) {
          return yield* Effect.fail(new StorageError({ operation: "read", cause }))
        }
      }
      return yield* withCatalogLock(async () => {
        const state = await readCatalogState(catalogStatePath)
        const records = state.audit
          .filter((record) => {
            if (
              input?.owner !== undefined &&
              (record.owner.scope !== input.owner.scope || record.owner.id !== input.owner.id)
            )
              return false
            return input?.beforeSequence === undefined || record.sequence < input.beforeSequence
          })
          .slice()
          .sort((left, right) => right.sequence - left.sequence)
          .slice(0, limit)
        return records as ReadonlyArray<ArtifactAuditRecord>
      }, "read")
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const safeOutput: ToolOutput = {
        structured: sanitizeForStorage(input.output.structured),
        content: input.output.content.map((item) =>
          item.type === "text" ? { ...item, text: redact(item.text) } : item,
        ),
      }
      const media = safeOutput.content.filter((item) => item.type === "file")
      const text = safeOutput.content.filter((item) => item.type === "text")
      const owner = input.owner ?? { scope: "session" as const, id: String(input.sessionID) }
      const mcp = mcpRichProjection(safeOutput.structured)
      const mcpArtifactRefs =
        mcp && media.length > 0
          ? yield* Effect.scoped(
              Effect.forEach(
                media,
                (attachment, index) => {
                  const decoded = inlineAttachment(attachment)
                  if (!decoded)
                    return Effect.fail(
                      new StorageError({
                        operation: "write",
                        cause: new Error("MCP rich attachment is not a valid bounded inline data URL"),
                      }),
                    )
                  if (decoded.bytes.byteLength > MAX_MCP_RICH_ATTACHMENT_BYTES)
                    return Effect.fail(
                      new StorageError({
                        operation: "write",
                        cause: new Error("MCP rich attachment exceeds the 10 MiB managed artifact limit"),
                      }),
                    )
                  return bindStableMcpAttachment({
                    bytes: decoded.bytes,
                    owner,
                    sessionID: String(input.sessionID),
                    toolCallID: input.toolCallID,
                    server: mcp.server,
                    kind: mcp.kind,
                    ...(mcp.uri === undefined ? {} : { uri: mcp.uri }),
                    index,
                    mime: decoded.mime,
                  })
                },
                { concurrency: 1 },
              ),
            )
          : []
      const contextual =
        safeOutput.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(safeOutput.structured, null, 2) ?? String(safeOutput.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      if (
        lineCount(contextual) <= outputLimits.maxLines &&
        Buffer.byteLength(contextual, "utf-8") <= outputLimits.maxBytes
      )
        return {
          output: safeOutput,
          outputPaths: [],
          ...(mcpArtifactRefs.length > 0 ? { artifactRefs: mcpArtifactRefs } : {}),
        }

      // The legacy path is kept only for compatibility consumers; never put
      // it into model-visible text. New callers use the opaque receipt below.
      const marker = "... output truncated; full content is available as a managed artifact reference ..."
      const bytes = Buffer.from(contextual, "utf8")
      // A repeated settlement must retain the same immutable receipt, not just
      // the same text. Bind this storage-owned identity to the authorized owner,
      // session, call and exact redacted bytes; ordinary bindBytes imports stay
      // distinct. No new execution or normalization path is introduced.
      const digest = createHash("sha256").update(bytes).digest("hex")
      const handle = `artifact_bound_${createHash("sha256")
        .update(JSON.stringify([owner.scope, owner.id, String(input.sessionID), input.toolCallID, digest]))
        .digest("hex")}`
      const artifactRef = yield* Effect.gen(function* () {
        yield* Flock.effect(`tool-output-bound:${directory}:${handle}`, {
          dir: path.join(global.state, "locks"),
          ...testFlockOptions(),
        })
        const stored = yield* withCatalogLock(
          async () => (await readCatalogState(catalogStatePath)).entries[handle],
          "read",
        )
        if (!stored) return yield* bindBytes({ bytes, owner, kind: "tool_output", mime: "text/plain" }, handle)
        const reference = yield* Effect.try({
          try: () => OpaqueArtifact.decode(stored.reference),
          catch: (cause) => new StorageError({ operation: "read", cause }),
        })
        if (
          reference.digest !== digest ||
          reference.sizeBytes !== bytes.byteLength ||
          reference.kind !== "tool_output" ||
          reference.mime !== "text/plain" ||
          reference.retrievalHint.handle !== handle
        )
          return yield* new StorageError({ operation: "read", cause: new Error("Bound artifact identity drifted") })
        // Missing, modified or expired receipts fail closed. Do not replace or
        // extend them during replay, and do not append another registration.
        yield* resolve({ reference, owner, maxBytes: MAX_ARTIFACT_BYTES })
        return reference
      }).pipe(Effect.scoped)
      const outputPath = path.join(directory, artifactRef.retrievalHint.handle)

      return {
        output: {
          structured: safeOutput.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
        artifactRefs: [...mcpArtifactRefs, artifactRef],
      }
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const now = Date.now()
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = now - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
      const indexEntries = yield* fs.readDirectory(indexDirectory).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of indexEntries) {
        if (!entry.endsWith(".json")) continue
        const indexPath = path.join(indexDirectory, entry)
        const value = yield* fs.readJson(indexPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        let expired = true
        if (value !== undefined) {
          try {
            const reference = OpaqueArtifact.decode(value)
            const backingFile = path.join(directory, reference.retrievalHint.handle)
            expired =
              !(yield* fs.existsSafe(backingFile)) ||
              (reference.retention.expiresAt !== undefined &&
                DateTime.toEpochMillis(reference.retention.expiresAt) <= Date.now())
          } catch {
            expired = true
          }
        }
        if (expired) yield* fs.remove(indexPath).pipe(Effect.catch(() => Effect.void))
      }

      // Catalog-backed artifacts use the same lock as registration and audit
      // writes. Physical deletion and the durable `removed` event are treated
      // as one maintenance decision; a later tick can safely retry if the OS
      // refuses either deletion.
      yield* withCatalogLock(async () => {
        let state = await recoverPendingLocked()
        const referencedHandles = new Set(
          Object.values(state.entries).flatMap((stored) => {
            try {
              return [OpaqueArtifact.decode(stored.reference).retrievalHint.handle]
            } catch {
              return []
            }
          }),
        )
        // A crashed write can leave an artifact payload without a catalog
        // entry. Only remove such orphans after the normal retention window;
        // a fresh orphan may still belong to a process finishing its index or
        // audit append. Symlinks are never followed or deleted by this sweep.
        let managedEntries: string[] = []
        try {
          managedEntries = await readdir(directory)
        } catch (cause) {
          if (!(isRecord(cause) && cause.code === "ENOENT")) throw cause
        }
        for (const entry of managedEntries) {
          if (!entry.startsWith("artifact_") || referencedHandles.has(entry)) continue
          const file = path.join(directory, entry)
          try {
            const info = await lstat(file)
            if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= cutoff) continue
            await rm(file, { force: true })
          } catch (cause) {
            if (!(isRecord(cause) && cause.code === "ENOENT")) throw cause
          }
        }
        let changed = false
        for (const stored of Object.values(state.entries)) {
          const reference = OpaqueArtifact.decode(stored.reference)
          const backingFile = path.join(directory, reference.retrievalHint.handle)
          const indexPath = path.join(indexDirectory, `${reference.retrievalHint.handle}.json`)
          let fileExists = true
          let indexExists = true
          try {
            await stat(backingFile)
          } catch (cause) {
            if (isRecord(cause) && cause.code === "ENOENT") fileExists = false
            else continue
          }
          try {
            await stat(indexPath)
          } catch (cause) {
            if (isRecord(cause) && cause.code === "ENOENT") indexExists = false
            else continue
          }
          const expired =
            reference.retention.expiresAt !== undefined && DateTime.toEpochMillis(reference.retention.expiresAt) <= now
          if (!expired && fileExists && indexExists) continue

          try {
            await rm(backingFile, { force: true })
            await rm(indexPath, { force: true })
          } catch {
            // Keep the catalog live until both controlled files are gone. A
            // subsequent maintenance tick will retry without inventing an
            // audit event for a partial deletion.
            continue
          }
          const appended = appendCatalogAudit(
            state,
            {
              actor: "runtime-cleanup",
              action: "removed",
              reference,
              reason: expired ? "retention_expired" : "backing_file_missing",
            },
            reference,
            now,
          )
          if (appended.state !== state) {
            state = appended.state
            changed = true
          }
        }
        if (changed) await persistCatalogState(catalogStatePath, state)
      }, "write").pipe(Effect.catch(() => Effect.void))
    })

    return Service.of({
      limits,
      usage,
      bound,
      bindBytes,
      read,
      readRange,
      listCatalog,
      recordAudit,
      listAudit,
      cleanup,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })

export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
