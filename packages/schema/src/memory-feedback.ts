export * as MemoryFeedback from "./memory-feedback"

import { Schema } from "effect"

/** Requirements that gate a durable, workspace-scoped recall feedback producer. */
export const Requirement = Schema.Literals([
  "durable_retrieval_event",
  "retrieval_uid",
  "returned_set_validation",
  "workspace_identity_binding",
  "actor_authorization",
  "transactional_update",
  "retention_or_clear_policy",
  "cross_process_evidence",
])
export type Requirement = typeof Requirement.Type

export const Contract = Schema.Struct({
  schema_version: Schema.Literal(1),
  execution_mode: Schema.Literal("read-only-memory-feedback-contract-audit"),
  side_effects: Schema.Literal("none"),
  status: Schema.Literal("not_ready"),
  ready: Schema.Literal(false),
  model_invoked: Schema.Literal(false),
  writes: Schema.Literal(0),
  missing_requirements: Schema.Array(Requirement),
  legacy_source: Schema.Literal("python-memory-retrieval-event"),
  decision: Schema.Literal("fail-closed"),
  caveat: Schema.String,
}).annotate({ identifier: "MemoryFeedback.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}
