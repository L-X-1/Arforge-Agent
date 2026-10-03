export * as Mcp from "./mcp"

import { Schema } from "effect"

/** Stable resource marker for a durable MCP child action. */
export const CHILD_ACTION_RESOURCE = "mcp:child-action"

export const Status = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs_auth") }),
  Schema.Struct({
    status: Schema.Literal("needs_client_registration"),
    error: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("needs_approval"),
    reason: Schema.String,
  }),
]).annotate({ identifier: "McpStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

export const Server = Schema.Struct({
  name: Schema.String,
  status: Status,
  integrationID: Schema.optional(Schema.String),
}).annotate({ identifier: "McpServer" })
export type Server = Schema.Schema.Type<typeof Server>

export const Resource = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ResourceTemplate = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  uriTemplate: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
}).annotate({ identifier: "McpResourceTemplate" })
export type ResourceTemplate = Schema.Schema.Type<typeof ResourceTemplate>

export const ResourceCatalog = Schema.Struct({
  resources: Schema.Array(Resource),
  templates: Schema.Array(ResourceTemplate),
}).annotate({ identifier: "McpResourceCatalog" })
export type ResourceCatalog = Schema.Schema.Type<typeof ResourceCatalog>

/** Safe, generation-scoped capability metadata exposed to clients. */
export const Capability = Schema.Struct({
  id: Schema.String,
  server: Schema.String,
  kind: Schema.Literals(["tool", "prompt", "resource", "resource_template"]),
  generation: Schema.Int,
  name: Schema.String,
  reference: Schema.optional(Schema.String),
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
}).annotate({ identifier: "McpCapability" })
export type Capability = Schema.Schema.Type<typeof Capability>

export const CapabilityCatalog = Schema.Array(Capability).annotate({ identifier: "McpCapabilityCatalog" })
export type CapabilityCatalog = Schema.Schema.Type<typeof CapabilityCatalog>

/**
 * Read-only evidence returned after an MCP child action is reconciled. The
 * response deliberately carries digests and bounded text only; request
 * arguments, credentials and protocol response bodies stay in the durable
 * action/provider boundary.
 */
export const ReconciliationEvidence = Schema.Struct({
  state: Schema.Literals(["known_success", "known_failure", "unknown"]),
  evidenceDigest: Schema.String,
  source: Schema.String,
  observedAt: Schema.Number,
  summary: Schema.NullOr(Schema.String),
}).annotate({ identifier: "McpReconciliationEvidence" })
export type ReconciliationEvidence = Schema.Schema.Type<typeof ReconciliationEvidence>

/**
 * User/maintenance projection of the shared Core reconciliation decision.
 * `automaticRetryAllowed` is a literal false in the wire contract.
 */
export const Reconciliation = Schema.Struct({
  actionID: Schema.String,
  kind: Schema.Literals(["confirmed", "manual_review"]),
  state: Schema.Literals(["known_success", "known_failure", "unknown"]),
  automaticRetryAllowed: Schema.Literal(false),
  reason: Schema.String,
  evidence: ReconciliationEvidence,
}).annotate({ identifier: "McpReconciliation" })
export type Reconciliation = Schema.Schema.Type<typeof Reconciliation>

/**
 * Content-free handle exposed by runtime insight for an MCP child action.
 *
 * The handle contains only the immutable identity needed to call the
 * read-only reconciliation endpoint. It deliberately omits tool arguments,
 * credentials, endpoint URLs, and protocol response bodies. `operatorRequired`
 * keeps the UI honest: evidence can be inspected by a member, but recording
 * it remains an owner/admin operation and never enables automatic retry.
 */
export const ReconciliationHandle = Schema.Struct({
  actionKind: Schema.Literal("mcp"),
  actionVersion: Schema.Literal("1"),
  intentDigest: Schema.String,
  idempotencyKey: Schema.String,
  state: Schema.NullOr(Schema.Literals(["known_success", "known_failure", "unknown"])),
  evidenceDigest: Schema.NullOr(Schema.String),
  source: Schema.NullOr(Schema.String),
  observedAt: Schema.NullOr(Schema.Number),
  summary: Schema.NullOr(Schema.String),
  operatorRequired: Schema.Literal(true),
}).annotate({ identifier: "McpReconciliationHandle" })
export type ReconciliationHandle = Schema.Schema.Type<typeof ReconciliationHandle>
