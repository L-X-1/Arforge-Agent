import { describe, expect, test } from "bun:test"
import * as ActionGateway from "@arforge-ai/core/action-gateway"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { createHash } from "node:crypto"
import { WorktreeSnapshot } from "@/control-operation/worktree-snapshot"
import { WorktreeControlWorker } from "@/control-operation/worktree-worker"
import { it as effectTest } from "../lib/effect"

const commit = (digit: string) => digit.repeat(40)
const scope: WorktreeSnapshot.Scope = {
  projectID: "project-worker",
  projectRoot: "C:\\repo",
  location: "C:\\repo",
  managedWorktreeRoot: "C:\\data\\worktrees\\project-worker",
  reservationRoot: "C:\\data\\reservations\\project-worker",
  managedWorktreeAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
  reservationAnchor: { path: "C:\\data", realPath: "C:\\data", device: "1", inode: "2" },
}
const target = "C:\\data\\worktrees\\project-worker\\task"
const reservation = `C:\\data\\reservations\\project-worker\\${createHash("sha256").update(target.toLowerCase()).digest("hex")}.json`

const subject = AgentRuntime.ControlPlaneSubject.make({
  type: "control-plane",
  id: AgentRuntime.ControlPlaneID.make("ctl_worktree-worker"),
  location: AbsolutePath.make(scope.location),
  project: ProjectID.make(scope.projectID),
  actor: "user",
  principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
  requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_worktree_worker_0001"),
})

const snapshot = WorktreeSnapshot.encode(
  {
    kind: "create",
    value: {
      info: { name: "task", branch: "arforge/task", directory: target },
      start: { project: "", extra: "" },
      requestID: subject.requestID,
      reservationPath: reservation,
      sourceCommit: commit("a"),
      roots: {
        managedWorktreeRoot: scope.managedWorktreeRoot,
        reservationRoot: scope.reservationRoot,
        managedWorktreeAnchor: scope.managedWorktreeAnchor,
        reservationAnchor: scope.reservationAnchor,
      },
    },
  },
  scope,
)

function controlRun(status: AgentRuntime.RunStatus, payload: unknown = snapshot) {
  const material = WorktreeSnapshot.actionMaterial(snapshot)
  const runID = AgentRuntime.RunID.make("run_control_worktree_worker")
  const actionID = ActionGateway.stableControlPlaneActionID({
    subject,
    name: material.name,
    resources: material.resources,
    inputDigest: material.inputDigest,
    policyVersion: ActionGateway.POLICY_VERSION,
  })
  const input: ActionGateway.Input = {
    kind: "control-plane",
    controlPlane: subject,
    runID,
    actionID,
    name: material.name,
    resources: material.resources,
    semantics: material.semantics,
    reasonSummary: material.reasonSummary,
    initiator: "user",
    traceID: "worker-test",
    inputDigest: material.inputDigest,
  }
  const authorization = WorktreeSnapshot.authorizationPlan(snapshot, actionID)
  return {
    id: runID,
    subject,
    operation: {
      version: 1,
      id: AgentRuntime.ControlOperationID.make("cop_worktree_worker"),
      kind: material.name,
      generation: 0,
      policyVersion: ActionGateway.POLICY_VERSION,
      claimDigest: "claim",
      authorizationDigest: ActionGateway.intentDigestOf(input, authorization),
      inputDigest: material.inputDigest,
      actionID,
      resources: material.resources,
      semantics: material.semantics,
      payload,
      payloadDigest: snapshot.digest,
    },
    status,
    initiator: "user",
    authority: "human",
    riskTier: "L3",
    reasonSummary: material.reasonSummary,
    budget: {
      maxAttempts: 2,
      maxDurationMs: 60_000,
      maxCostMicros: 0,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
    },
    traceID: "worker-test",
    visibility: "details",
    time: { created: new Date(0), updated: new Date(0) },
  } as unknown as AgentRuntime.ControlRun
}

