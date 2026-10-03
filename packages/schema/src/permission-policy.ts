export * as PermissionPolicy from "./permission-policy"

import { Schema } from "effect"

/** Requirements that gate a safe legacy permission-rule mutation owner. */
export const Requirement = Schema.Literals([
  "typed_rule_schema",
  "workspace_project_binding",
  "actor_authorization",
  "transactional_update",
  "optimistic_revision",
  "audit_evidence",
  "rollback_or_recovery",
  "cross_process_consistency",
])
export type Requirement = typeof Requirement.Type

export const AvailablePrimitives = Schema.Struct({
  savedRuleList: Schema.Literal("available-read-only"),
  savedRuleStore: Schema.Literal("available-but-legacy-write-not-equivalent"),
  sessionAuthorizer: Schema.Literal("available-session-scoped"),
  pythonProfile: Schema.Literal("not-read"),
}).annotate({ identifier: "PermissionPolicy.AvailablePrimitives" })
export interface AvailablePrimitives extends Schema.Schema.Type<typeof AvailablePrimitives> {}

export const Contract = Schema.Struct({
  schema_version: Schema.Literal(1),
  execution_mode: Schema.Literal("read-only-permission-policy-contract-audit"),
  side_effects: Schema.Literal("none"),
  status: Schema.Literal("not_ready"),
  ready: Schema.Literal(false),
  model_invoked: Schema.Literal(false),
  writes: Schema.Literal(0),
  missing_requirements: Schema.Array(Requirement),
  available_primitives: AvailablePrimitives,
  legacy_source: Schema.Literal("python-permission-profile"),
  decision: Schema.Literal("fail-closed"),
  caveat: Schema.String,
}).annotate({ identifier: "PermissionPolicy.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}
