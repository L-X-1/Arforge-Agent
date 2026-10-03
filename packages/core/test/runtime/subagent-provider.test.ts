import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber } from "effect"
import {
  advanceContinuationCheckpointState,
  advanceContinuationCursor,
  assertDirectParentControl,
  bindContinuationCheckpointState,
  bindContinuationToCheckpointState,
  EpochConflictError,
  InvalidInputError,
  makeContinuationCursor,
  ProviderDrainingError,
  ProviderDisposedError,
  ProviderLifecycleError,
  readContinuationCheckpointState,
  readContinuationFromCheckpointState,
  UnsupportedProviderError,
  SubagentProvider,
  validateContinuationCheckpointRevalidation,
  validateDirectParentControl,
} from "@arforge-ai/core/runtime/subagent-provider"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"

const input = (epoch: number, executionID = "child-run-1"): SubagentProvider.ExecuteInput => ({
  provider: "in-process",
  executionID,
  epoch,
  sessionID: "session-1",
  modelID: "model-1",
  modelProviderID: "provider-1",
  childRunID: executionID,
  parentRunID: "parent-run-1",
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("SubagentProvider", () => {
  test("runs shared phase invariants and fails before the provider operation on a rejected preflight", async () => {
    const registry = new RuntimeInvariants.RuntimeInvariantRegistry()
    const triggers: string[] = []
    for (const key of ["execution-input", "message-control", "lifecycle"] as const)
      registry.register({
        owner: "subagent-provider",
        key,
        version: "1",
        cost: "cheap",
        check: (context) =>
          Effect.sync(() => {
            triggers.push(`${key}:${String((context as { readonly kind?: unknown }).kind)}`)
          }),
      })
    const provider = await run(SubagentProvider.make({ invariants: registry }))
    await expect(run(provider.execute(input(1, "invariant-child"), Effect.succeed("done")))).resolves.toBe("done")
    expect(triggers).toContain("execution-input:input")
    expect(triggers.filter((trigger) => trigger === "lifecycle:entry").length).toBeGreaterThanOrEqual(3)
    expect(triggers.some((trigger) => trigger.startsWith("message-control:"))).toBe(false)

    const rejecting = new RuntimeInvariants.RuntimeInvariantRegistry()
    rejecting.register({
      owner: "subagent-provider",
      key: "execution-input",
      version: "1",
      cost: "cheap",
      check: () => Effect.fail(new Error("forced preflight rejection")),
    })
    const blockedProvider = await run(SubagentProvider.make({ invariants: rejecting }))
    let operationRan = false
    await expect(
      run(
        blockedProvider.execute(
          input(1, "invariant-blocked-child"),
          Effect.sync(() => {
            operationRan = true
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(operationRan).toBe(false)
    await expect(run(blockedProvider.inspect({ executionID: "invariant-blocked-child" }))).resolves.toBeUndefined()
  })

  test("executes one durable epoch and exposes a redacted terminal projection", async () => {
    const provider = await run(SubagentProvider.make())
    expect(provider.capabilities("in-process")).toMatchObject({
      provider: "in-process",
      available: true,
      supportsUsage: true,
      supportsEvents: true,
      supportsStopReason: true,
    })
    expect(provider.capabilities("codex")).toMatchObject({ provider: "codex", available: false })

    await expect(run(provider.execute(input(1), Effect.succeed("done")))).resolves.toBe("done")
    await expect(run(provider.inspect({ executionID: "child-run-1", provider: "in-process" }))).resolves.toMatchObject({
      provider: "in-process",
      executionID: "child-run-1",
      epoch: 1,
      phase: "completed",
      active: false,
      childRunID: "child-run-1",
      stopReason: "completed",
    })

    await expect(run(provider.execute(input(1), Effect.succeed("replay")))).rejects.toBeInstanceOf(EpochConflictError)
    await expect(run(provider.execute(input(2), Effect.succeed("continued")))).resolves.toBe("continued")
  })

  test("keeps continuation cursors payload-free and rejects sequence or epoch drift", async () => {
    const cursor = makeContinuationCursor({
      provider: "in-process",
      executionID: "cursor-child",
      epoch: 1,
      outputDigest: "a".repeat(64),
    })
    const advanced = advanceContinuationCursor(cursor, {
      provider: "in-process",
      executionID: "cursor-child",
      epoch: 1,
      sequence: 0,
      kind: "output",
      outputDigest: "b".repeat(64),
    })
    expect(advanced).toEqual({ ...cursor, nextSequence: 1, outputDigest: "b".repeat(64) })
    expect("text" in (advanced as unknown as Record<string, unknown>)).toBe(false)
    expect(() =>
      advanceContinuationCursor(advanced, {
        provider: "in-process",
        executionID: "cursor-child",
        epoch: 1,
        sequence: 0,
        kind: "output",
      }),
    ).toThrow(InvalidInputError)
    expect(() =>
      advanceContinuationCursor(
        { ...advanced, nextSequence: Number.MAX_SAFE_INTEGER },
        {
          provider: "in-process",
          executionID: "cursor-child",
          epoch: 1,
          sequence: Number.MAX_SAFE_INTEGER,
          kind: "output",
        },
      ),
    ).toThrow(InvalidInputError)
    expect(
      SubagentProvider.validateContinuationCursor(cursor, {
        provider: "in-process",
        executionID: "cursor-child",
        epoch: 2,
      }),
    ).toContain("epoch")
  })

  test("persists provider event progress monotonically and gates non-zero cold resumes", async () => {
    const cursor = makeContinuationCursor({
      provider: "in-process",
      executionID: "checkpoint-progress-child",
      epoch: 1,
      outputDigest: "a".repeat(64),
    })
    const binding = {
      attempt: 1,
      leaseID: "lease-progress",
      leaseOwnerID: "worker-progress",
      permissionDigest: "b".repeat(64),
    }
    const initial = bindContinuationCheckpointState({ resumeToken: "durable-token" }, cursor, binding)
    const event = {
      provider: "in-process" as const,
      executionID: "checkpoint-progress-child",
      epoch: 1,
      sequence: 0,
      kind: "output" as const,
      outputDigest: "c".repeat(64),
    }
    const advanced = advanceContinuationCursor(cursor, event)
    const progressed = advanceContinuationCheckpointState(initial, advanced, binding)
    expect(readContinuationCheckpointState(progressed, advanced).cursor).toEqual(advanced)
    expect(advanceContinuationCheckpointState(progressed, advanced, binding)).toBe(progressed)
    expect(() => advanceContinuationCheckpointState(initial, cursor, binding)).not.toThrow()
    expect(() => advanceContinuationCheckpointState(progressed, { ...advanced, nextSequence: 0 }, binding)).toThrow(
      InvalidInputError,
    )
    expect(() =>
      advanceContinuationCheckpointState(progressed, { ...advanced, outputDigest: "d".repeat(64) }, binding),
    ).toThrow(InvalidInputError)

    let operationRan = false
    const adapter: SubagentProvider.Adapter = {
      kind: "in-process",
      capabilities: {
        provider: "in-process",
        available: true,
        supportsColdResume: false,
        supportsEvents: true,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: false,
      },
      execute: <A, E, R>(
        _input: SubagentProvider.ExecuteInput,
        operation: Effect.Effect<A, E, R>,
        events?: SubagentProvider.ProviderEventSink,
      ) =>
        Effect.gen(function* () {
          if (events) yield* events.emit({ kind: "started" })
          operationRan = true
          return yield* operation
        }),
    }
    const provider = await run(SubagentProvider.make({ adapters: [adapter] }))
    const seedCursor = makeContinuationCursor({
      provider: "in-process",
      executionID: "seed-child",
      epoch: 1,
      outputDigest: "e".repeat(64),
    })
    await expect(
      run(provider.execute({ ...input(1, "seed-child"), continuation: seedCursor }, Effect.succeed("seeded"))),
    ).resolves.toBe("seeded")
    expect(operationRan).toBe(true)
    await expect(run(provider.inspect({ executionID: "seed-child" }))).resolves.toMatchObject({
      nextSequence: 1,
      continuation: { nextSequence: 1 },
    })

    let coldOperationRan = false
    const coldCursor = { ...advanced, executionID: "cold-gated-child", nextSequence: 1 }
    await expect(
      run(
        provider.execute(
          { ...input(1, "cold-gated-child"), continuation: coldCursor },
          Effect.sync(() => {
            coldOperationRan = true
            return "must-not-run"
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(coldOperationRan).toBe(false)
  })

  test("binds a payload-free cursor to the existing checkpoint and rejects rewrites", () => {
    const cursor = makeContinuationCursor({
      provider: "in-process",
      executionID: "checkpoint-child",
      epoch: 3,
      outputDigest: "d".repeat(64),
    })
    const initial = { phase: "subagent-provider", resumeToken: "durable-token" }
    const checkpoint = bindContinuationToCheckpointState(initial, cursor)

    expect(checkpoint).toMatchObject({ ...initial, subagentContinuation: cursor })
    expect(readContinuationFromCheckpointState(checkpoint, cursor)).toEqual(cursor)
    expect(initial).not.toHaveProperty("subagentContinuation")
    expect(() => bindContinuationToCheckpointState(checkpoint, { ...cursor, outputDigest: "e".repeat(64) })).toThrow(
      InvalidInputError,
    )
    expect(() =>
      readContinuationFromCheckpointState(
        { ...checkpoint, subagentContinuation: { ...cursor, unexpected: true } },
        cursor,
      ),
    ).toThrow(InvalidInputError)
    expect(() => readContinuationFromCheckpointState(checkpoint, { ...cursor, epoch: cursor.epoch + 1 })).toThrow(
      InvalidInputError,
    )
  })

  test("allows only the immutable direct parent to control a child", () => {
    const valid: SubagentProvider.DirectParentControlInput = {
      operation: "cancel",
      callerRunID: "parent-run",
      childParentRunID: "parent-run",
      childRunID: "child-run",
    }
    expect(validateDirectParentControl(valid)).toBeUndefined()
    expect(() => assertDirectParentControl(valid)).not.toThrow()
    for (const operation of ["steer", "followup"] as const) {
      // The provider guard accepts the identity tuple for message controls;
      // the durable SessionInput inbox remains responsible for carrying and
      // ordering the actual prompt payload.
      expect(validateDirectParentControl({ ...valid, operation })).toBeUndefined()
    }
    expect(validateDirectParentControl({ ...valid, callerRunID: "sibling-run" })).toContain("direct parent")
    expect(() => assertDirectParentControl({ ...valid, callerRunID: "child-run" })).toThrow(InvalidInputError)
    expect(
      validateDirectParentControl({ ...valid, operation: "unknown" as SubagentProvider.ParentControlOperation }),
    ).toContain("unsupported")
  })

  test("waits and cancels only through the direct-parent provider boundary", async () => {
    const provider = await run(SubagentProvider.make())
    const gate = await run(Deferred.make<void>())
    const fiber = Effect.runFork(
      provider.execute(input(1, "controlled-child"), Deferred.await(gate).pipe(Effect.as("must-cancel"))),
    )
    await run(Effect.sleep(2))

    const forbidden = await run(
      provider
        .cancel({
          operation: "cancel",
          executionID: "controlled-child",
          callerRunID: "sibling-run",
          childParentRunID: "parent-run-1",
          childRunID: "controlled-child",
          timeoutMs: 100,
        })
        .pipe(Effect.exit),
    )
    expect(Exit.isFailure(forbidden)).toBe(true)
    await expect(run(provider.inspect({ executionID: "controlled-child" }))).resolves.toMatchObject({ active: true })

    const cancelled = await run(
      provider.cancel({
        operation: "cancel",
        executionID: "controlled-child",
        callerRunID: "parent-run-1",
        childParentRunID: "parent-run-1",
        childRunID: "controlled-child",
        timeoutMs: 500,
      }),
    )
    expect(cancelled).toMatchObject({ timedOut: false, snapshot: { phase: "cancelled", active: false } })
    expect(cancelled.snapshot?.stopReason).toBe("cancelled")
    expect(Exit.isFailure(await run(Fiber.await(fiber)))).toBe(true)

    const gate2 = await run(Deferred.make<void>())
    const second = Effect.runFork(
      provider.execute(input(2, "waited-child"), Deferred.await(gate2).pipe(Effect.as("done"))),
    )
    await run(Effect.sleep(2))
    const timedOut = await run(
      provider.wait({
        operation: "wait",
        executionID: "waited-child",
        callerRunID: "parent-run-1",
        childParentRunID: "parent-run-1",
        childRunID: "waited-child",
        timeoutMs: 0,
      }),
    )
    expect(timedOut).toMatchObject({ timedOut: true, snapshot: { phase: "running", active: true } })
    await run(Deferred.succeed(gate2, undefined))
    const completed = await run(
      provider.wait({
        operation: "wait",
        executionID: "waited-child",
        callerRunID: "parent-run-1",
        childParentRunID: "parent-run-1",
        childRunID: "waited-child",
      }),
    )
    expect(completed).toMatchObject({ timedOut: false, snapshot: { phase: "completed", active: false } })
    expect(Exit.isSuccess(await run(Fiber.await(second)))).toBe(true)
  })

  test("dispatches metadata-only native steer/followup and replays accepted requests idempotently", async () => {
    const gate = await run(Deferred.make<void>())
    const calls: Array<SubagentProvider.ParentMessageControlInput> = []
    const adapter: SubagentProvider.Adapter = {
      kind: "codex",
      capabilities: {
        provider: "codex",
        available: true,
        supportsColdResume: false,
        supportsEvents: false,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: true,
        supportsFollowup: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
      control: (input) =>
        Effect.sync(() => {
          calls.push(input)
          return { status: "accepted" as const }
        }),
    }
    const provider = await run(SubagentProvider.make({ adapters: [adapter] }))
    const execution = Effect.runFork(
      provider.execute({ ...input(1, "native-control-child"), provider: "codex" }, Deferred.await(gate)),
    )
    await run(Effect.sleep(5))

    const base = {
      callerRunID: "parent-run-1",
      childParentRunID: "parent-run-1",
      childRunID: "native-control-child",
      executionID: "native-control-child",
      epoch: 1,
      requestID: "request-native-1",
      messageID: "msg-native-1",
      promptDigest: "a".repeat(64),
      envelopeDigest: "b".repeat(64),
    } as const
    const emptyProvider = await run(SubagentProvider.make({ adapters: [adapter] }))
    await expect(run(emptyProvider.control({ ...base, operation: "steer", delivery: "steer" }))).resolves.toEqual({
      executionID: "native-control-child",
      status: "unavailable",
    })
    await expect(run(provider.control({ ...base, operation: "steer", delivery: "steer" }))).resolves.toEqual({
      executionID: "native-control-child",
      provider: "codex",
      status: "accepted",
    })
    await expect(run(provider.control({ ...base, operation: "steer", delivery: "steer" }))).resolves.toEqual({
      executionID: "native-control-child",
      provider: "codex",
      status: "accepted",
    })
    expect(calls).toHaveLength(1)
    await expect(
      run(
        provider.control({
          ...base,
          operation: "steer",
          delivery: "steer",
          promptDigest: "c".repeat(64),
          envelopeDigest: "d".repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(
      run(
        provider.control({
          ...base,
          operation: "followup",
          delivery: "queue",
          requestID: "request-native-2",
          messageID: "msg-native-2",
        }),
      ),
    ).resolves.toEqual({ executionID: "native-control-child", provider: "codex", status: "accepted" })
    expect(calls).toEqual([
      { ...base, operation: "steer", delivery: "steer" },
      {
        ...base,
        operation: "followup",
        delivery: "queue",
        requestID: "request-native-2",
        messageID: "msg-native-2",
      },
    ])
    expect(calls[0]).not.toHaveProperty("prompt")
    await expect(
      run(provider.control({ ...base, operation: "steer", delivery: "steer", callerRunID: "sibling-run" })),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(run(provider.control({ ...base, operation: "steer", delivery: "queue" }))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    await expect(
      run(
        provider.control({
          ...base,
          operation: "steer",
          delivery: "steer",
          prompt: "raw prompt must be rejected",
        } as unknown as SubagentProvider.ParentMessageControlInput),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)

    await run(Deferred.succeed(gate, undefined))
    await expect(run(Fiber.join(execution))).resolves.toBeUndefined()
    await expect(run(provider.control({ ...base, operation: "steer", delivery: "steer" }))).resolves.toEqual({
      executionID: "native-control-child",
      provider: "codex",
      status: "accepted",
    })
  })

  test("revalidates attempt, lease, and permission facts before continuation dispatch", () => {
    const cursor = makeContinuationCursor({
      provider: "in-process",
      executionID: "revalidation-child",
      epoch: 2,
      outputDigest: "f".repeat(64),
    })
    const permissionDigest = "1".repeat(64)
    const state = bindContinuationCheckpointState({ resumeToken: "durable-token" }, cursor, {
      attempt: 2,
      leaseID: "lease-2",
      leaseOwnerID: "worker-2",
      permissionDigest,
    })
    const checkpoint = readContinuationCheckpointState(state, cursor)
    const valid = {
      expected: cursor,
      checkpoint,
      activeAttempt: 2,
      lease: {
        runID: cursor.executionID,
        leaseID: "lease-2",
        ownerID: "worker-2",
        expiresAtMs: 10_000,
      },
      expectedLeaseID: "lease-2",
      expectedLeaseOwnerID: "worker-2",
      expectedPermissionDigest: permissionDigest,
      currentPermissionDigest: permissionDigest,
      nowMs: 1_000,
    } satisfies Parameters<typeof validateContinuationCheckpointRevalidation>[0]
    expect(validateContinuationCheckpointRevalidation(valid)).toBeUndefined()
    expect(validateContinuationCheckpointRevalidation({ ...valid, activeAttempt: 1 })).toContain("active attempt")
    expect(validateContinuationCheckpointRevalidation({ ...valid, currentPermissionDigest: "2".repeat(64) })).toContain(
      "permission policy",
    )
    expect(
      validateContinuationCheckpointRevalidation({
        ...valid,
        lease: { ...valid.lease, expiresAtMs: 1_000 },
        nowMs: 1_000,
      }),
    ).toContain("lease expired")
    expect(() => readContinuationCheckpointState({ ...state, attempt: 1 }, cursor)).toThrow(InvalidInputError)
  })

  test("rejects an unsupported adapter without running the operation", async () => {
    const provider = await run(SubagentProvider.make())
    let executed = false
    const operation = Effect.sync(() => {
      executed = true
      return "should-not-run"
    })

    await expect(
      run(provider.execute({ ...input(1, "unsupported"), provider: "codex" }, operation)),
    ).rejects.toBeInstanceOf(UnsupportedProviderError)
    expect(executed).toBe(false)
  })

  test("accepts a provider adapter through the same lifecycle contract", async () => {
    const codex = {
      kind: "codex" as const,
      capabilities: {
        provider: "codex" as const,
        available: true,
        supportsColdResume: true,
        supportsEvents: true,
        supportsUsage: true,
        supportsStopReason: true,
        supportsSteer: true,
        supportsFollowup: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
      control: (_input: SubagentProvider.ParentMessageControlInput) => Effect.succeed({ status: "accepted" as const }),
    } satisfies SubagentProvider.Adapter
    const provider = await run(SubagentProvider.make({ adapters: [codex] }))
    const cursor = SubagentProvider.makeContinuationCursor({
      provider: "codex",
      executionID: "codex-child",
      epoch: 1,
      outputDigest: "c".repeat(64),
    })

    expect(provider.capabilities("codex")).toMatchObject({ available: true, supportsColdResume: true })
    await expect(
      run(
        provider.execute({ ...input(1, "codex-child"), provider: "codex", continuation: cursor }, Effect.succeed("ok")),
      ),
    ).resolves.toBe("ok")
    await expect(run(provider.inspect({ executionID: "codex-child", provider: "codex" }))).resolves.toMatchObject({
      provider: "codex",
      continuation: cursor,
    })

    const resumedCursor = { ...cursor, executionID: "codex-resumed-child", nextSequence: 4 }
    await expect(
      run(
        provider.execute(
          { ...input(1, "codex-resumed-child"), provider: "codex", continuation: resumedCursor },
          Effect.succeed("resumed"),
        ),
      ),
    ).resolves.toBe("resumed")
    await expect(
      run(provider.inspect({ executionID: "codex-resumed-child", provider: "codex" })),
    ).resolves.toMatchObject({
      epoch: 1,
      nextSequence: 4,
      continuation: resumedCursor,
    })
  })

  test("normalizes adapter events and aggregates usage without retaining payloads", async () => {
    let operationRan = false
    const adapter = {
      kind: "codex" as const,
      capabilities: {
        provider: "codex" as const,
        available: true,
        supportsColdResume: false,
        supportsEvents: true,
        supportsUsage: true,
        supportsStopReason: true,
        supportsSteer: false,
      },
      execute: <A, E, R>(
        _input: SubagentProvider.ExecuteInput,
        operation: Effect.Effect<A, E, R>,
        events?: SubagentProvider.ProviderEventSink,
      ) =>
        Effect.gen(function* () {
          if (events) {
            yield* events.emit({ kind: "started" })
            yield* events.emit({
              kind: "usage",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                reasoningTokens: 1,
                cacheReadTokens: 4,
                cacheWriteTokens: 5,
                costMicros: 7,
              },
            })
            yield* events.emit({
              kind: "usage",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                reasoningTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costMicros: 2,
              },
            })
            yield* events.emit({ kind: "output", outputDigest: "a".repeat(64) })
          }
          operationRan = true
          const result = yield* operation
          if (events) yield* events.emit({ kind: "completed", stopReason: "completed" })
          return result
        }),
    } satisfies SubagentProvider.Adapter
    const provider = await run(SubagentProvider.make({ adapters: [adapter] }))
    const observedCursors: Array<{ readonly sequence: number; readonly nextSequence: number | undefined }> = []

    await expect(
      run(
        provider.execute(
          {
            ...input(1, "events-child"),
            provider: "codex",
            continuation: makeContinuationCursor({
              provider: "codex",
              executionID: "events-child",
              epoch: 1,
              outputDigest: "0".repeat(64),
            }),
          },
          Effect.succeed("ok"),
          {
            onEvent: (event, continuation) =>
              Effect.sync(() =>
                observedCursors.push({ sequence: event.sequence, nextSequence: continuation?.nextSequence }),
              ),
          },
        ),
      ),
    ).resolves.toBe("ok")
    expect(operationRan).toBe(true)
    expect(observedCursors).toEqual([
      { sequence: 0, nextSequence: 1 },
      { sequence: 1, nextSequence: 2 },
      { sequence: 2, nextSequence: 3 },
      { sequence: 3, nextSequence: 4 },
      { sequence: 4, nextSequence: 5 },
    ])
    await expect(run(provider.inspect({ executionID: "events-child", provider: "codex" }))).resolves.toMatchObject({
      nextSequence: 5,
      continuation: { nextSequence: 5, outputDigest: "a".repeat(64) },
      stopReason: "completed",
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        reasoningTokens: 1,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        costMicros: 9,
      },
    })

    let rejectedOperationRan = false
    const invalidAdapter = {
      ...adapter,
      execute: <A, E, R>(
        _input: SubagentProvider.ExecuteInput,
        operation: Effect.Effect<A, E, R>,
        events?: SubagentProvider.ProviderEventSink,
      ) =>
        Effect.gen(function* () {
          if (events)
            yield* events.emit({
              kind: "output",
              outputDigest: "b".repeat(64),
              text: "secret",
            } as unknown as SubagentProvider.ProviderEventDraft)
          rejectedOperationRan = true
          return yield* operation
        }),
    } satisfies SubagentProvider.Adapter
    const invalidProvider = await run(SubagentProvider.make({ adapters: [invalidAdapter] }))
    await expect(
      run(invalidProvider.execute({ ...input(1, "invalid-events-child"), provider: "codex" }, Effect.succeed("nope"))),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(rejectedOperationRan).toBe(false)

    let observerFailureOperationRan = false
    const observerFailureProvider = await run(SubagentProvider.make({ adapters: [adapter] }))
    await expect(
      run(
        observerFailureProvider.execute(
          {
            ...input(1, "observer-failure-child"),
            provider: "codex",
            continuation: makeContinuationCursor({
              provider: "codex",
              executionID: "observer-failure-child",
              epoch: 1,
              outputDigest: "f".repeat(64),
            }),
          },
          Effect.sync(() => {
            observerFailureOperationRan = true
            return "must-not-run"
          }),
          { onEvent: () => Effect.fail("checkpoint unavailable") },
        ),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(observerFailureOperationRan).toBe(false)
    await expect(
      run(observerFailureProvider.inspect({ executionID: "observer-failure-child" })),
    ).resolves.toMatchObject({
      phase: "failed",
      active: false,
      nextSequence: 1,
      continuation: { nextSequence: 1 },
    })
  })

  test("serializes continuation epochs in FIFO order for one child identity", async () => {
    const provider = await run(SubagentProvider.make())
    const gate = await run(Deferred.make<void>())
    let secondStarted = false
    const first = Effect.runFork(
      provider.execute(input(1, "fifo-child"), Deferred.await(gate).pipe(Effect.as("first"))),
    )
    await run(Effect.sleep(2))
    const second = Effect.runFork(
      provider.execute(
        input(2, "fifo-child"),
        Effect.sync(() => {
          secondStarted = true
          return "second"
        }),
      ),
    )
    await run(Effect.sleep(2))

    expect(secondStarted).toBe(false)
    expect(await run(provider.inspect({ executionID: "fifo-child" }))).toMatchObject({ epoch: 1, active: true })
    await run(Deferred.succeed(gate, undefined))
    await expect(run(Fiber.join(first))).resolves.toBe("first")
    await expect(run(Fiber.join(second))).resolves.toBe("second")
    expect(secondStarted).toBe(true)
    await expect(run(provider.inspect({ executionID: "fifo-child" }))).resolves.toMatchObject({
      epoch: 2,
      phase: "completed",
      active: false,
    })
  })

  test("rejects duplicate adapter registrations before any child work", async () => {
    const duplicate = { ...SubagentProvider.InProcessAdapter }
    await expect(
      run(SubagentProvider.make({ adapters: [SubagentProvider.InProcessAdapter, duplicate] })),
    ).rejects.toBeInstanceOf(InvalidInputError)
  })

  test("rejects an adapter that advertises native control without a control hook", async () => {
    const invalidAdapter: SubagentProvider.Adapter = {
      kind: "codex",
      capabilities: {
        provider: "codex",
        available: true,
        supportsColdResume: false,
        supportsEvents: false,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
    }
    await expect(run(SubagentProvider.make({ adapters: [invalidAdapter] }))).rejects.toBeInstanceOf(InvalidInputError)
  })

  test("dispatches typed native cancel, drain, and dispose hooks exactly once", async () => {
    const cancelGate = await run(Deferred.make<void>())
    const drainGate = await run(Deferred.make<void>())
    const calls: Array<
      | { readonly operation: "cancel"; readonly input: SubagentProvider.ParentCancelInput }
      | { readonly operation: "drain"; readonly input: SubagentProvider.AdapterDrainInput }
      | { readonly operation: "dispose"; readonly input: SubagentProvider.AdapterDisposeInput }
    > = []
    const adapter: SubagentProvider.Adapter = {
      kind: "codex",
      capabilities: {
        provider: "codex",
        available: true,
        supportsColdResume: false,
        supportsEvents: false,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: false,
        supportsCancel: true,
        supportsDrain: true,
        supportsDispose: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
      cancel: (input) =>
        Effect.sync(() => {
          calls.push({ operation: "cancel", input })
          return { status: "accepted" as const }
        }),
      drain: (input) =>
        Effect.sync(() => {
          calls.push({ operation: "drain", input })
          return { status: "accepted" as const }
        }).pipe(Effect.tap(() => Deferred.succeed(drainGate, undefined))),
      dispose: (input) =>
        Effect.sync(() => {
          calls.push({ operation: "dispose", input })
          return { status: "accepted" as const }
        }),
    }
    const provider = await run(SubagentProvider.make({ adapters: [adapter] }))
    expect(provider.capabilities("codex")).toMatchObject({
      supportsCancel: true,
      supportsDrain: true,
      supportsDispose: true,
    })

    const cancelFiber = Effect.runFork(
      provider.execute({ ...input(1, "native-cancel-child"), provider: "codex" }, Deferred.await(cancelGate)),
    )
    await run(Effect.sleep(5))
    await expect(
      run(
        provider.cancel({
          operation: "cancel",
          executionID: "native-cancel-child",
          callerRunID: "parent-run-1",
          childParentRunID: "parent-run-1",
          childRunID: "native-cancel-child",
          timeoutMs: 100,
        }),
      ),
    ).resolves.toMatchObject({ timedOut: false, snapshot: { phase: "cancelled" } })
    expect(Exit.isFailure(await run(Fiber.await(cancelFiber)))).toBe(true)

    const drainFiber = Effect.runFork(
      provider.execute({ ...input(1, "native-drain-child"), provider: "codex" }, Deferred.await(drainGate)),
    )
    await run(Effect.sleep(5))
    await expect(
      run(provider.drain({ executionID: "native-drain-child", provider: "codex", epoch: 1, timeoutMs: 100 })),
    ).resolves.toMatchObject({ status: "drained", active: 0 })
    expect(Exit.isSuccess(await run(Fiber.await(drainFiber)))).toBe(true)

    await run(provider.dispose)
    await run(provider.dispose)
    expect(calls.map((call) => call.operation)).toEqual(["cancel", "drain", "dispose"])
    expect(calls[0]).toMatchObject({
      operation: "cancel",
      input: {
        operation: "cancel",
        executionID: "native-cancel-child",
        childRunID: "native-cancel-child",
      },
    })
    expect(calls[1]).toMatchObject({
      operation: "drain",
      input: {
        operation: "drain",
        provider: "codex",
        executionID: "native-drain-child",
        epoch: 1,
        timeoutMs: 100,
      },
    })
    expect(calls[2]).toEqual({ operation: "dispose", input: { operation: "dispose", provider: "codex" } })
    expect(calls[0].input).not.toHaveProperty("prompt")
    expect(calls[1].input).not.toHaveProperty("prompt")
  })

  test("fails closed when a native lifecycle hook fails and rejects asymmetric contracts", async () => {
    const gate = await run(Deferred.make<void>())
    const failingAdapter: SubagentProvider.Adapter = {
      kind: "codex",
      capabilities: {
        provider: "codex",
        available: true,
        supportsColdResume: false,
        supportsEvents: false,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: false,
        supportsCancel: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
      cancel: () => Effect.fail("native transport unavailable"),
    }
    const provider = await run(SubagentProvider.make({ adapters: [failingAdapter] }))
    const fiber = Effect.runFork(
      provider.execute({ ...input(1, "native-failure-child"), provider: "codex" }, Deferred.await(gate)),
    )
    await run(Effect.sleep(5))
    await expect(
      run(
        provider.cancel({
          operation: "cancel",
          executionID: "native-failure-child",
          callerRunID: "parent-run-1",
          childParentRunID: "parent-run-1",
          childRunID: "native-failure-child",
          timeoutMs: 100,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderLifecycleError)
    await expect(run(provider.inspect({ executionID: "native-failure-child", provider: "codex" }))).resolves.toMatchObject({
      phase: "outcome_unknown",
      active: false,
      stopReason: "unknown",
    })
    expect(Exit.isFailure(await run(Fiber.await(fiber)))).toBe(true)

    const missingHook: SubagentProvider.Adapter = {
      ...failingAdapter,
      cancel: undefined,
    }
    await expect(run(SubagentProvider.make({ adapters: [missingHook] }))).rejects.toBeInstanceOf(InvalidInputError)

    const hiddenHook: SubagentProvider.Adapter = {
      ...failingAdapter,
      capabilities: { ...failingAdapter.capabilities, supportsCancel: false },
    }
    await expect(run(SubagentProvider.make({ adapters: [hiddenHook] }))).rejects.toBeInstanceOf(InvalidInputError)
  })

  test("keeps native cancel, parent message control, stale epochs and provider scopes isolated", async () => {
    const operationGate = await run(Deferred.make<void>())
    const cancelGate = await run(Deferred.make<void>())
    const controlInputs: SubagentProvider.ParentMessageControlInput[] = []
    const lifecycleInputs: SubagentProvider.ParentCancelInput[] = []
    const codex: SubagentProvider.Adapter = {
      kind: "codex",
      capabilities: {
        provider: "codex",
        available: true,
        supportsColdResume: false,
        supportsEvents: false,
        supportsUsage: false,
        supportsStopReason: false,
        supportsSteer: true,
        supportsFollowup: true,
        supportsCancel: true,
      },
      execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) => operation,
      control: (input) =>
        Effect.sync(() => {
          controlInputs.push(input)
          return { status: "accepted" as const }
        }),
      cancel: (input) =>
        Effect.gen(function* () {
          lifecycleInputs.push(input)
          yield* Deferred.await(cancelGate)
          return { status: "accepted" as const }
        }),
    }
    const provider = await run(SubagentProvider.make({ adapters: [codex] }))
    const execution = Effect.runFork(
      provider.execute(
        { ...input(1, "isolated-control-child"), provider: "codex" },
        Deferred.await(operationGate).pipe(Effect.as("done")),
      ),
    )
    await run(Effect.sleep(5))

    expect(await run(provider.inspect({ executionID: "isolated-control-child", provider: "claude" }))).toBeUndefined()
    await expect(
      run(
        provider.cancel({
          operation: "cancel",
          executionID: "isolated-control-child",
          callerRunID: "sibling-run",
          childParentRunID: "parent-run-1",
          childRunID: "isolated-control-child",
          timeoutMs: 100,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(
      run(
        provider.control({
          operation: "steer",
          delivery: "steer",
          callerRunID: "parent-run-1",
          childParentRunID: "parent-run-1",
          childRunID: "isolated-control-child",
          executionID: "isolated-control-child",
          epoch: 2,
          requestID: "stale-request",
          messageID: "stale-message",
          promptDigest: "a".repeat(64),
          envelopeDigest: "b".repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)

    const cancelFiber = Effect.runFork(
      provider.cancel({
        operation: "cancel",
        executionID: "isolated-control-child",
        callerRunID: "parent-run-1",
        childParentRunID: "parent-run-1",
        childRunID: "isolated-control-child",
        timeoutMs: 1_000,
      }),
    )
    await run(Effect.sleep(5))
    const controlled = await run(
      provider.control({
        operation: "steer",
        delivery: "steer",
        callerRunID: "parent-run-1",
        childParentRunID: "parent-run-1",
        childRunID: "isolated-control-child",
        executionID: "isolated-control-child",
        epoch: 1,
        requestID: "live-request",
        messageID: "live-message",
        promptDigest: "c".repeat(64),
        envelopeDigest: "d".repeat(64),
      }),
    )
    expect(controlled).toMatchObject({ status: "accepted", provider: "codex" })
    expect(controlInputs).toHaveLength(1)
    expect(controlInputs[0]).not.toHaveProperty("prompt")
    expect(lifecycleInputs).toHaveLength(1)
    await run(Deferred.succeed(cancelGate, undefined))
    await expect(run(Fiber.join(cancelFiber))).resolves.toMatchObject({
      timedOut: false,
      snapshot: { phase: "cancelled", active: false },
    })
    expect(Exit.isFailure(await run(Fiber.await(execution)))).toBe(true)
  })

  test("marks a timed-out drain as outcome_unknown and blocks continuation", async () => {
    const provider = await run(SubagentProvider.make())
    const gate = await run(Deferred.make<void>())
    const fiber = Effect.runFork(provider.execute(input(1, "draining-child"), Deferred.await(gate)))
    await run(Effect.sleep(10))
    await expect(run(provider.inspect({ executionID: "draining-child" }))).resolves.toMatchObject({
      phase: "running",
      active: true,
    })

    await expect(
      run(provider.drain({ executionID: "draining-child", provider: "in-process", epoch: 1, timeoutMs: 0 })),
    ).resolves.toMatchObject({ status: "timed_out", active: 1 })
    await expect(run(provider.inspect({ executionID: "draining-child" }))).resolves.toMatchObject({
      phase: "outcome_unknown",
      active: false,
      stopReason: "unknown",
      reason: "provider drain deadline exceeded; child result is unknown and must be reconciled",
    })
    await expect(run(provider.execute(input(2, "draining-child"), Effect.succeed("retry")))).rejects.toBeInstanceOf(
      ProviderDrainingError,
    )

    expect(Exit.isFailure(await run(Fiber.await(fiber)))).toBe(true)
    await expect(run(provider.inspect({ executionID: "draining-child" }))).resolves.toMatchObject({
      phase: "outcome_unknown",
      active: false,
    })
  })

  test("disposal preserves unknown work and rejects new executions", async () => {
    const provider = await run(SubagentProvider.make())
    const gate = await run(Deferred.make<void>())
    const fiber = Effect.runFork(provider.execute(input(1, "disposed-child"), Deferred.await(gate)))
    await run(Effect.sleep(10))

    await run(provider.dispose)
    await expect(run(provider.inspect({ executionID: "disposed-child" }))).resolves.toMatchObject({
      phase: "outcome_unknown",
      active: false,
      stopReason: "unknown",
      reason: "provider runtime disposed before child result was observed",
    })
    await expect(run(provider.execute(input(2, "new-child"), Effect.succeed("nope")))).rejects.toBeInstanceOf(
      ProviderDisposedError,
    )

    expect(Exit.isFailure(await run(Fiber.await(fiber)))).toBe(true)
  })
})