function fixture(
  status: AgentRuntime.RunStatus,
  payload: unknown = snapshot,
  initialAttempt?: { readonly attempt: number; readonly startedAt: Date },
) {
  let run = controlRun(status, payload)
  let activeAttempt = initialAttempt
  const transitions: string[] = []
  const finishOutcomes: string[] = []
  let acquired = 0
  let released = 0
  let began = 0
  let finished = 0
  let heartbeats = 0
  let capability = {} as DurableRun.RunLeaseCapability
  const asSnapshot = () =>
    ({
      run,
      ...(activeAttempt ? { activeAttempt } : {}),
      lastSequence: transitions.length,
    }) as DurableRun.ControlSnapshot
  const durable = {
    load: () => Effect.succeed(asSnapshot()),
    acquireControlLease: () => {
      acquired += 1
      return Effect.succeed({ snapshot: asSnapshot(), capability })
    },
    heartbeatControl: () => {
      heartbeats += 1
      capability = {} as DurableRun.RunLeaseCapability
      return Effect.succeed({ snapshot: asSnapshot(), capability })
    },
    transitionControl: (_capability: DurableRun.RunLeaseCapability, input: { to: AgentRuntime.RunStatus }) => {
      transitions.push(input.to)
      run = { ...run, status: input.to }
      return Effect.succeed(asSnapshot())
    },
    beginControlAttempt: () => {
      began += 1
      activeAttempt = { attempt: 1, startedAt: new Date(0) }
      return Effect.succeed(asSnapshot())
    },
    finishControlAttempt: (
      _capability: DurableRun.RunLeaseCapability,
      input: { readonly outcome: "completed" | "failed" | "interrupted" },
    ) => {
      finished += 1
      finishOutcomes.push(input.outcome)
      activeAttempt = undefined
      return Effect.succeed(asSnapshot())
    },
    releaseControlLease: () => {
      released += 1
      return Effect.succeed(asSnapshot())
    },
  } as unknown as DurableRun.Interface
  return {
    run,
    durable,
    transitions,
    finishOutcomes,
    snapshot: asSnapshot,
    setStatus: (status: AgentRuntime.RunStatus) => {
      run = { ...run, status }
    },
    counts: () => ({ acquired, released, began, finished }),
    heartbeats: () => heartbeats,
  }
}

