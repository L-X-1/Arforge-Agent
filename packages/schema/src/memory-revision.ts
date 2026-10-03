import { AgentRuntime } from "./agent-runtime"
import { Memory } from "./memory"
import * as MemoryCandidate from "./memory-candidate"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional, statics } from "./schema"
import { Schema } from "effect"

const brandedID = (prefix: string, brand: string) =>
  Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + Date.now().toString(36)) })),
  )

export const RevisionID = brandedID("mrev_", "MemoryRevisionID")
export type RevisionID = typeof RevisionID.Type

export const Operation = Schema.Literals([
  "create",
  "update",
  "correct",
  "activate",
  "quarantine",
  "restore",
  "conflict_decision",
  "forget",
  "delete",
]).annotate({ identifier: "MemoryRevisionOperation" })
export type Operation = typeof Operation.Type

export const Actor = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system", "recovery", "maintenance"]),
  principalRef: AgentRuntime.ControlPrincipalRef.pipe(optional),
  runID: AgentRuntime.RunID.pipe(optional),
}).annotate({ identifier: "MemoryRevisionActor" })
export interface Actor extends Schema.Schema.Type<typeof Actor> {}

export const ContentDigest = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)).annotate({
  identifier: "MemoryContentDigest",
})
export type ContentDigest = typeof ContentDigest.Type

export const Revision = Schema.Struct({
  revisionID: RevisionID,
  memoryID: Memory.ID,
  version: PositiveInt,
  operation: Operation,
  actor: Actor,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  policyVersion: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  evidenceIDs: Schema.Array(AgentRuntime.EvidenceID).check(Schema.isMaxLength(100)),
  runID: AgentRuntime.RunID.pipe(optional),
  priorDigest: ContentDigest.pipe(optional),
  contentDigest: ContentDigest,
  successorMemoryID: Memory.ID.pipe(optional),
  candidateID: MemoryCandidate.CandidateID.pipe(optional),
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "Memory.Revision" })
export interface Revision extends Schema.Schema.Type<typeof Revision> {}

export const expectedVersion = NonNegativeInt

export const isContiguous = (revisions: ReadonlyArray<Revision>): boolean => {
  if (revisions.length === 0) return true
  const ordered = [...revisions].sort((left, right) => left.version - right.version)
  return ordered.every((revision, index) => revision.version === index + 1)
}

export const isDigestLinked = (revisions: ReadonlyArray<Revision>): boolean => {
  const ordered = [...revisions].sort((left, right) => left.version - right.version)
  return ordered.every((revision, index) => index === 0 || revision.priorDigest === ordered[index - 1].contentDigest)
}
