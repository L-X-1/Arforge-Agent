import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

/**
 * Single executable contract for durable Action state transitions.
 *
 * The gateway uses it before appending transitions and the durable reducer
 * uses it while replaying history. Keeping both paths on the same table makes
 * an out-of-band or corrupted state event fail closed instead of silently
 * becoming execution authority.
 */
const transitions: Readonly<Record<AgentRuntime.ActionStatus, ReadonlySet<AgentRuntime.ActionStatus>>> = {
  proposed: new Set(["policy_evaluated", "blocked", "cancelled"]),
  policy_evaluated: new Set(["awaiting_approval", "authorized", "blocked", "cancelled"]),
  awaiting_approval: new Set(["authorized", "blocked", "cancelled"]),
  authorized: new Set(["executing", "blocked", "cancelled"]),
  executing: new Set(["observed", "compensating", "blocked"]),
  observed: new Set(["verifying", "compensating", "settled", "blocked"]),
  verifying: new Set(["settled", "blocked"]),
  compensating: new Set(["settled", "blocked"]),
  settled: new Set(),
  blocked: new Set(),
  cancelled: new Set(),
}

export const canTransition = (from: AgentRuntime.ActionStatus, to: AgentRuntime.ActionStatus) =>
  transitions[from].has(to)

export const isTerminal = (status: AgentRuntime.ActionStatus) =>
  status === "settled" || status === "blocked" || status === "cancelled"
