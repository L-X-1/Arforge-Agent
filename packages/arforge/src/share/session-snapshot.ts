import type { ActionGateway } from "@arforge-ai/core/action-gateway"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import path from "node:path"
import { isProxy } from "node:util/types"
import { SessionID } from "@/session/schema"

const Digest = Schema.String
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const FORMAT = "share-next-static-v1" as const
export const HEURISTIC_SCANNER_VERSION = "session-share-heuristic-scan-v1" as const
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024
export const MAX_SNAPSHOT_CANONICAL_BYTES = MAX_EXPORT_BYTES + 256 * 1024
export const MAX_EXPORT_ITEMS = 10_000
export const MAX_EXCLUSIONS = 512
export const MAX_JSON_DEPTH = 64
export const MAX_STRING_BYTES = 1024 * 1024
export const MAX_RAW_DEPTH = MAX_JSON_DEPTH + 16
export const MAX_RAW_NODES = 250_000
export const MAX_RAW_ARRAY_ITEMS = MAX_EXPORT_ITEMS
export const MAX_RAW_KEY_BYTES = 4_096

const ExportItem = Schema.Struct({
  key: Schema.String,
  type: Schema.Literals(["session", "message", "part", "session_diff", "model"]),
  data: Schema.Json,
})
export type ExportItem = typeof ExportItem.Type

const Exclusion = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["authorization-header", "cookie", "credential", "provider-secret", "user-marked"]),
})
export type Exclusion = typeof Exclusion.Type

const CaptureExport = Schema.Struct({
  format: Schema.Literal(FORMAT),
  items: Schema.Array(ExportItem),
})

const ExportEvidence = Schema.Struct({
  ...CaptureExport.fields,
  contentDigest: Digest,
  canonicalBytes: NonNegativeInteger,
})

const CaptureHeuristicScan = Schema.Struct({
  scannerVersion: Schema.Literal(HEURISTIC_SCANNER_VERSION),
  excluded: Schema.Array(Exclusion),
})

/** Heuristic evidence only; it is not a proof that arbitrary SDK JSON contains no secret. */
const HeuristicScanEvidence = Schema.Struct({
  ...CaptureHeuristicScan.fields,
  scannedValueCount: NonNegativeInteger,
  excludedCount: NonNegativeInteger,
  exclusionDigest: Digest,
})

const TransportPolicy = Schema.Literal("https-only")
export type TransportPolicy = typeof TransportPolicy.Type

const Visibility = Schema.Literals(["private", "organization", "public"])
export type Visibility = typeof Visibility.Type

const CapturePublication = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  /** Digest stored when this publication was originally created, not a digest of the current Session. */
  originalExportDigest: Digest,
})

const Publication = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  /** Historical export digest supplied by CapturePublication.originalExportDigest. */
  exportDigest: Digest,
})

const CaptureTarget = Schema.Struct({
  baseURL: Schema.String,
  organizationID: Schema.NullOr(Schema.String),
  visibility: Visibility,
  publication: Schema.NullOr(CapturePublication),
})

const Target = Schema.Struct({
  ...CaptureTarget.fields,
  publication: Schema.NullOr(Publication),
  /** Production transport is fixed and persisted for replay. */
  transportPolicy: TransportPolicy,
})

const CaptureFields = {
  version: Schema.Literal(1),
  kind: Schema.Literals(["share", "unshare"]),
  sessionID: SessionID,
  projectID: Schema.String,
  location: Schema.String,
  eventHighWaterMark: NonNegativeInteger,
  export: CaptureExport,
  target: CaptureTarget,
  heuristicScan: CaptureHeuristicScan,
  requestID: Schema.String,
}

/** Exact values collected by a future, consistent static exporter. */
export const Capture = Schema.Struct(CaptureFields)
export type Capture = typeof Capture.Type

const StableFields = {
  version: Schema.Literal(1),
  kind: Schema.Literals(["share", "unshare"]),
  sessionID: SessionID,
  projectID: Schema.String,
  location: Schema.String,
  eventHighWaterMark: NonNegativeInteger,
  export: ExportEvidence,
  target: Target,
  heuristicScanEvidence: HeuristicScanEvidence,
}

