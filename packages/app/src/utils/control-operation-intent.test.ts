import { describe, expect, test } from "bun:test"
import {
  beginControlOperation,
  isTerminalControlOperationError,
  listPendingControlOperations,
  runControlOperation,
  runControlOperationToCompletion,
  settleControlOperation,
  waitForControlOperationCompletion,
  type ControlOperationOptions,
  type ControlOperationSpec,
} from "./control-operation-intent"

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
    values,
  }
}

type CreateSpec = Extract<ControlOperationSpec, { kind: "worktree.create" }>

const create = (overrides: Partial<CreateSpec> = {}): CreateSpec => ({
  server: "local",
  project: "C:\\repo\\",
  location: "C:\\repo",
  kind: "worktree.create",
  input: {},
  ...overrides,
})

function options(storage = memoryStorage()) {
  let next = 0
  return {
    storage,
    randomUUID: () => `00000000-0000-4000-8000-${(++next).toString().padStart(12, "0")}`,
  } satisfies ControlOperationOptions & { storage: ReturnType<typeof memoryStorage> }
}

function clientError(name: string | undefined, status: number | undefined) {
  return new Error("request failed", { cause: { body: name ? { name } : undefined, status } })
}

describe("control operation intent", () => {
  test("reuses one persisted request across a recreated desktop caller", async () => {
    const state = options()
    const first = await beginControlOperation(create(), state)
    const reloaded = await beginControlOperation(create({ project: "c:/repo", location: "c:/repo/" }), state)

    expect(reloaded.requestID).toBe(first.requestID)
    expect(state.storage.values.size).toBe(1)
    expect([...state.storage.values.values()][0]).not.toContain("token")
  })

  test("binds identity to server, project, location, kind, and frozen input", async () => {
    const state = options()
    const intents = await Promise.all([
      beginControlOperation(create(), state),
      beginControlOperation(create({ server: "remote" }), state),
      beginControlOperation(create({ project: "C:\\other", location: "C:\\other" }), state),
      beginControlOperation(create({ location: "C:\\repo\\child" }), state),
      beginControlOperation(create({ input: { name: "named" } }), state),
      beginControlOperation(
        {
          server: "local",
          project: "C:\\repo",
          location: "C:\\repo\\child",
          kind: "worktree.reset",
          input: { directory: "C:\\repo\\child" },
        },
        state,
      ),
    ])

    expect(new Set(intents.map((intent) => intent.storageKey)).size).toBe(intents.length)
    expect(new Set(intents.map((intent) => intent.requestID)).size).toBe(intents.length)
  })

  test("freezes session revert identity without persisting message content", async () => {
    const state = options()
    const spec: ControlOperationSpec = {
      server: "local",
      project: "C:\\repo",
      location: "C:\\repo",
      kind: "session.revert",
      input: { sessionID: "ses_1", messageID: "msg_2", partID: "part_3" },
    }
    const intent = await beginControlOperation(spec, state)
    expect(intent.binding.input).toEqual({ sessionID: "ses_1", messageID: "msg_2", partID: "part_3" })
    expect([...state.storage.values.values()][0]).not.toContain("prompt text")

    await expect(
      runControlOperation<true>(
        intent,
        () =>
          Promise.resolve({
            runID: "run_revert",
            actionID: "act_revert",
            requestID: intent.requestID,
            operation: "session.revert",
            phase: "completed",
            recovery: "none",
            canApprove: false,
            result: { kind: "session.revert", completed: true },
          }),
        state,
      ),
    ).resolves.toEqual({ state: "completed", value: true })
    expect((await beginControlOperation(spec, state)).requestID).not.toBe(intent.requestID)
  })

  test("retires only settled or structured terminal operations", async () => {
    const state = options()
    const networkIntent = await beginControlOperation(create(), state)
    await expect(
      runControlOperation(networkIntent, () => Promise.reject(new TypeError("offline")), state),
    ).rejects.toThrow("offline")
    expect((await beginControlOperation(create(), state)).requestID).toBe(networkIntent.requestID)

    await expect(
      runControlOperation(
        networkIntent,
        () => Promise.reject(clientError("ActionGateway.RecoveryRequiredError", 400)),
        state,
      ),
    ).rejects.toThrow("request failed")
    expect((await beginControlOperation(create(), state)).requestID).toBe(networkIntent.requestID)

    await expect(
      runControlOperation(networkIntent, () => Promise.reject(clientError("ActionGateway.BlockedError", 400)), state),
    ).rejects.toThrow("request failed")
    const afterBlocked = await beginControlOperation(create(), state)
    expect(afterBlocked.requestID).not.toBe(networkIntent.requestID)

    await expect(
      runControlOperation(
        afterBlocked,
        () => Promise.resolve({ directory: "C:\\repo\\.arforge\\worktree\\new" }),
        state,
      ),
    ).resolves.toEqual({
      state: "completed",
      value: { directory: "C:\\repo\\.arforge\\worktree\\new" },
    })
    const afterSuccess = await beginControlOperation(create(), state)
    expect(afterSuccess.requestID).not.toBe(afterBlocked.requestID)
  })

  test("treats a status-only 2xx as accepted and never runs legacy completion", async () => {
    const state = options()
    const intent = await beginControlOperation(create(), state)
    const status = {
      runID: "run_accepted",
      actionID: "act_accepted",
      requestID: intent.requestID,
      operation: "worktree.create" as const,
      phase: "waiting_for_confirmation" as const,
      recovery: "awaiting_authorization" as const,
      canApprove: true,
    }

    await expect(runControlOperation(intent, () => Promise.resolve(status), state)).resolves.toEqual({
      state: "status",
      status,
    })
    expect((await beginControlOperation(create(), state)).requestID).toBe(intent.requestID)

    const completed = { ...status, phase: "completed" as const, recovery: "none" as const, canApprove: false }
    await expect(runControlOperation(intent, () => Promise.resolve(completed), state)).resolves.toEqual({
      state: "status",
      status: completed,
    })
    // Status contains no Worktree result, so even a terminal phase cannot
    // retire the identity needed for read-only recovery.
    expect((await beginControlOperation(create(), state)).requestID).toBe(intent.requestID)

  })

  test("settles completed create/remove/reset statuses only with their matching terminal result", async () => {
    const state = options()
    const createIntent = await beginControlOperation(create(), state)
    await expect(
      runControlOperation<{ name: string; directory: string; branch: string }>(
        createIntent,
        () =>
          Promise.resolve({
            runID: "run_create_completed",
            actionID: "act_create_completed",
            requestID: createIntent.requestID,
            operation: "worktree.create",
            phase: "completed",
            recovery: "none",
            canApprove: false,
            result: {
              kind: "worktree.create",
              name: "quiet-forest",
              directory: "C:\\managed\\quiet-forest",
              branch: "arforge/quiet-forest",
            },
          }),
        state,
      ),
    ).resolves.toEqual({
      state: "completed",
      value: {
        name: "quiet-forest",
        directory: "C:\\managed\\quiet-forest",
        branch: "arforge/quiet-forest",
      },
    })
    expect((await beginControlOperation(create(), state)).requestID).not.toBe(createIntent.requestID)

    for (const operation of ["worktree.remove", "worktree.reset"] as const) {
      const spec: ControlOperationSpec = {
        server: "local",
        project: "C:\\repo",
        location: "C:\\repo",
        kind: operation,
        input: { directory: `C:\\managed\\${operation}` },
      }
      const intent = await beginControlOperation(spec, state)
      await expect(
        runControlOperation<true>(
          intent,
          () =>
            Promise.resolve({
              runID: `run_${operation}`,
              actionID: `act_${operation}`,
              requestID: intent.requestID,
              operation,
              phase: "completed",
              recovery: "none",
              canApprove: false,
              result: { kind: operation, completed: true },
            }),
          state,
        ),
      ).resolves.toEqual({ state: "completed", value: true })
      expect((await beginControlOperation(spec, state)).requestID).not.toBe(intent.requestID)
    }
  })

  test("polls only the read endpoint and continues after a matching terminal result", async () => {
    const state = options()
    const intent = await beginControlOperation(create(), state)
    const initial = {
      runID: "run_poll",
      actionID: "act_poll",
      requestID: intent.requestID,
      operation: "worktree.create" as const,
      phase: "waiting_for_confirmation" as const,
      recovery: "awaiting_authorization" as const,
      canApprove: true,
    }
    const seen: unknown[] = []
    const result = await waitForControlOperationCompletion<{ name: string; directory: string; branch: string }>(
      intent,
      initial,
      async (request) => {
        seen.push(request)
        return {
          ...initial,
          phase: "completed",
          recovery: "none",
          canApprove: false,
          result: {
            kind: "worktree.create",
            name: "read-only-result",
            directory: "C:\\managed\\read-only-result",
            branch: "arforge/read-only-result",
          },
        }
      },
      { ...state, retryDelayMs: 1, maxWaitMs: 100 },
    )

    expect(result).toEqual({
      state: "completed",
      value: {
        name: "read-only-result",
        directory: "C:\\managed\\read-only-result",
        branch: "arforge/read-only-result",
      },
    })
    expect(seen).toEqual([
      {
        requestID: intent.requestID,
        operation: "worktree.create",
        location: "c:/repo",
      },
    ])
    expect((await beginControlOperation(create(), state)).requestID).not.toBe(intent.requestID)
  })

  test("submits the mutation once and uses only status reads while waiting", async () => {
    const state = options()
    const intent = await beginControlOperation(create(), state)
    let mutations = 0
    let reads = 0
    const initial = {
      runID: "run_once",
      actionID: "act_once",
      requestID: intent.requestID,
      operation: "worktree.create" as const,
      phase: "queued" as const,
      recovery: "resume" as const,
      canApprove: false,
    }

    await expect(
      runControlOperationToCompletion<{ name: string; directory: string; branch: string }>(
        intent,
        async () => {
          mutations++
          return initial
        },
        async () => {
          reads++
          return {
            ...initial,
            phase: "completed",
            recovery: "none",
            result: {
              kind: "worktree.create",
              name: "single-write",
              directory: "C:\\managed\\single-write",
              branch: "arforge/single-write",
            },
          }
        },
        { ...state, retryDelayMs: 1, maxWaitMs: 100 },
      ),
    ).resolves.toEqual({
      state: "completed",
      value: {
        name: "single-write",
        directory: "C:\\managed\\single-write",
        branch: "arforge/single-write",
      },
    })
    expect(mutations).toBe(1)
    expect(reads).toBe(1)
  })

  test("retains identity on mismatched status, forged result, and malformed legacy 2xx", async () => {
    const state = options()
    const intent = await beginControlOperation(create(), state)
    await expect(
      runControlOperation(
        intent,
        () =>
          Promise.resolve({
            runID: "run_wrong",
            actionID: "act_wrong",
            requestID: `${intent.requestID}_other`,
            operation: "worktree.create" as const,
            phase: "queued" as const,
            recovery: "resume" as const,
            canApprove: false,
          }),
        state,
      ),
    ).rejects.toThrow("Invalid control operation status")
    const base = {
      runID: "run_forged",
      actionID: "act_forged",
      requestID: intent.requestID,
      operation: "worktree.create" as const,
      phase: "completed" as const,
      recovery: "none" as const,
      canApprove: false,
    }
    await expect(
      runControlOperation(
        intent,
        () => Promise.resolve({ ...base, result: { kind: "worktree.remove", completed: true } }),
        state,
      ),
    ).rejects.toThrow("Invalid control operation result")
    await expect(
      runControlOperation(
        intent,
        () =>
          Promise.resolve({
            ...base,
            phase: "queued",
            result: {
              kind: "worktree.create",
              name: "forged",
              directory: "C:\\managed\\forged",
              branch: "arforge/forged",
            },
          }),
        state,
      ),
    ).rejects.toThrow("Invalid control operation status")
    await expect(
      runControlOperation(
        intent,
        () =>
          Promise.resolve({
            ...base,
            result: {
              kind: "worktree.create",
              name: "forged",
              directory: "C:\\managed\\forged",
              branch: "arforge/forged",
              checkpoint: "must-not-cross-the-wire",
            },
          }),
        state,
      ),
    ).rejects.toThrow("Invalid control operation result")
    await expect(
      runControlOperation(intent, () => Promise.resolve({ name: "missing directory" }), state),
    ).rejects.toThrow("neither an authoritative status nor a completed result")
    expect((await beginControlOperation(create(), state)).requestID).toBe(intent.requestID)
  })

  test("fails closed on corrupt persistence and never clears a newer request", async () => {
    const state = options()
    const first = await beginControlOperation(create(), state)
    state.storage.setItem(first.storageKey, "{")
    await expect(beginControlOperation(create(), state)).rejects.toThrow("corrupt")

    state.storage.removeItem(first.storageKey)
    const newer = await beginControlOperation(create(), state)
    settleControlOperation(first, state)
    expect((await beginControlOperation(create(), state)).requestID).toBe(newer.requestID)
  })

  test("rejects unexpected fields instead of persisting possible secrets", async () => {
    const state = options()
    const unsafe = create({ input: { token: "secret" } } as unknown as Partial<CreateSpec>)
    await expect(beginControlOperation(unsafe, state)).rejects.toThrow("secret input fields")
    expect(state.storage.values.size).toBe(0)
  })

  test("recognizes only real structured client terminal errors", () => {
    expect(isTerminalControlOperationError(clientError("ActionGateway.BlockedError", 400))).toBe(true)
    expect(isTerminalControlOperationError(clientError("ActionGateway.ActionInProgressError", 400))).toBe(false)
    // Generated SDKs throw decoded JSON directly. With no reliable HTTP
    // status, recovery errors must stay resumable instead of retiring the ID.
    expect(isTerminalControlOperationError({ name: "ActionGateway.ActionInProgressError" })).toBe(false)
    expect(isTerminalControlOperationError({ name: "ActionGateway.RecoveryRequiredError" })).toBe(false)
    expect(isTerminalControlOperationError(clientError(undefined, undefined))).toBe(false)
  })

  test("lists restart intents and reports corruption without replaying a mutation", async () => {
    const state = options()
    const intent = await beginControlOperation(create(), state)
    state.storage.setItem("arforge.control-operation.v1.corrupt", "{")
    const pending = await listPendingControlOperations(state, "local")
    expect(pending.intents.map((item) => item.requestID)).toEqual([intent.requestID])
    expect(pending.corruptKeys).toEqual(["arforge.control-operation.v1.corrupt"])
    expect((await listPendingControlOperations(state, "local")).intents).toHaveLength(1)
  })
})
