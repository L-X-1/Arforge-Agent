export * as FeaturePolicy from "./feature-policy"

import { Schema } from "effect"

/** Requirements that gate a transactional feature-policy writer. */
export const Requirement = Schema.Literals([
  "durable_feature_state",
  "workspace_identity_binding",
  "actor_authorization",
  "transactional_update",
  "rollback_or_recovery",
  "audit_evidence",
  "cross_process_consistency",
  "retention_or_clear_policy",
])
export type Requirement = typeof Requirement.Type

export const AvailablePrimitives = Schema.Struct({
  nativePolicy: Schema.Literal("available-read-only"),
  deepInsightsSection: Schema.Literal("available-read-only"),
  pythonRegistry: Schema.Literal("not-read"),
}).annotate({ identifier: "FeaturePolicy.AvailablePrimitives" })
export interface AvailablePrimitives extends Schema.Schema.Type<typeof AvailablePrimitives> {}

export const Contract = Schema.Struct({
  schema_version: Schema.Literal(1),
  execution_mode: Schema.Literal("read-only-feature-policy-contract-audit"),
  side_effects: Schema.Literal("none"),
  status: Schema.Literal("not_ready"),
  ready: Schema.Literal(false),
  model_invoked: Schema.Literal(false),
  writes: Schema.Literal(0),
  missing_requirements: Schema.Array(Requirement),
  available_primitives: AvailablePrimitives,
  legacy_source: Schema.Literal("python-feature-flags"),
  decision: Schema.Literal("fail-closed"),
  caveat: Schema.String,
}).annotate({ identifier: "FeaturePolicy.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}