/** Request-independent, immutable publish evidence. */
export const ClaimInput = Schema.Struct(StableFields)
export type ClaimInput = typeof ClaimInput.Type

/** Complete preflight after hashes and scan counts are derived. */
export const Preflight = Schema.Struct({
  ...StableFields,
  requestID: Schema.String,
})
export type Preflight = typeof Preflight.Type

/** Request-bound payload suitable for durable storage, but not yet wired to execution. */
export const Snapshot = Schema.Struct({
  ...Preflight.fields,
  digest: Digest,
})
export type Snapshot = typeof Snapshot.Type

export class Error extends Schema.TaggedErrorClass<Error>()("SessionShareSnapshot.Error", {
  message: Schema.String,
}) {}

const strictCapture = Schema.decodeUnknownSync(Capture, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictPreflight = Schema.decodeUnknownSync(Preflight, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictSnapshot = Schema.decodeUnknownSync(Snapshot, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})
const strictClaimInput = Schema.decodeUnknownSync(ClaimInput, {
  errors: "all",
  onExcessProperty: "error",
  propertyOrder: "original",
})

const REQUEST_ID = /^cpr_[A-Za-z0-9_-]{8,128}$/
const PROJECT_ID = /^[A-Za-z0-9._:-]{1,256}$/
const ORGANIZATION_ID = /^[A-Za-z0-9._:-]{1,256}$/
const PUBLICATION_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SHA256 = /^[0-9a-f]{64}$/
const EXPORT_KEY = /^[A-Za-z0-9._:/-]{1,512}$/
const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "password",
  "passwd",
  "secret",
  "clientsecret",
  "privatekey",
  "credential",
  "credentials",
  "connectionstring",
  "databaseurl",
  "dsn",
])

const fail = (message: string): never => {
  throw new Error({ message })
}

/**
 * Bound hostile raw values before Effect Schema, canonical JSON, or deep freeze
 * can recurse over them. Accessor properties and cyclic/non-JSON objects are
 * rejected without invoking user code.
 */
