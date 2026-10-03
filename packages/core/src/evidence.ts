export * as EvidenceV2 from "./evidence"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Schema } from "effect"
import * as SourceRegistry from "./source-registry"

const MaximumSummary = 2_000

export type CreateInput = {
  readonly evidenceID?: AgentRuntime.EvidenceID
  readonly sourceID: string
  readonly contentDigest: string
  readonly artifactDigest?: string
  readonly extractionMethod: string
  readonly extractionVersion: string
  readonly observationIDs?: ReadonlyArray<AgentRuntime.ObservationID>
  readonly runID?: AgentRuntime.RunID
  readonly actionID?: AgentRuntime.ActionID
  readonly trust: AgentRuntime.Evidence["trust"]
  readonly instructionAllowed: boolean
  readonly sensitivity: "public" | "internal" | "confidential" | "secret"
  readonly capturedAt?: number
  readonly validAt?: number
  readonly summary: string
  readonly artifactRef?: string
  readonly verificationStatus?: "unverified" | "verified" | "rejected" | "expired"
}

export interface Projection {
  readonly evidenceID: AgentRuntime.EvidenceID
  readonly sourceID: string
  readonly contentDigest: string
  readonly artifactDigest?: string
  readonly summary: string
  readonly trust: AgentRuntime.Evidence["trust"]
  readonly sensitivity: CreateInput["sensitivity"]
  readonly instructionAllowed: boolean
  readonly capturedAt: DateTime.Utc
  readonly validAt?: DateTime.Utc
  readonly artifactRef?: string
  readonly verificationStatus: NonNullable<CreateInput["verificationStatus"]>
}

/**
 * Bounded, payload-free resolution of EvidenceID references.  A resolver is
 * intentionally a projection only: callers can decide whether a missing or
 * malformed reference blocks their transaction without receiving evidence
 * summaries, artifact handles, or other sensitive content.
 */
export interface ReferenceResolution {
  readonly requested: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly present: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly missing: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly duplicate: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly invalid: ReadonlyArray<string>
  readonly valid: boolean
}

/**
 * Durable, payload-free resolver facts.  A record digest is safe metadata and
 * is required when a caller needs to compare an immutable receipt with the
 * owner row after a restart.  The underlying Evidence record is never exposed.
 */
export interface ReferenceResolutionFacts {
  readonly resolution: ReferenceResolution
  readonly recordDigests: ReadonlyArray<{
    readonly evidenceID: AgentRuntime.EvidenceID
    readonly recordDigest: string
  }>
}

