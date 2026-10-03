export * as McpEvent from "./mcp-event"

import { Schema } from "effect"
import { Event } from "./event"

export const ToolsChanged = Event.define({
  type: "mcp.tools.changed",
  schema: {
    server: Schema.String,
  },
})

export const BrowserOpenFailed = Event.define({
  type: "mcp.browser.open.failed",
  schema: {
    mcpName: Schema.String,
    url: Schema.String,
  },
})

/**
 * Live, redacted supervisor telemetry for MCP clients. This is deliberately
 * not a durable event yet: it is an operational view rebuilt from the current
 * instance and never contains URLs, headers, prompts, or transport errors.
 */
export const SupervisorChanged = Event.define({
  type: "mcp.supervisor.changed",
  schema: {
    server: Schema.String,
    desiredGeneration: Schema.Int,
    observedGeneration: Schema.NullOr(Schema.Int),
    phase: Schema.Literals(["idle", "connecting", "ready", "backoff", "circuit_open", "draining", "closed"] as const),
    health: Schema.Literals(["unknown", "healthy", "unhealthy"] as const),
    failureCount: Schema.Int,
    nextRetryAt: Schema.NullOr(Schema.Int),
    safeMessage: Schema.String,
  },
})

/**
 * Durable, redacted checkpoint for one supervisor aggregate. This is a
 * last-known operational fact, not a permission or credential record: URLs,
 * headers, prompts, tool definitions, and transport errors are intentionally
 * absent. A restarted instance uses it to restore retry/circuit memory while
 * still requiring a fresh live MCP connection before reporting ready.
 */
export const SupervisorCheckpointed = Event.define({
  type: "mcp.supervisor.checkpointed",
  durable: {
    version: 1,
    aggregate: "aggregateID",
  },
  schema: {
    aggregateID: Schema.String,
    server: Schema.String,
    desiredGeneration: Schema.Int,
    observedGeneration: Schema.NullOr(Schema.Int),
    phase: Schema.Literals(["idle", "connecting", "ready", "backoff", "circuit_open", "draining", "closed"] as const),
    health: Schema.Literals(["unknown", "healthy", "unhealthy"] as const),
    failureCount: Schema.Int,
    nextRetryAt: Schema.NullOr(Schema.Int),
    circuitOpenedAt: Schema.NullOr(Schema.Int),
    drainDeadline: Schema.NullOr(Schema.Int),
    lastFailure: Schema.NullOr(
      Schema.Literals([
        "connection_failed",
        "connection_closed",
        "health_check_failed",
        "authentication_required",
        "approval_required",
        "protocol_failed",
        "unknown",
      ] as const),
    ),
    safeMessage: Schema.String,
    savedAt: Schema.Int,
  },
})

export const DurableDefinitions = Event.inventory(SupervisorCheckpointed)

export const Definitions = Event.inventory(ToolsChanged, BrowserOpenFailed, SupervisorChanged, SupervisorCheckpointed)