function assertRawBounds(value: unknown, label: string) {
  type Frame =
    | { readonly kind: "visit"; readonly value: unknown; readonly depth: number; readonly path: string }
    | { readonly kind: "leave"; readonly value: object }
  const stack: Array<Frame> = [{ kind: "visit", value, depth: 0, path: label }]
  const active = new WeakSet<object>()
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()!
    if (current.kind === "leave") {
      active.delete(current.value)
      continue
    }
    nodes++
    if (nodes > MAX_RAW_NODES) fail(`${label} exceeds ${MAX_RAW_NODES} raw nodes`)
    if (current.depth > MAX_RAW_DEPTH) fail(`${current.path} exceeds the raw depth limit`)

    if (current.value === null || typeof current.value === "boolean") continue
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) fail(`${current.path} contains a non-finite number`)
      continue
    }
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value) > MAX_STRING_BYTES) fail(`${current.path} contains an oversized raw string`)
      continue
    }
    const objectValue: object =
      typeof current.value === "object" && current.value !== null
        ? current.value
        : fail(`${current.path} contains a non-JSON value`)
    if (isProxy(objectValue)) fail(`${current.path} cannot be a Proxy`)
    if (active.has(objectValue)) fail(`${current.path} contains a cyclic reference`)
    active.add(objectValue)
    stack.push({ kind: "leave", value: objectValue })

    if (Array.isArray(objectValue)) {
      if (Object.getPrototypeOf(objectValue) !== Array.prototype)
        fail(`${current.path} contains an array with a non-standard prototype`)
      if (objectValue.length > MAX_RAW_ARRAY_ITEMS)
        fail(`${current.path} exceeds ${MAX_RAW_ARRAY_ITEMS} raw array items`)
      const descriptors = Object.getOwnPropertyDescriptors(objectValue)
      const keys = Reflect.ownKeys(objectValue)
      let itemCount = 0
      for (const key of keys) {
        const stringKey: string = typeof key === "string" ? key : fail(`${current.path} contains a symbol array key`)
        const descriptor = descriptors[stringKey] ?? fail(`${current.path}.${stringKey} has no own property descriptor`)
        if (descriptor.get || descriptor.set || !("value" in descriptor))
          fail(`${current.path}.${stringKey} cannot be an accessor property`)
        if (stringKey === "length") continue
        if (!/^(?:0|[1-9]\d*)$/.test(stringKey) || Number(stringKey) >= objectValue.length)
          fail(`${current.path} contains a non-index array property`)
        if (!descriptor.enumerable) fail(`${current.path}[${stringKey}] must be an enumerable data property`)
        itemCount++
      }
      if (itemCount !== objectValue.length) fail(`${current.path} cannot be a sparse array`)
      for (let index = objectValue.length - 1; index >= 0; index--) {
        const descriptor = descriptors[String(index)]!
        stack.push({
          kind: "visit",
          value: descriptor.value,
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(objectValue)
    if (prototype !== Object.prototype && prototype !== null) fail(`${current.path} contains a non-plain object`)
    const descriptors = Object.getOwnPropertyDescriptors(objectValue)
    for (const key of Reflect.ownKeys(objectValue)) {
      const stringKey: string = typeof key === "string" ? key : fail(`${current.path} contains a symbol field`)
      const descriptor = descriptors[stringKey] ?? fail(`${current.path}.${stringKey} has no own property descriptor`)
      if (Buffer.byteLength(stringKey) > MAX_RAW_KEY_BYTES) fail(`${current.path} contains an oversized field name`)
      if (descriptor.get || descriptor.set || !("value" in descriptor))
        fail(`${current.path}.${stringKey} cannot be an accessor property`)
      if (!descriptor.enumerable) fail(`${current.path}.${stringKey} must be an enumerable data property`)
      stack.push({
        kind: "visit",
        value: descriptor.value,
        depth: current.depth + 1,
        path: `${current.path}.${stringKey}`,
      })
    }
  }
}

function canonicalByteLength(value: unknown, label: string) {
  const canonical = canonicalJson(value) ?? fail(`${label} is not canonically serializable`)
  return Buffer.byteLength(canonical)
}

function assertSnapshotEnvelopeBound(value: unknown, label: string) {
  if (canonicalByteLength(value, label) > MAX_SNAPSHOT_CANONICAL_BYTES)
    fail(`${label} exceeds ${MAX_SNAPSHOT_CANONICAL_BYTES} canonical bytes`)
}

function assertCollectionBounds(input: {
  readonly export: { readonly items: ReadonlyArray<unknown> }
  readonly heuristicScan: { readonly excluded: ReadonlyArray<unknown> }
}) {
  if (input.export.items.length > MAX_EXPORT_ITEMS) fail(`static export exceeds ${MAX_EXPORT_ITEMS} items`)
  if (input.heuristicScan.excluded.length > MAX_EXCLUSIONS)
    fail(`heuristic scan exclusions exceed ${MAX_EXCLUSIONS} entries`)
}

function assertRawCollectionBounds(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const record = input as Record<string, unknown>
  const exported = record.export
  if (exported && typeof exported === "object" && !Array.isArray(exported)) {
    const items = (exported as Record<string, unknown>).items
    if (Array.isArray(items) && items.length > MAX_EXPORT_ITEMS) fail(`static export exceeds ${MAX_EXPORT_ITEMS} items`)
  }
  for (const field of ["heuristicScan", "heuristicScanEvidence"]) {
    const scan = record[field]
    if (!scan || typeof scan !== "object" || Array.isArray(scan)) continue
    const excluded = (scan as Record<string, unknown>).excluded
    if (Array.isArray(excluded) && excluded.length > MAX_EXCLUSIONS)
      fail(`heuristic scan exclusions exceed ${MAX_EXCLUSIONS} entries`)
  }
}

function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) immutable(child)
  return Object.freeze(value)
}

function flavor(value: string) {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)) return path.win32
  if (value.startsWith("/")) return path.posix
  return undefined
}