const evidenceIDPattern = /^evd_[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

const frozen = <T>(values: ReadonlyArray<T>): ReadonlyArray<T> => Object.freeze([...values])

/**
 * Resolve IDs against an already-authorized availability set.  The helper is
 * shared by the in-memory Evidence service and durable ExperienceStore so
 * both paths expose identical duplicate, malformed, and missing semantics.
 */
export function resolveReferenceSet(
  requested: ReadonlyArray<AgentRuntime.EvidenceID>,
  available: ReadonlySet<string>,
  maximum = 32,
): ReferenceResolution {
  const requestedValues = [...requested]
  const requestedStrings = requestedValues.map(String)
  const seen = new Set<string>()
  const duplicate: AgentRuntime.EvidenceID[] = []
  const invalid: string[] = []
  for (const value of requestedStrings) {
    if (!evidenceIDPattern.test(value)) invalid.push(value)
    if (seen.has(value)) duplicate.push(value as AgentRuntime.EvidenceID)
    else seen.add(value)
  }
  const uniqueDuplicate = [...new Map(duplicate.map((value) => [String(value), value])).values()]
  const present = requestedValues.filter((value) => available.has(String(value)))
  const missing = requestedValues.filter((value) => !available.has(String(value)))
  return Object.freeze({
    requested: frozen(requestedValues),
    present: frozen(present),
    missing: frozen(missing),
    duplicate: frozen(uniqueDuplicate),
    invalid: frozen(invalid),
    valid:
      requestedValues.length <= maximum &&
      invalid.length === 0 &&
      uniqueDuplicate.length === 0 &&
      missing.length === 0,
  })
}

export class InvalidEvidenceError extends Error {
  readonly _tag = "Context.InvalidEvidence"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

export class EvidenceConflictError extends Error {
  readonly _tag = "Context.EvidenceConflict"
  constructor(readonly evidenceID: AgentRuntime.EvidenceID) {
    super(`Evidence ${evidenceID} is already registered with different content`)
  }
}

export interface Interface {
  readonly create: (input: CreateInput) => AgentRuntime.Evidence
  readonly get: (evidenceID: AgentRuntime.EvidenceID) => AgentRuntime.Evidence | undefined
  readonly list: () => ReadonlyArray<AgentRuntime.Evidence>
  readonly project: (evidenceID: AgentRuntime.EvidenceID) => Projection | undefined
  /** Resolve references without exposing the underlying evidence payload. */
  readonly resolve: (evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>) => ReferenceResolution
}

const encoded = (value: AgentRuntime.Evidence) => Schema.encodeSync(AgentRuntime.Evidence)(value)

const canonical = (value: unknown): string => {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

const same = (left: AgentRuntime.Evidence, right: AgentRuntime.Evidence) => canonical(encoded(left)) === canonical(encoded(right))

const freezeEvidence = (value: AgentRuntime.Evidence): AgentRuntime.Evidence =>
  Object.freeze({
    ...value,
    ...(value.observationIDs === undefined ? {} : { observationIDs: Object.freeze([...value.observationIDs]) }),
  })

function validate(input: CreateInput, sources?: SourceRegistry.Interface): void {
  if (!input.sourceID.trim()) throw new InvalidEvidenceError("sourceID is required")
  if (!input.contentDigest.trim()) throw new InvalidEvidenceError("contentDigest is required")
  if (!input.extractionMethod.trim() || !input.extractionVersion.trim())
    throw new InvalidEvidenceError("extraction method and version are required")
  if (!input.summary.trim() || input.summary.length > MaximumSummary)
    throw new InvalidEvidenceError("summary must be bounded and non-empty")
  if (input.instructionAllowed && input.trust !== "trusted")
    throw new InvalidEvidenceError("only trusted evidence may allow instructions")
  const source = sources?.get(input.sourceID)
  if (sources !== undefined && source === undefined) throw new InvalidEvidenceError("sourceID is not registered")
  if (source !== undefined) {
    if (input.instructionAllowed && !source.instructionAllowed)
      throw new InvalidEvidenceError("evidence cannot broaden source instruction permission")
    if (source.sensitivity === "secret" && input.sensitivity !== "secret")
      throw new InvalidEvidenceError("evidence cannot lower source sensitivity")
  }
}

export function create(input: CreateInput, sources?: SourceRegistry.Interface): AgentRuntime.Evidence {
  validate(input, sources)
  return freezeEvidence(
    Schema.decodeUnknownSync(AgentRuntime.Evidence)({
      id: input.evidenceID ?? AgentRuntime.EvidenceID.create(),
      source: input.sourceID,
      sourceDigest: input.contentDigest,
      contentDigest: input.contentDigest,
      ...(input.artifactDigest === undefined ? {} : { artifactDigest: input.artifactDigest }),
      trust: input.trust,
      instructionAllowed: input.instructionAllowed,
      summary: input.summary,
      capturedAt: input.capturedAt ?? Date.now(),
      extractionMethod: input.extractionMethod,
      extractionVersion: input.extractionVersion,
      observationIDs: input.observationIDs ?? [],
      ...(input.runID === undefined ? {} : { runID: input.runID }),
      ...(input.actionID === undefined ? {} : { actionID: input.actionID }),
      sensitivity: input.sensitivity,
      ...(input.validAt === undefined ? {} : { validAt: input.validAt }),
      ...(input.artifactRef === undefined ? {} : { artifactRef: input.artifactRef }),
      verificationStatus: input.verificationStatus ?? "unverified",
    }),
  )
}

export function project(value: AgentRuntime.Evidence): Projection {
  if (
    value.contentDigest === undefined ||
    value.extractionMethod === undefined ||
    value.extractionVersion === undefined ||
    value.sensitivity === undefined ||
    value.verificationStatus === undefined
  )
    throw new InvalidEvidenceError("legacy evidence is missing the Step 4.3 projection fields")
  return Object.freeze({
    evidenceID: value.id,
    sourceID: value.source,
    contentDigest: value.contentDigest,
    ...(value.artifactDigest === undefined ? {} : { artifactDigest: value.artifactDigest }),
    summary: value.summary,
    trust: value.trust,
    sensitivity: value.sensitivity,
    instructionAllowed: value.instructionAllowed,
    capturedAt: value.capturedAt,
    ...(value.validAt === undefined ? {} : { validAt: value.validAt }),
    ...(value.artifactRef === undefined ? {} : { artifactRef: value.artifactRef }),
    verificationStatus: value.verificationStatus,
  })
}

export function makeService(initial: ReadonlyArray<AgentRuntime.Evidence> = [], sources?: SourceRegistry.Interface): Interface {
  const values = new Map<AgentRuntime.EvidenceID, AgentRuntime.Evidence>()
  for (const value of initial) values.set(value.id, freezeEvidence(value))
  return {
    create: (input) => {
      const value = create(input, sources)
      const previous = values.get(value.id)
      if (previous !== undefined) {
        if (!same(previous, value)) throw new EvidenceConflictError(value.id)
        return previous
      }
      values.set(value.id, value)
      return value
    },
    get: (evidenceID) => values.get(evidenceID),
    list: () => Object.freeze([...values.values()]),
    project: (evidenceID) => {
      const value = values.get(evidenceID)
      return value === undefined ? undefined : project(value)
    },
    resolve: (evidenceIDs) => resolveReferenceSet(evidenceIDs, new Set([...values.keys()].map(String))),
  }
}
