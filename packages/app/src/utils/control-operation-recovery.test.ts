import { describe, expect, test } from "bun:test"
import {
  beginControlOperation,
  listPendingControlOperations,
  type ControlOperationOptions,
} from "./control-operation-intent"
import { startControlOperationRecovery, type ControlOperationRecoveryTarget } from "./control-operation-recovery"

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
}

function options() {
  let next = 0
  return {
    storage: memoryStorage(),
    randomUUID: () => `00000000-0000-4000-8000-${(++next).toString().padStart(12, "0")}`,
    retryDelayMs: 1,
    maxWaitMs: 20,
  } satisfies ControlOperationOptions & { retryDelayMs: number; maxWaitMs: number }
}

describe("control operation startup recovery", () => {
  for (const newLayoutDesigns of [false, true]) {
    test(`blocks local intents at the shared app root when no authoritative lookup exists and newLayoutDesigns=${newLayoutDesigns}`, async () => {
      const state = options()
      const local = await beginControlOperation(
        {
          server: "local",
          project: "C:\\local-repo",
          location: "C:\\local-repo",
          kind: "worktree.create",
          input: {},
        },
        state,
      )
      const remote = await beginControlOperation(
        {
          server: "https://remote.example",
          project: "/srv/repo",
          location: "/srv/repo",
          kind: "worktree.reset",
          input: { directory: "/srv/repo/.arforge/worktree/task" },
        },
        state,
      )
      const target = (scope: string): ControlOperationRecoveryTarget => ({
        scope,
      })

      // Target order intentionally differs from the persisted order; startup
      // reporting must match canonical server scope, never selected server.
      const started = await startControlOperationRecovery([target("https://remote.example"), target("local")], state)

      expect(started.tasks).toEqual([])
      expect(started.unavailableServerScopes).toEqual([])
      expect(started.blockedServerScopes).toEqual(["local", "https://remote.example"])
      expect((await listPendingControlOperations(state)).intents.map((intent) => intent.requestID)).toEqual([
        local.requestID,
        remote.requestID,
      ])
    })
  }

  test("retains an intent when its configured server is unavailable", async () => {
    const state = options()
    const pending = await beginControlOperation(
      {
        server: "https://removed.example",
        project: "/srv/repo",
        location: "/srv/repo",
        kind: "worktree.remove",
        input: { directory: "/srv/repo/.arforge/worktree/task" },
      },
      state,
    )

    const started = await startControlOperationRecovery([], state)

    expect(started.tasks).toEqual([])
    expect(started.unavailableServerScopes).toEqual(["https://removed.example"])
    expect(started.blockedServerScopes).toEqual([])
    expect((await listPendingControlOperations(state)).intents.map((intent) => intent.requestID)).toEqual([
      pending.requestID,
    ])
  })

  test("shows only a matching server-backed phase and never replays the stored intent", async () => {
    const state = options()
    const pending = await beginControlOperation(
      {
        server: "local",
        project: "C:\\local-repo",
        location: "C:\\local-repo",
        kind: "worktree.create",
        input: {},
      },
      state,
    )
    const lookup: ControlOperationRecoveryTarget["lookup"] = async (input) => ({
      runID: "run_control_recovery",
      actionID: "act_control_recovery",
      requestID: input.requestID,
      operation: input.operation,
      phase: "waiting_for_confirmation",
      recovery: "awaiting_authorization",
      canApprove: true,
    })

    const started = await startControlOperationRecovery([{ scope: "local", lookup }], state)

    expect(started.tasks).toEqual([])
    expect(started.blockedServerScopes).toEqual([])
    expect(started.statuses).toEqual([
      {
        scope: "local",
        status: {
          runID: "run_control_recovery",
          actionID: "act_control_recovery",
          requestID: pending.requestID,
          operation: "worktree.create",
          phase: "waiting_for_confirmation",
          recovery: "awaiting_authorization",
          canApprove: true,
        },
      },
    ])
    expect((await listPendingControlOperations(state)).intents.map((intent) => intent.requestID)).toEqual([
      pending.requestID,
    ])
  })

  test("fails closed when a status reply does not bind the stored request alias", async () => {
    const state = options()
    const pending = await beginControlOperation(
      {
        server: "local",
        project: "C:\\local-repo",
        location: "C:\\local-repo",
        kind: "worktree.remove",
        input: { directory: "C:\\local-repo\\.arforge\\worktree\\task" },
      },
      state,
    )

    const started = await startControlOperationRecovery(
      [
        {
          scope: "local",
          lookup: async (input) => ({
            runID: "run_wrong_alias",
            actionID: "act_wrong_alias",
            requestID: `${input.requestID}_other`,
            operation: input.operation,
            phase: "completed",
            recovery: "none",
            canApprove: false,
          }),
        },
      ],
      state,
    )

    expect(started.statuses).toEqual([])
    expect(started.blockedServerScopes).toEqual(["local"])
    expect(started.tasks).toEqual([])
    expect((await listPendingControlOperations(state)).intents.map((intent) => intent.requestID)).toEqual([
      pending.requestID,
    ])
  })
})