function canonicalAbsolute(value: string, label: string) {
  if (!value || value.includes("\0")) return fail(`${label} must be a non-empty absolute path`)
  if (/^\\\\[?.]\\/.test(value)) return fail(`${label} cannot use a Windows device path`)
  const implementation = flavor(value)
  if (!implementation?.isAbsolute(value)) return fail(`${label} must be an absolute path`)
  const normalized = implementation.normalize(value)
  return implementation === path.win32 ? normalized.toLowerCase() : normalized
}

function canonicalURL(value: string, label: string) {
  if (!value || value.length > 2048 || /[\0\r\n]/.test(value)) fail(`${label} is invalid`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return fail(`${label} must be an absolute URL`)
  }
  if (parsed.username || parsed.password) fail(`${label} cannot contain URL userinfo`)
  if (parsed.search || parsed.hash) fail(`${label} cannot contain a query or fragment`)
  if (parsed.protocol !== "https:") fail(`${label} must use HTTPS`)
  let decodedPath = parsed.pathname
  try {
    // Decode more than once so a doubly encoded credential cannot bypass the heuristic.
    for (let pass = 0; pass < 3; pass++) {
      const next = decodeURIComponent(decodedPath)
      if (next === decodedPath) break
      decodedPath = next
    }
  } catch {
    fail(`${label} contains an invalid percent-encoded path`)
  }
  if (looksLikeSecret(decodedPath)) fail(`${label} path contains a secret-looking token or credential`)
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${pathname}`
}

function asObject(value: Schema.Schema.Type<typeof Schema.Json>, label: string): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") fail(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (!value || Buffer.byteLength(value) > MAX_STRING_BYTES) fail(`${label} must be a bounded non-empty string`)
    return value
  }
  return fail(`${label} must be a bounded non-empty string`)
}

function pointerSegment(value: string) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1")
}

function normalizedSensitiveKey(value: string) {
  return value.toLowerCase().replace(/[-_.\s]/g, "")
}

function isSensitiveKey(value: string) {
  const key = normalizedSensitiveKey(value)
  if (SENSITIVE_KEYS.has(key)) return true
  // Keep ordinary telemetry such as `tokens` / `inputTokens` usable while
  // rejecting credential-bearing token/auth/session/cookie key families.
  if (key === "sessionid" || key === "tokens" || key.endsWith("tokens")) return false
  return (
    key.includes("token") ||
    key.includes("cookie") ||
    key === "session" ||
    key.startsWith("session") ||
    key.includes("authorization") ||
    (key.startsWith("auth") && !key.startsWith("author")) ||
    key.startsWith("oauth") ||
    /^(?:auth|oauth)(?:header|session|secret|credential|token)?$/.test(key) ||
    /^(?:session|client)(?:cookie|secret|credential|token|key)$/.test(key) ||
    /(?:cookie|secret|password|passwd|credential|privatekey|apikey)$/.test(key)
  )
}

function looksLikeSecret(value: string) {
  return (
    /^(?:bearer|basic)\s+\S{8,}$/i.test(value.trim()) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i.test(value) ||
    /\b(?:sk|st|rt|ghp|gho|ghu|ghs|github_pat|xoxb|xoxp|xoxa|xoxr)[_-][A-Za-z0-9_-]{8,}\b/.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*[^\s]{8,}/i.test(value)
  )
}

function scanJSON(value: Schema.Schema.Type<typeof Schema.Json>, root: string) {
  let scannedValueCount = 0
  const stack: Array<{ value: Schema.Schema.Type<typeof Schema.Json>; pointer: string; depth: number }> = [
    { value, pointer: root, depth: 0 },
  ]
  while (stack.length) {
    const current = stack.pop()!
    if (current.depth > MAX_JSON_DEPTH) fail(`${current.pointer} exceeds the maximum JSON depth`)
    if (current.value === null || typeof current.value === "boolean" || typeof current.value === "number") {
      scannedValueCount++
      continue
    }
    if (typeof current.value === "string") {
      scannedValueCount++
      if (Buffer.byteLength(current.value) > MAX_STRING_BYTES) fail(`${current.pointer} contains an oversized string`)
      if (looksLikeSecret(current.value)) fail(`${current.pointer} contains a secret-looking token or credential`)
      continue
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--)
        stack.push({ value: current.value[index]!, pointer: `${current.pointer}/${index}`, depth: current.depth + 1 })
      continue
    }
    for (const [key, child] of Object.entries(current.value)) {
      if (!key || Buffer.byteLength(key) > 256 || /[\0\r\n]/.test(key))
        fail(`${current.pointer} has an invalid field name`)
      const pointer = `${current.pointer}/${pointerSegment(key)}`
      if (isSensitiveKey(key)) fail(`${pointer} matches a sensitive-key heuristic and must be excluded`)
      stack.push({ value: child, pointer, depth: current.depth + 1 })
    }
  }
  return scannedValueCount
}

function validateItemScope(item: ExportItem, sessionID: string, projectID: string, location: string) {
  if (item.type === "session") {
    const data = asObject(item.data, `export item ${item.key}`)
    if (item.key !== "session") fail("the session export item key must be 'session'")
    if (requiredString(data.id, "session.id") !== sessionID) fail("exported session identity does not match sessionID")
    if (requiredString(data.projectID, "session.projectID") !== projectID)
      fail("exported session project does not match projectID")
    if (canonicalAbsolute(requiredString(data.directory, "session.directory"), "session.directory") !== location)
      fail("exported session directory does not match location")
    return
  }
  if (item.type === "message") {
    const data = asObject(item.data, `export item ${item.key}`)
    const id = requiredString(data.id, `export item ${item.key}.id`)
    if (item.key !== `message/${id}`) fail("message export key is not bound to message.id")
    if (requiredString(data.sessionID, `export item ${item.key}.sessionID`) !== sessionID)
      fail("exported message belongs to a different session")
    return
  }
  if (item.type === "part") {
    const data = asObject(item.data, `export item ${item.key}`)
    const id = requiredString(data.id, `export item ${item.key}.id`)
    const messageID = requiredString(data.messageID, `export item ${item.key}.messageID`)
    if (item.key !== `part/${messageID}/${id}`) fail("part export key is not bound to part identity")
    if (requiredString(data.sessionID, `export item ${item.key}.sessionID`) !== sessionID)
      fail("exported part belongs to a different session")
    return
  }
  if (item.type === "session_diff") {
    if (item.key !== "session_diff" || !Array.isArray(item.data))
      fail("session_diff must be a JSON array under the session_diff key")
    return
  }
  if (item.key !== "model" || !Array.isArray(item.data)) fail("model must be a JSON array under the model key")
}

function exportEvidence(raw: typeof CaptureExport.Type, sessionID: string, projectID: string, location: string) {
  const items = raw.items.map((item) => ({
    key: item.key,
    type: item.type,
    data: structuredClone(item.data),
  }))
  items.sort((left, right) => left.key.localeCompare(right.key))
  if (new Set(items.map((item) => item.key)).size !== items.length) fail("static export item keys must be unique")
  if (items.filter((item) => item.type === "session").length !== 1)
    fail("static export must contain exactly one session item")

  let scannedValueCount = 0
  for (const item of items) {
    if (!EXPORT_KEY.test(item.key)) fail(`static export key is invalid: ${item.key}`)
    validateItemScope(item, sessionID, projectID, location)
    scannedValueCount += scanJSON(item.data, `/items/${pointerSegment(item.key)}/data`)
  }

  const content = { format: FORMAT, items }
  const canonical = canonicalJson(content) ?? fail("static export is not canonically serializable")
  const canonicalBytes = Buffer.byteLength(canonical)
  if (canonicalBytes > MAX_EXPORT_BYTES) fail(`static export exceeds ${MAX_EXPORT_BYTES} canonical bytes`)
  const contentDigest = canonicalHash(content) ?? fail("static export is not canonically hashable")
  return { evidence: { ...content, contentDigest, canonicalBytes }, scannedValueCount }
}

function exclusions(raw: ReadonlyArray<Exclusion>) {
  if (raw.length > MAX_EXCLUSIONS) fail(`heuristic scan exclusions exceed ${MAX_EXCLUSIONS} entries`)
  const excluded = raw.map((item) => ({ ...item })).sort((left, right) => left.path.localeCompare(right.path))
  for (const item of excluded) {
    if (
      !item.path.startsWith("/") ||
      item.path.length > 1024 ||
      /[\0\r\n]/.test(item.path) ||
      item.path.split("/").some((segment, index) => index > 0 && !segment)
    )
      fail("heuristic scan exclusion paths must be bounded JSON pointers")
  }
  if (new Set(excluded.map((item) => item.path)).size !== excluded.length)
    fail("heuristic scan exclusion paths must be unique")
  return excluded
}

function targetEvidence(raw: typeof CaptureTarget.Type, kind: Capture["kind"]) {
  const baseURL = canonicalURL(raw.baseURL, "target.baseURL")
  const organizationID = raw.organizationID
  if (organizationID !== null && !ORGANIZATION_ID.test(organizationID)) fail("target.organizationID is invalid")
  if (raw.visibility === "organization" && organizationID === null)
    fail("organization visibility requires an organizationID")
  if (kind === "share" && raw.publication !== null) fail("a new share cannot claim an existing publication")
  if (kind === "unshare" && raw.publication === null) fail("unshare requires the exact existing publication")
  const publication = raw.publication
    ? {
        id: PUBLICATION_ID.test(raw.publication.id) ? raw.publication.id : fail("target.publication.id is invalid"),
        url: canonicalURL(raw.publication.url, "target.publication.url"),
        exportDigest: SHA256.test(raw.publication.originalExportDigest.toLowerCase())
          ? raw.publication.originalExportDigest.toLowerCase()
          : fail("target.publication.originalExportDigest must be a sha256 digest"),
      }
    : null
  return {
    baseURL,
    organizationID,
    visibility: raw.visibility,
    publication,
    transportPolicy: "https-only" as const,
  }
}

function canonicalizeCapture(raw: Capture): Preflight {
  assertCollectionBounds(raw)
  if (!REQUEST_ID.test(raw.requestID)) fail("requestID is invalid")
  if (!PROJECT_ID.test(raw.projectID)) fail("projectID is invalid")
  if (!Number.isSafeInteger(raw.eventHighWaterMark) || raw.eventHighWaterMark < 0)
    fail("eventHighWaterMark must be a safe non-negative integer")
  const location = canonicalAbsolute(raw.location, "location")
  const frozenExport = exportEvidence(raw.export, raw.sessionID, raw.projectID, location)
  const excluded = exclusions(raw.heuristicScan.excluded)
  const exclusionDigest = canonicalHash(excluded) ?? fail("heuristic scan exclusions are not canonically hashable")
  const result: Preflight = {
    version: 1,
    kind: raw.kind,
    sessionID: raw.sessionID,
    projectID: raw.projectID,
    location,
    eventHighWaterMark: raw.eventHighWaterMark,
    export: frozenExport.evidence,
    target: targetEvidence(raw.target, raw.kind),
    heuristicScanEvidence: {
      scannerVersion: HEURISTIC_SCANNER_VERSION,
      scannedValueCount: frozenExport.scannedValueCount,
      excludedCount: excluded.length,
      excluded,
      exclusionDigest,
    },
    requestID: raw.requestID,
  }
  assertSnapshotEnvelopeBound(result, "complete session share snapshot envelope")
  return result
}

function canonicalizePreflight(raw: Preflight): Preflight {
  const capture: Capture = {
    version: raw.version,
    kind: raw.kind,
    sessionID: raw.sessionID,
    projectID: raw.projectID,
    location: raw.location,
    eventHighWaterMark: raw.eventHighWaterMark,
    export: { format: raw.export.format, items: raw.export.items },
    target: {
      baseURL: raw.target.baseURL,
      organizationID: raw.target.organizationID,
      visibility: raw.target.visibility,
      publication: raw.target.publication
        ? {
            id: raw.target.publication.id,
            url: raw.target.publication.url,
            originalExportDigest: raw.target.publication.exportDigest,
          }
        : null,
    },
    heuristicScan: {
      scannerVersion: raw.heuristicScanEvidence.scannerVersion,
      excluded: raw.heuristicScanEvidence.excluded,
    },
    requestID: raw.requestID,
  }
  const canonical = canonicalizeCapture(capture)
  if (raw.target.transportPolicy !== "https-only") fail("session share transport policy is not canonical")
  if (
    raw.export.contentDigest !== canonical.export.contentDigest ||
    raw.export.canonicalBytes !== canonical.export.canonicalBytes ||
    raw.heuristicScanEvidence.scannedValueCount !== canonical.heuristicScanEvidence.scannedValueCount ||
    raw.heuristicScanEvidence.excludedCount !== canonical.heuristicScanEvidence.excludedCount ||
    raw.heuristicScanEvidence.exclusionDigest !== canonical.heuristicScanEvidence.exclusionDigest
  )
    fail("static export hash, size, heuristic scan, or exclusion evidence does not match its content")
  return canonical
}

function unsigned(snapshot: Snapshot): Preflight {
  const { digest: _digest, ...value } = snapshot
  return value
}

function stable(snapshot: Snapshot): ClaimInput {
  const { requestID: _requestID, digest: _digest, ...value } = snapshot
  return value
}

function integrityDigest(value: Preflight) {
  return canonicalHash(value) ?? fail("session share preflight is not canonically serializable")
}

function sealed(input: unknown): Snapshot {
  assertRawBounds(input, "session share snapshot")
  assertRawCollectionBounds(input)
  assertSnapshotEnvelopeBound(input, "session share snapshot")
  let candidate: Snapshot
  try {
    candidate = strictSnapshot(input)
  } catch (cause) {
    return fail(`snapshot schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  const canonical = canonicalizePreflight(unsigned(candidate))
  if (canonicalHash(canonical) !== canonicalHash(unsigned(candidate)))
    fail("snapshot contains non-canonical export, scope, URL, or exclusion evidence")
  if (!SHA256.test(candidate.digest) || candidate.digest !== integrityDigest(canonical))
    fail("snapshot digest does not match its stored payload")
  return immutable({ ...canonical, digest: candidate.digest })
}

