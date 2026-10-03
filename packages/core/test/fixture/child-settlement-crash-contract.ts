import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"

export const parentRunID = AgentRuntime.RunID.make("run_child_settlement_sigkill_parent")
export const idempotencyKey = "child-settlement-sigkill"
export const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
