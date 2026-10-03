export * as FileState from "./file-state"

import { Schema } from "effect"

/** Requirements that gate a future cross-process file-observation owner. */
export const Requirement = Schema.Literals([
  "observation_journal",
  "run_session_binding",
  "workspace_identity_binding",
  "durable_persistence",
  "restart_recovery",
  "actor_authorization",
  "cancellation",
  "transactional_settlement",
  "evidence_digest",
  "retention_or_clear_policy",
])
export type Requirement = typeof Requirement.Type

export const AvailablePrimitives = Schema.Struct({
  fileMutationFingerprint: Schema.Literal("available-but-not-observation-ledger"),
  analysisRuns: Schema.Literal("available-but-not-file-observation-ledger"),
  pythonTracker: Schema.Literal("process-local-compatibility-only"),
}).annotate({ identifier: "FileState.AvailablePrimitives" })
export interface AvailablePrimitives extends Schema.Schema.Type<typeof AvailablePrimitives> {}

export const Contract = Schema.Struct({
  schema_version: Schema.Literal(1),
  execution_mode: Schema.Literal("read-only-file-state-contract-audit"),
  side_effects: Schema.Literal("none"),
  status: Schema.Literal("not_ready"),
  ready: Schema.Literal(false),
  model_invoked: Schema.Literal(false),
  writes: Schema.Literal(0),
  missing_requirements: Schema.Array(Requirement),
  available_primitives: AvailablePrimitives,
  legacy_source: Schema.Literal("python-file-state-tracker"),
  decision: Schema.Literal("fail-closed"),
  caveat: Schema.String,
}).annotate({ identifier: "FileState.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}
