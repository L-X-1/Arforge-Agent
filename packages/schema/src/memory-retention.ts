import { AgentRuntime } from "./agent-runtime"
import { Memory } from "./memory"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import { Schema } from "effect"

export const Lifecycle = Schema.Literals([
  "candidate",
  "active",
  "superseded",
  "quarantined",
  "forgotten",
  "rejected",
  "deleted",
]).annotate({ identifier: "MemoryLifecycle" })
export type Lifecycle = typeof Lifecycle.Type

export const RetentionMode = Schema.Literals(["indefinite", "ttl", "decay", "ttl_and_decay"]).annotate({
  identifier: "MemoryRetentionMode",
})
export type RetentionMode = typeof RetentionMode.Type

export const RetentionPolicy = Schema.Struct({
  mode: RetentionMode,
  expiresAt: DateTimeUtcFromMillis.pipe(optional),
  halfLifeDays: NonNegativeInt.pipe(optional),
  autoForget: Schema.Boolean,
  userExplicitNoDecay: Schema.Boolean,
}).annotate({ identifier: "MemoryRetentionPolicy" })
export interface RetentionPolicy extends Schema.Schema.Type<typeof RetentionPolicy> {}

export const ForgetRequest = Schema.Struct({
  memoryID: Memory.ID,
  expectedVersion: NonNegativeInt,
  actor: Schema.Literals(["user", "agent", "maintenance"]),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
}).annotate({ identifier: "MemoryForgetRequest" })
export interface ForgetRequest extends Schema.Schema.Type<typeof ForgetRequest> {}

export const RestoreRequest = Schema.Struct({
  memoryID: Memory.ID,
  expectedVersion: NonNegativeInt,
  actor: Schema.Literals(["user", "maintenance"]),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
}).annotate({ identifier: "MemoryRestoreRequest" })
export interface RestoreRequest extends Schema.Schema.Type<typeof RestoreRequest> {}

export const MaintenanceDeleteRequest = Schema.Struct({
  memoryID: Memory.ID,
  expectedVersion: NonNegativeInt,
  actionID: AgentRuntime.ActionID,
  actor: Schema.Literals(["maintenance"]),
  maintenanceAuthority: Schema.Literal(true),
  explicitDestructive: Schema.Literal(true),
  redactionEvidenceID: AgentRuntime.EvidenceID,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
}).annotate({ identifier: "MemoryMaintenanceDeleteRequest" })
export interface MaintenanceDeleteRequest extends Schema.Schema.Type<typeof MaintenanceDeleteRequest> {}

export const DeleteDecision = Schema.Struct({
  allowed: Schema.Boolean,
  reason: Schema.String,
  clearsProjection: Schema.Boolean,
  clearsRevisions: Schema.Boolean,
  clearsRelations: Schema.Boolean,
  updatesRetrievalIndex: Schema.Boolean,
  recordsRedactionEvidence: Schema.Boolean,
}).annotate({ identifier: "MemoryDeleteDecision" })
export interface DeleteDecision extends Schema.Schema.Type<typeof DeleteDecision> {}
