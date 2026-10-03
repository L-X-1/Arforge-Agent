import { Memory } from "./memory"
import { Schema } from "effect"

export const DedupRelation = Schema.Literals(["novel", "exact_duplicate", "near_duplicate"]).annotate({
  identifier: "MemoryDedupRelation",
})
export type DedupRelation = typeof DedupRelation.Type

export const ConflictKind = Schema.Literals([
  "mutually_exclusive_fact",
  "scope_mismatch",
  "stale_successor",
  "user_vs_auto_priority",
]).annotate({ identifier: "MemoryConflictKind" })
export type ConflictKind = typeof ConflictKind.Type

export const ConflictLifecycle = Schema.Literals(["pending", "resolved", "dismissed", "undone"]).annotate({
  identifier: "MemoryTruthConflictLifecycle",
})
export type ConflictLifecycle = typeof ConflictLifecycle.Type

export const UnresolvedMode = Schema.Literals(["exclude_both", "lower_both"]).annotate({
  identifier: "MemoryUnresolvedConflictMode",
})
export type UnresolvedMode = typeof UnresolvedMode.Type

export const RecallDisposition = Schema.Literals(["exclude", "include", "lower"]).annotate({
  identifier: "MemoryConflictRecallDisposition",
})
export type RecallDisposition = typeof RecallDisposition.Type

export const DedupDecision = Schema.Struct({
  relation: DedupRelation,
  similarity: Schema.Finite,
  leftMemoryID: Memory.ID,
  rightMemoryID: Memory.ID,
}).annotate({ identifier: "MemoryDedupDecision" })
export interface DedupDecision extends Schema.Schema.Type<typeof DedupDecision> {}

export const ConflictInput = Schema.Struct({
  kind: ConflictKind,
  status: ConflictLifecycle,
  leftMemoryID: Memory.ID,
  rightMemoryID: Memory.ID,
  leftSource: Memory.Source,
  rightSource: Memory.Source,
  leftScope: Memory.Scope,
  rightScope: Memory.Scope,
  unresolvedMode: UnresolvedMode,
  chosenMemoryID: Memory.ID.pipe(Schema.optional),
  staleMemoryID: Memory.ID.pipe(Schema.optional),
}).annotate({ identifier: "MemoryTruthBoundaryConflictInput" })
export interface ConflictInput extends Schema.Schema.Type<typeof ConflictInput> {}

export const ConflictDecision = Schema.Struct({
  truthBoundary: Schema.Literal("governed_record"),
  left: RecallDisposition,
  right: RecallDisposition,
  priorityMemoryID: Memory.ID.pipe(Schema.optional),
  reason: Schema.String,
}).annotate({ identifier: "MemoryTruthBoundaryConflictDecision" })
export interface ConflictDecision extends Schema.Schema.Type<typeof ConflictDecision> {}
