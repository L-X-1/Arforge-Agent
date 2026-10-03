export * as CostOptimization from "./cost-optimization"

import { Schema } from "effect"

/** Requirements that gate a trustworthy cross-process cost report. */
export const Requirement = Schema.Literals([
  "observation_journal",
  "run_session_binding",
  "workspace_identity_binding",
  "durable_cost_attribution",
  "provider_pricing_version",
  "token_usage_reconciliation",
  "cross_process_aggregation",
  "restart_recovery",
  "retention_or_clear_policy",
  "evidence_digest",
])
export type Requirement = typeof Requirement.Type

export const AvailablePrimitives = Schema.Struct({
  sessionStats: Schema.Literal("available-but-not-cost-ledger"),
  fileMutationFingerprint: Schema.Literal("available-but-not-read-cost-ledger"),
  agentMetrics: Schema.Literal("available-but-not-cost-ledger"),
}).annotate({ identifier: "CostOptimization.AvailablePrimitives" })
export interface AvailablePrimitives extends Schema.Schema.Type<typeof AvailablePrimitives> {}

export const Contract = Schema.Struct({
  schema_version: Schema.Literal(1),
  execution_mode: Schema.Literal("read-only-cost-optimization-contract-audit"),
  side_effects: Schema.Literal("none"),
  status: Schema.Literal("not_ready"),
  ready: Schema.Literal(false),
  model_invoked: Schema.Literal(false),
  writes: Schema.Literal(0),
  missing_requirements: Schema.Array(Requirement),
  available_primitives: AvailablePrimitives,
  legacy_source: Schema.Literal("python-cost-optimization"),
  decision: Schema.Literal("fail-closed"),
  caveat: Schema.String,
}).annotate({ identifier: "CostOptimization.Contract" })
export interface Contract extends Schema.Schema.Type<typeof Contract> {}
