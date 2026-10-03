import type { ActionGateway } from "@arforge-ai/core/action-gateway"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export type ActiveAuthorization = {
  readonly actionID: AgentRuntime.ActionID
  readonly plan: ActionGateway.AuthorizationPlan
}

export type LeafPermissionRequest = {
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
}

export class ScopeEscalationError extends Error {
  override readonly name = "ScopeEscalationError"

  constructor(
    readonly granted: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>,
    readonly requested: LeafPermissionRequest,
  ) {
    super(
      `Tool execution requested a broader ${requested.permission} scope than its durable preflight authorization. ` +
        "The action was stopped before the expanded effect could run.",
    )
  }
}

const normalize = (value: string) => value.replaceAll("\\", "/")

/**
 * A leaf check may only reuse the durable preflight for one of the canonical
 * requests of the same permission and the same (or wildcard) resource.
 *
 * A missing active preflight falls back to the legacy interactive gate
 * ("legacy"); an active preflight that does not cover the exact leaf request
 * fails closed with ScopeEscalationError and never asks interactively.
 */
export function evaluateLeafAuthorization(
  active: ActiveAuthorization | undefined,
  requested: LeafPermissionRequest,
): "authorized" | "legacy" | ScopeEscalationError {
  if (!active) return "legacy"
  const matching = active.plan.requests.filter((request) => request.action === requested.permission)
  if (matching.length === 0) return new ScopeEscalationError(active.plan.requests, requested)

  const authorized = requested.patterns.every((pattern) =>
    matching.some((request) =>
      request.resources.some((resource) => resource === "*" || normalize(resource) === normalize(pattern)),
    ),
  )
  return authorized ? "authorized" : new ScopeEscalationError(matching, requested)
}