/** Seal one already-static HTTPS capture. This function does not read Session state or contact a share provider. */
export function encode(input: Capture): Snapshot {
  assertRawBounds(input, "session share capture")
  assertRawCollectionBounds(input)
  assertSnapshotEnvelopeBound(input, "session share capture")
  let decoded: Capture
  try {
    decoded = strictCapture(input)
  } catch (cause) {
    return fail(`capture schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`)
  }
  assertCollectionBounds(decoded)
  const canonical = canonicalizeCapture(decoded)
  const snapshot = strictSnapshot({ ...canonical, digest: integrityDigest(canonical) })
  assertSnapshotEnvelopeBound(snapshot, "complete session share snapshot envelope")
  return immutable(snapshot)
}

/** Re-validate a sealed snapshot before a later worker or receipt store uses it. */
export function decodeSnapshot(input: unknown): Snapshot {
  return sealed(input)
}

/** Match a retry's presented request fields without allowing it to redefine the sealed publication. */
export function matchesPresentedInput(
  input: unknown,
  expected: {
    readonly kind: Snapshot["kind"]
    readonly requestID: string
    readonly sessionID: string
    readonly baseURL: string
    readonly organizationID: string | null
    readonly visibility: Snapshot["target"]["visibility"]
  },
) {
  try {
    const snapshot = sealed(input)
    return (
      snapshot.kind === expected.kind &&
      snapshot.requestID === expected.requestID &&
      snapshot.sessionID === expected.sessionID &&
      snapshot.target.baseURL === expected.baseURL &&
      snapshot.target.organizationID === expected.organizationID &&
      snapshot.target.visibility === expected.visibility
    )
  } catch {
    return false
  }
}