describe("WorktreeControlWorker", () => {
  test("executes only a verified sealed snapshot under both opaque capabilities", async () => {
    const state = fixture("draft")
    let executorCalls = 0
    let gatewayLease: DurableRun.RunLeaseCapability | undefined
    let gatewaySettled = false
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: {
        execute: (input, operation) => {
          gatewayLease = input.kind === "control-plane" ? input.runLease : undefined
          expect(input.runID).toBe(state.run.id)
          expect(gatewayLease).toBeDefined()
          return operation.execute({} as ActionGateway.AuthorizationGrantCapability).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                // ControlRun completion must be later than ActionGateway's
                // durable observation/settlement boundary.
                expect(state.snapshot().run.status).toBe("verifying")
                gatewaySettled = true
              }),
            ),
          )
        },
      } as ActionGateway.Interface,
      executor: {
        execute: (input) =>
          input.controlLeaseValidated().pipe(
            Effect.andThen(
              Effect.sync(() => {
                executorCalls += 1
                expect(input.snapshot).toEqual(snapshot)
                expect(input.runID).toBe(state.run.id)
                expect(input.actionID).toBe(state.run.operation.actionID)
                expect(input.controlLease).not.toBe(gatewayLease!)
                expect(Object.keys(input)).not.toContain("prepared")
              }),
            ),
          ),
      },
      ownerID: "worker-a",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    await Effect.runPromise(worker.execute(state.run.id))
    expect(executorCalls).toBe(1)
    expect(gatewaySettled).toBe(true)
    expect(state.transitions).toEqual([
      "preflight",
      "awaiting_authorization",
      "queued",
      "running",
      "verifying",
      "completed",
    ])
    expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 1, finished: 1 })
  })

  test("pauses a previously running operation rather than replaying its destructive executor", async () => {
    const state = fixture("running")
    let gatewayCalls = 0
    let executorCalls = 0
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: { execute: () => Effect.sync(() => gatewayCalls++) } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.sync(() => executorCalls++) },
      ownerID: "worker-b",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.transitions).toEqual(["recovering", "paused"])
    expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 0, finished: 0 })
    expect(gatewayCalls).toBe(0)
    expect(executorCalls).toBe(0)
  })

  test("closes an orphaned active attempt as interrupted before pausing", async () => {
    const state = fixture("running", snapshot, { attempt: 2, startedAt: new Date(Date.now() - 10) })
    let executorCalls = 0
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: { execute: () => Effect.void } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.sync(() => executorCalls++) },
      ownerID: "worker-interrupted",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.finishOutcomes).toEqual(["interrupted"])
    expect(state.transitions).toEqual(["recovering", "paused"])
    expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 0, finished: 1 })
    expect(executorCalls).toBe(0)
  })

  for (const status of ["recovering", "verifying"] as const) {
    test(`moves an orphaned ${status} run directly to paused without replay`, async () => {
      const state = fixture(status)
      let executorCalls = 0
      const worker = WorktreeControlWorker.make({
        durable: state.durable,
        gateway: { execute: () => Effect.void } as unknown as ActionGateway.Interface,
        executor: { execute: () => Effect.sync(() => executorCalls++) },
        ownerID: `worker-${status}`,
        leaseTtlMs: 60_000,
        scope: () => Effect.succeed(scope),
      })

      const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(state.transitions).toEqual(["paused"])
      expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 0, finished: 0 })
      expect(executorCalls).toBe(0)
    })
  }

  test("recovers a durable preflight by returning it to the authorization boundary", async () => {
    const state = fixture("preflight")
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: {
        execute: (_input: ActionGateway.Input, operation: ActionGateway.Operation<void, never, never>) =>
          operation.execute({} as ActionGateway.AuthorizationGrantCapability),
      } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.void },
      ownerID: "worker-preflight",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    await Effect.runPromise(worker.execute(state.run.id))
    expect(state.transitions).toEqual(["awaiting_authorization", "queued", "running", "verifying", "completed"])
    expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 1, finished: 1 })
  })

  test("fails before lease acquisition when persisted payload is not a sealed worktree snapshot", async () => {
    const state = fixture("draft", { snapshot: "tampered" })
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: { execute: () => Effect.void } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.void },
      ownerID: "worker-c",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.counts()).toEqual({ acquired: 0, released: 0, began: 0, finished: 0 })
  })

  test("rejects an execution deadline that can reach the durable lease expiry", async () => {
    const state = fixture("draft")
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: { execute: () => Effect.void } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.void },
      ownerID: "worker-invalid-window",
      executionDeadlineMs: 1_000,
      leaseTtlMs: 1_000,
      scope: () => Effect.succeed(scope),
    })

    const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
      expect(Cause.squash(exit.cause)).toBeInstanceOf(WorktreeControlWorker.InvalidExecutionWindowError)
    expect(state.counts()).toEqual({ acquired: 0, released: 0, began: 0, finished: 0 })
  })

  for (const variant of [
    {
      name: "blocked",
      error: () =>
        new ActionGateway.BlockedError({
          actionID: controlRun("draft").operation.actionID,
          reason: "denied",
        }),
      projected: "failed" as const,
    },
    {
      name: "recovery required",
      error: () =>
        new ActionGateway.RecoveryRequiredError({
          actionID: controlRun("draft").operation.actionID,
          reason: "uncertain",
        }),
      projected: "paused" as const,
    },
    {
      name: "action in progress",
      error: () =>
        new ActionGateway.ActionInProgressError({
          actionID: controlRun("draft").operation.actionID,
          ownerID: "other-worker",
          expiresAtMs: 10_000,
        }),
      projected: "paused" as const,
    },
    {
      name: "already settled without a ControlRun proof",
      error: () =>
        new ActionGateway.AlreadySettledError({
          actionID: controlRun("draft").operation.actionID,
          summary: "settled",
        }),
      projected: "paused" as const,
    },
  ]) {
    test(`projects typed ActionGateway ${variant.name} before returning`, async () => {
      const state = fixture("draft")
      let executorCalls = 0
      const expected = variant.error()
      const worker = WorktreeControlWorker.make({
        durable: state.durable,
        gateway: { execute: () => Effect.fail(expected) } as unknown as ActionGateway.Interface,
        executor: { execute: () => Effect.sync(() => executorCalls++) },
        ownerID: `worker-${variant.projected}`,
        leaseTtlMs: 60_000,
        scope: () => Effect.succeed(scope),
      })

      const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(expected)
      expect(state.snapshot().run.status).toBe(variant.projected)
      expect(state.transitions).toEqual(["preflight", "awaiting_authorization", variant.projected])
      expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 0, finished: 0 })
      expect(executorCalls).toBe(0)
    })
  }

  test("preserves an explicit durable cancellation when the gateway reports blocked", async () => {
    const state = fixture("draft")
    let executorCalls = 0
    const blocked = new ActionGateway.BlockedError({
      actionID: state.run.operation.actionID,
      reason: "cancelled",
    })
    const worker = WorktreeControlWorker.make({
      durable: state.durable,
      gateway: {
        execute: () => Effect.sync(() => state.setStatus("cancelled")).pipe(Effect.andThen(Effect.fail(blocked))),
      } as unknown as ActionGateway.Interface,
      executor: { execute: () => Effect.sync(() => executorCalls++) },
      ownerID: "worker-cancelled",
      leaseTtlMs: 60_000,
      scope: () => Effect.succeed(scope),
    })

    const exit = await Effect.runPromise(Effect.exit(worker.execute(state.run.id)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.snapshot().run.status).toBe("cancelled")
    expect(state.transitions).toEqual(["preflight", "awaiting_authorization"])
    expect(executorCalls).toBe(0)
  })

  effectTest.effect("interrupts a blocked executor at the hard deadline before its lease can expire", () =>
    Effect.gen(function* () {
      const state = fixture("draft")
      const entered = yield* Deferred.make<void>()
      const blocker = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let executorCalls = 0
      const worker = WorktreeControlWorker.make({
        durable: state.durable,
        gateway: {
          execute: (_input: ActionGateway.Input, operation: ActionGateway.Operation<void, never, never>) =>
            operation.execute({} as ActionGateway.AuthorizationGrantCapability),
        } as unknown as ActionGateway.Interface,
        executor: {
          execute: (input) =>
            input.controlLeaseValidated().pipe(
              Effect.andThen(
                Effect.sync(() => {
                  executorCalls += 1
                }),
              ),
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(blocker)),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
        },
        ownerID: "worker-deadline",
        executionDeadlineMs: 1_000,
        leaseTtlMs: 2_000,
        scope: () => Effect.succeed(scope),
      })

      const fiber = yield* worker.execute(state.run.id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("1 second")
      const exit = yield* Fiber.join(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toBeInstanceOf(WorktreeControlWorker.ExecutionDeadlineExceededError)
      yield* Deferred.await(interrupted)
      expect(executorCalls).toBe(1)
      expect(state.finishOutcomes).toEqual(["interrupted"])
      expect(state.snapshot().run.status).toBe("paused")
      expect(state.transitions).toEqual(["preflight", "awaiting_authorization", "queued", "running", "paused"])
      expect(state.counts()).toEqual({ acquired: 1, released: 1, began: 1, finished: 1 })

      // The structured timeout has already joined the interrupted executor.
      // Advancing past the old lease expiry cannot make it resume.
      yield* TestClock.adjust("1001 millis")
      expect(executorCalls).toBe(1)
    }),
  )

  effectTest.effect("heartbeats through slow uninterruptible cleanup so a second owner cannot acquire or execute", () =>
    Effect.gen(function* () {
      const state = fixture("draft")
      const base = state.durable
      let ownerID: string | undefined
      let expiresAtMs = 0
      let issued = {} as DurableRun.RunLeaseCapability
      let heartbeatAttempts = 0
      const durable = {
        ...base,
        acquireControlLease: (request: {
          readonly runID: AgentRuntime.RunID
          readonly ownerID: string
          readonly ttlMs: number
        }) =>
          Effect.gen(function* () {
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
            if (ownerID !== undefined && ownerID !== request.ownerID && nowMs < expiresAtMs)
              return yield* new DurableRun.LeaseHeldError({
                runID: request.runID,
                ownerID,
                expiresAtMs,
              })
            const acquired = yield* base.acquireControlLease(request)
            ownerID = request.ownerID
            expiresAtMs = nowMs + request.ttlMs
            issued = {} as DurableRun.RunLeaseCapability
            return { snapshot: acquired.snapshot, capability: issued }
          }),
        heartbeatControl: (
          capability: DurableRun.RunLeaseCapability,
          request: { readonly runID: AgentRuntime.RunID; readonly ttlMs: number },
        ) =>
          Effect.gen(function* () {
            heartbeatAttempts += 1
            const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
            // The first pulse is the body handoff. Fail the first background
            // pulse once, then prove retry recovers before the old TTL.
            if (heartbeatAttempts === 2)
              return yield* new DurableRun.CorruptHistoryError({
                runID: request.runID,
                sequence: 0,
                reason: "transient heartbeat failure",
              })
            if (capability !== issued || ownerID === undefined || nowMs >= expiresAtMs)
              return yield* new DurableRun.InvalidRunLeaseCapabilityError({
                runID: request.runID,
                reason: "expired or superseded test capability",
              })
            yield* base.heartbeatControl(capability, request)
            expiresAtMs = nowMs + request.ttlMs
            issued = {} as DurableRun.RunLeaseCapability
            return { snapshot: state.snapshot(), capability: issued }
          }),
        releaseControlLease: (
          capability: DurableRun.RunLeaseCapability,
          request: { readonly runID: AgentRuntime.RunID; readonly reason: string },
        ) =>
          Effect.gen(function* () {
            if (capability !== issued)
              return yield* new DurableRun.InvalidRunLeaseCapabilityError({
                runID: request.runID,
                reason: "release used a stale test capability",
              })
            ownerID = undefined
            expiresAtMs = 0
            return yield* base.releaseControlLease(capability, request)
          }),
      } as DurableRun.Interface

      const entered = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const allowCleanup = yield* Deferred.make<void>()
      const blocker = yield* Deferred.make<void>()
      let firstExecutions = 0
      let secondExecutions = 0
      const first = WorktreeControlWorker.make({
        durable,
        gateway: {
          execute: (_input: ActionGateway.Input, operation: ActionGateway.Operation<void, never, never>) =>
            operation.execute({} as ActionGateway.AuthorizationGrantCapability),
        } as unknown as ActionGateway.Interface,
        executor: {
          execute: (input) =>
            input.controlLeaseValidated().pipe(
              Effect.andThen(
                Effect.sync(() => {
                  firstExecutions += 1
                }),
              ),
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(blocker)),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Effect.uninterruptible(Deferred.await(allowCleanup))),
                ),
              ),
            ),
        },
        ownerID: "worker-slow-cleanup-a",
        executionDeadlineMs: 1_000,
        leaseTtlMs: 3_000,
        scope: () => Effect.succeed(scope),
      })
      const firstFiber = yield* first.execute(state.run.id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* TestClock.adjust("1 second")
      yield* Deferred.await(cleanupStarted)

      // Cross the original 3-second lease while the old executor is still
      // inside uninterruptible cleanup. Background retries keep rotating the
      // durable capability, including after one transient heartbeat failure.
      yield* TestClock.adjust("4 seconds")
      expect(firstFiber.pollUnsafe()).toBeUndefined()
      expect(heartbeatAttempts).toBeGreaterThan(2)

      const second = WorktreeControlWorker.make({
        durable,
        gateway: {
          execute: (_input: ActionGateway.Input, operation: ActionGateway.Operation<void, never, never>) =>
            operation.execute({} as ActionGateway.AuthorizationGrantCapability),
        } as unknown as ActionGateway.Interface,
        executor: {
          execute: () =>
            Effect.sync(() => {
              secondExecutions += 1
            }),
        },
        ownerID: "worker-slow-cleanup-b",
        executionDeadlineMs: 1_000,
        leaseTtlMs: 3_000,
        scope: () => Effect.succeed(scope),
      })
      const takeover = yield* second.execute(state.run.id).pipe(Effect.exit)
      expect(Exit.isFailure(takeover)).toBe(true)
      if (Exit.isFailure(takeover)) expect(Cause.squash(takeover.cause)).toBeInstanceOf(DurableRun.LeaseHeldError)
      expect(firstExecutions).toBe(1)
      expect(secondExecutions).toBe(0)

      yield* Deferred.succeed(allowCleanup, undefined)
      const firstExit = yield* Fiber.join(firstFiber)
      expect(Exit.isFailure(firstExit)).toBe(true)
      if (Exit.isFailure(firstExit))
        expect(Cause.squash(firstExit.cause)).toBeInstanceOf(WorktreeControlWorker.ExecutionDeadlineExceededError)
      expect(state.snapshot().run.status).toBe("paused")
      expect(ownerID).toBeUndefined()
      expect(secondExecutions).toBe(0)
    }),
  )
})
