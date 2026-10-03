import { describe, expect, test } from "bun:test"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { WorktreeControlExecutor } from "@/control-operation/worktree-executor"
import { Worktree } from "@/worktree"

describe("WorktreeControlExecutor", () => {
  test("forwards only the sealed worker contract to Worktree's gated entry", async () => {
    let received: unknown
    const durable = {} as DurableRun.Interface
    const executor = WorktreeControlExecutor.makeWorktreeExecutor(
      {
        executeSealedControl: (input: {
          readonly snapshot: WorktreeSnapshot.Snapshot
          readonly runID: AgentRuntime.RunID
          readonly actionID: AgentRuntime.ActionID
          readonly controlLease: DurableRun.RunLeaseCapability
          readonly authorization: ActionGateway.AuthorizationGrantCapability
          readonly controlLeaseValidated: () => Effect.Effect<void>
        }) =>
          Effect.sync(() => {
            received = input
          }),
      } as unknown as Worktree.Interface,
      durable,
    )
    const input = {
      snapshot: { kind: "create", digest: "sealed" } as unknown as WorktreeSnapshot.Snapshot,
      runID: AgentRuntime.RunID.make("run_control_executor"),
      actionID: AgentRuntime.ActionID.make("act_control_executor"),
      controlLease: {} as DurableRun.RunLeaseCapability,
      authorization: {} as ActionGateway.AuthorizationGrantCapability,
      controlLeaseValidated: () => Effect.void,
    }

    await Effect.runPromise(executor.execute(input))
    expect(received).toEqual({ ...input, durable })
    expect(Object.keys(received as object).sort()).toEqual([
      "actionID",
      "authorization",
      "controlLease",
      "controlLeaseValidated",
      "durable",
      "runID",
      "snapshot",
    ])
    expect(Object.hasOwn(received as object, "prepared")).toBe(false)
  })
})
