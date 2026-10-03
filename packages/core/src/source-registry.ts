export * as SourceRegistry from "./source-registry"

import { DateTime, Schema } from "effect"
import { createHash } from "node:crypto"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "@arforge-ai/schema/schema"

export const SourceID = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/),
).annotate({ identifier: "Context.SourceID" })
export type SourceID = typeof SourceID.Type

export const SourceType = Schema.Literals([
  "system_rules",
  "project_rules",
  "user_message",
  "session_history",
  "file",
  "git",
  "lsp",
  "mcp_resource",
  "web",
  "memory",
  "learning",
  "workflow",
  "tool_output",
])
export type SourceType = typeof SourceType.Type

export const TrustClass = Schema.Literals(["trusted", "verified", "untrusted", "hostile"])
export type TrustClass = typeof TrustClass.Type

export const Sensitivity = Schema.Literals(["public", "internal", "confidential", "secret"])
export type Sensitivity = typeof Sensitivity.Type

export const RetrievalAdapter = Schema.Literals([
  "static",
  "session",
  "filesystem",
  "git",
  "lsp",
  "mcp",
  "web",
  "memory",
  "learning",
  "workflow",
  "tool-output",
])
export type RetrievalAdapter = typeof RetrievalAdapter.Type

export const RedactionMode = Schema.Literals(["none", "secrets", "content", "custom"])
export type RedactionMode = typeof RedactionMode.Type

export const Digest = Schema.String.check(Schema.isPattern(/^(?:sha256:)?[a-f0-9]{64}$/i)).annotate({
  identifier: "Context.Digest",
})
export type Digest = typeof Digest.Type

export const Freshness = Schema.Struct({
  observedAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Context.SourceFreshness" })
export type Freshness = typeof Freshness.Type

export const Limits = Schema.Struct({
  maxBytes: NonNegativeInt,
  maxTokens: NonNegativeInt,
}).annotate({ identifier: "Context.SourceLimits" })
export type Limits = typeof Limits.Type

export const Provenance = Schema.Struct({
  locator: Schema.NonEmptyString,
  digest: Digest,
}).annotate({ identifier: "Context.SourceProvenance" })
export type Provenance = typeof Provenance.Type

export const RedactionPolicy = Schema.Struct({
  mode: RedactionMode,
  fields: Schema.Array(Schema.String),
  replacement: Schema.String.pipe(optional),
}).annotate({ identifier: "Context.SourceRedactionPolicy" })
export type RedactionPolicy = typeof RedactionPolicy.Type

export const SourceRecord = Schema.Struct({
  sourceID: SourceID,
  type: SourceType,
  owner: Schema.NonEmptyString,
  projectID: Schema.NonEmptyString.pipe(optional),
  location: Schema.String.pipe(optional),
  trust: TrustClass,
  instructionAllowed: Schema.Boolean,
  sensitivity: Sensitivity,
  freshness: Freshness,
  limits: Limits,
  provenance: Provenance,
  redactionPolicy: RedactionPolicy,
  retrievalAdapter: RetrievalAdapter,
}).annotate({ identifier: "Context.SourceRecord" })
export type SourceRecord = typeof SourceRecord.Type

export class InvalidSourceError extends Error {
  readonly _tag = "Context.InvalidSource"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

export class SourceConflictError extends Error {
  readonly _tag = "Context.SourceConflict"
  constructor(readonly sourceID: SourceID) {
    super(`Source ${sourceID} is already registered with different metadata`)
  }
}

const adapters: Readonly<globalThis.Record<SourceType, RetrievalAdapter>> = {
  system_rules: "static",
  project_rules: "static",
  user_message: "session",
  session_history: "session",
  file: "filesystem",
  git: "git",
  lsp: "lsp",
  mcp_resource: "mcp",
  web: "web",
  memory: "memory",
  learning: "learning",
  workflow: "workflow",
  tool_output: "tool-output",
}

const instructionSources = new Set<SourceType>(["system_rules", "project_rules"])

const encoded = (value: SourceRecord): unknown => Schema.encodeSync(SourceRecord)(value)

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

export function digest(value: unknown): Digest {
  return Schema.decodeUnknownSync(Digest)(createHash("sha256").update(canonical(value)).digest("hex"))
}

function freezeRecord(value: SourceRecord): SourceRecord {
  return Object.freeze({
    ...value,
    freshness: Object.freeze({ ...value.freshness }),
    limits: Object.freeze({ ...value.limits }),
    provenance: Object.freeze({ ...value.provenance }),
    redactionPolicy: Object.freeze({
      ...value.redactionPolicy,
      fields: Object.freeze([...value.redactionPolicy.fields]),
    }),
  })
}

export function make(input: unknown): SourceRecord {
  const candidate =
    typeof input === "object" &&
    input !== null &&
    "freshness" in input &&
    typeof (input as { freshness?: { observedAt?: unknown } }).freshness?.observedAt !== "number"
      ? Schema.encodeSync(SourceRecord)(input as SourceRecord)
      : input
  const value = Schema.decodeUnknownSync(SourceRecord)(candidate)
  if (value.instructionAllowed && (!instructionSources.has(value.type) || value.trust !== "trusted"))
    throw new InvalidSourceError("Only trusted system_rules or project_rules may allow instructions")
  if (value.retrievalAdapter !== adapters[value.type])
    throw new InvalidSourceError(`Source type ${value.type} must use adapter ${adapters[value.type]}`)
  const expiresAt = value.freshness.expiresAt
  if (expiresAt !== undefined && DateTime.toEpochMillis(expiresAt) <= DateTime.toEpochMillis(value.freshness.observedAt))
    throw new InvalidSourceError("Source expiry must be later than observedAt")
  if (value.sensitivity === "secret" && value.redactionPolicy.mode === "none")
    throw new InvalidSourceError("Secret sources must have a redaction policy")
  return freezeRecord(value)
}

export interface Interface {
  readonly register: (input: unknown) => SourceRecord
  readonly get: (sourceID: SourceID) => SourceRecord | undefined
  readonly list: () => ReadonlyArray<SourceRecord>
}

export function makeRegistry(initial: ReadonlyArray<unknown> = []): Interface {
  const records = new Map<SourceID, SourceRecord>()
  const register = (input: unknown): SourceRecord => {
    const value = make(input)
    const previous = records.get(value.sourceID)
    if (previous !== undefined) {
      if (canonical(encoded(previous)) !== canonical(encoded(value))) throw new SourceConflictError(value.sourceID)
      return previous
    }
    records.set(value.sourceID, value)
    return value
  }
  for (const input of initial) register(input)
  return {
    register,
    get: (sourceID) => records.get(sourceID),
    list: () => Object.freeze([...records.values()]),
  }
}

export const adapterFor = (type: SourceType): RetrievalAdapter => adapters[type]