/**
 * Verify a sealed snapshot against independently supplied approved evidence.
 * Supplying a later live export is intentionally drift and can never extend
 * the content the human approved.
 */
export function decode(input: unknown, expected: ClaimInput): { readonly snapshot: Snapshot } {
  const snapshot = sealed(input)
  assertRawBounds(expected, "approved session share evidence")
  assertRawCollectionBounds(expected)
  assertSnapshotEnvelopeBound(expected, "approved session share evidence")
  let current: ClaimInput
  try {
    current = strictClaimInput(expected)
  } catch (cause) {
    return fail(
      `approved evidence schema is invalid: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
    )
  }
  const canonicalCurrent = canonicalizePreflight({ ...current, requestID: snapshot.requestID })
  const expectedClaim = stable({ ...canonicalCurrent, digest: integrityDigest(canonicalCurrent) })
  if (canonicalHash(stable(snapshot)) !== canonicalHash(expectedClaim))
    fail("session, project, location, event, export, target, or exclusion scope drifted after approval")
  return immutable({ snapshot })
}

/** Exact request-bound payload. It is static and has no listener or provider handle. */
export function executionInput(input: unknown): Preflight {
  return immutable(unsigned(sealed(input)))
}

/** Request-independent canonical identity for a future ClaimIndex integration. */
export function claimMaterial(input: unknown): { readonly input: ClaimInput; readonly payload: ClaimInput } {
  const value = immutable(stable(sealed(input)))
  return immutable({ input: value, payload: value })
}

export type ActionMaterial = {
  readonly name: "session.share" | "session.unshare"
  readonly inputDigest: string
  readonly resources: ReadonlyArray<string>
  readonly semantics: AgentRuntime.EffectSemantics
  readonly reasonSummary: string
  readonly requiresFreshHumanConfirmation: true
}

/** Pure L3 declaration. This does not assert that ShareNext can execute it recoverably. */
export function actionMaterial(input: unknown): ActionMaterial {
  const snapshot = sealed(input)
  const name = `session.${snapshot.kind}` as ActionMaterial["name"]
  const publication = snapshot.target.publication
  const resources = [
    `session:${snapshot.sessionID}`,
    `session-event:${snapshot.sessionID}@${snapshot.eventHighWaterMark}`,
    `project:${snapshot.projectID}`,
    `filesystem:${snapshot.location}`,
    `share-endpoint:${snapshot.target.baseURL}`,
    `share-visibility:${snapshot.target.visibility}`,
    `share-export:${snapshot.export.contentDigest}`,
    `share-heuristic-scan:${snapshot.heuristicScanEvidence.exclusionDigest}`,
    ...(snapshot.target.organizationID ? [`organization:${snapshot.target.organizationID}`] : []),
    ...(publication
      ? [
          `share-publication:${publication.id}`,
          `share-url:${publication.url}`,
          `share-original-export:${publication.exportDigest}`,
        ]
      : []),
  ]
  return immutable({
    name,
    inputDigest: canonicalHash(claimMaterial(snapshot).input) ?? fail("session share claim material is not canonical"),
    resources: [...new Set(resources)].sort(),
    semantics: AgentRuntime.EffectSemantics.make({
      riskTier: "L3",
      authority: "human",
      idempotency: snapshot.kind === "share" ? "non_idempotent" : "conditional",
      retryability: "never",
      reversibility: snapshot.kind === "share" ? "compensatable" : "irreversible",
      filesystemScope: [],
      networkScope: [snapshot.target.baseURL],
      secretScope: [
        "share-provider:active-account",
        ...(publication ? [`session-share:${snapshot.sessionID}:${publication.id}`] : []),
      ],
      externalServices: ["share-provider", "session-share-store"],
      compensation: snapshot.kind === "share" ? "Remove only the publication returned for this operation." : undefined,
      expectedArtifacts: snapshot.kind === "share" ? ["share-provider:publication"] : [],
      successCriteria:
        snapshot.kind === "share"
          ? [`provider publication contains exactly export ${snapshot.export.contentDigest}`]
          : publication
            ? [`provider no longer exposes publication ${publication.id}`]
            : [],
    }),
    reasonSummary: `${name} changes external publication visibility for a frozen, heuristically scanned session export; fresh human confirmation is required.`,
    requiresFreshHumanConfirmation: true,
  })
}

/** Future integration must derive approval only from the verified snapshot. */
export function authorizationPlan(input: unknown): ActionGateway.AuthorizationPlan {
  const material = actionMaterial(input)
  return immutable({
    requests: [{ action: material.name, resources: material.resources }],
    metadata: { fresh: true, reason: material.reasonSummary },
  })
}

export * as SessionShareSnapshot from "./session-snapshot"
