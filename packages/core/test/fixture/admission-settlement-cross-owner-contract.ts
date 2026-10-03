import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"

export const phases = [
  "before-evidence",
  "after-evidence",
  "after-result",
  "after-owners-before-ack",
  "after-outbox-commit",
] as const
export type Phase = (typeof phases)[number]

export const identity = {
  tenantID: "ten_cross_owner_settlement",
  userID: "usr_cross_owner_settlement",
  actor: "user:usr_cross_owner_settlement",
}

export const descriptorDigest = "c".repeat(64)

export const runIDs = (phase: Phase) => {
  const parentRunID = AgentRuntime.RunID.make(`run_cross_owner_${phase}_parent`)
  const idempotencyKey = `cross-owner-${phase}`
  const childRunID = childRunIDFor(parentRunID, idempotencyKey)
  if (!childRunID) throw new Error("cross-owner fixture child identity could not be derived")
  return { parentRunID, childRunID, idempotencyKey }
}
