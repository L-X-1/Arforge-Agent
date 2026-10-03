import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { RuntimeInsight, SubagentControl } from "@arforge-ai/core/runtime"
import { ControlClaimIndex } from "@arforge-ai/core/runtime"
import { SubagentProvider } from "@arforge-ai/core/runtime/subagent-provider"
import { ControlPrincipal } from "@arforge-ai/core/runtime/control-principal"
import { AccessDeniedError, CurrentCheck } from "@arforge-ai/core/runtime/subagent-control-access"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionInputTable, SessionTable } from "@arforge-ai/core/session/sql"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { testEffect } from "../lib/effect"

const interruptCalls: SessionSchema.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    exclusive: () => Effect.die(new Error("Exclusive execution is not part of this fixture")),
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    resumeWith: () => Effect.void,
    wake: () => Effect.void,
    wakeAndWait: () => Effect.void,
    interrupt: (sessionID) => Effect.sync(() => void interruptCalls.push(sessionID)),
  }),
)
const runtimeLayer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    EventV2.node,
    SessionProjector.node,
    SessionExecution.node,
    DurableRun.node,
    ControlClaimIndex.node,
    SubagentProvider.node,
    SubagentControl.node,
  ]),
  [[SessionExecution.node, execution]],
)
const it = testEffect(runtimeLayer)

const project = ProjectID.global
const location = AbsolutePath.make("/subagent-control-test")
const budget = AgentRuntime.Budget.make({
  maxAttempts: 4,
  maxDurationMs: 10_000,
  maxCostMicros: 100_000,
  maxTokens: 100_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})
const childBudget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 5_000,
  maxCostMicros: 10_000,
  maxTokens: 10_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const running = (runtime: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "control test preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "control test queued" })
    yield* runtime.transition({ runID, to: "running", reason: "control test running" })
  })

const fixture = Effect.gen(function* () {
  const runtime = yield* DurableRun.Service
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: project, worktree: location, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const parentSessionID = SessionSchema.ID.create()
  const childSessionID = SessionSchema.ID.create()
  for (const [id, title] of [
    [parentSessionID, "parent"],
    [childSessionID, "child"],
  ] as const) {
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: project,
        slug: `${title}-${String(id).slice(-8)}`,
        directory: String(location),
        title,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
  const parent = yield* runtime.create({
    sessionID: parentSessionID,
    initiator: "agent",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "control parent",
    budget,
    traceID: "control-parent",
    visibility: "details",
    project,
    location,
  })
  yield* running(runtime, parent.run.id)
  const child = yield* runtime.createChild({
    parentRunID: parent.run.id,
    sessionID: childSessionID,
    idempotencyKey: `control-child-${String(childSessionID)}`,
    delegatedObjective: "control child",
    allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
    project,
    location,
    expectedDeliverable: {
      summaryRequired: true,
      artifactKinds: [],
      evidenceKinds: [],
      verifier: "parent",
    },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "control child",
    budget: childBudget,
    traceID: "control-child",
    parentTraceID: "control-parent",
    visibility: "details",
  })
  yield* running(runtime, child.run.id)
  const leased = yield* runtime.acquireLease({ runID: parent.run.id, ownerID: "control-owner", ttlMs: 60_000 })
  if (!leased.lease) throw new Error("expected parent lease")
  return { parent, child, lease: leased.lease, parentSessionID, childSessionID }
})

const common = (fixture: {
  parent: DurableRun.SessionSnapshot
  child: DurableRun.ChildSnapshot
  lease: AgentRuntime.RunLease
}) => ({
  callerRunID: fixture.parent.run.id,
  parentRunID: fixture.parent.run.id,
  childRunID: fixture.child.run.id,
  leaseID: fixture.lease.id,
  ownerID: fixture.lease.ownerID,
})

describe("SubagentControl", () => {
  for (const active of [false, true])
    it.effect(`rolls back cancellation when the in-transaction check denies (active=${active})`, () =>
      Effect.gen(function* () {
        const runtime = yield* DurableRun.Service
        const { db } = yield* Database.Service
        const current = yield* fixture
        if (active) yield* runtime.beginAttempt({ runID: current.child.run.id })
        const before = yield* runtime.load(current.child.run.id)
        let checks = 0
        const check = Effect.gen(function* () {
          checks++
          if (checks < 3) return
          yield* db
            .update(SessionTable)
            .set({ title: "uncommitted-authorization-probe" })
            .where(eq(SessionTable.id, current.childSessionID))
            .run()
            .pipe(Effect.orDie)
          return yield* Effect.fail(new AccessDeniedError())
        })
        const result = yield* runtime
          .cancelChild({
            parentRunID: current.parent.run.id,
            childRunID: current.child.run.id,
            reason: "transaction authorization",
            recursive: false,
          })
          .pipe(Effect.provideService(CurrentCheck, check), Effect.exit)
        expect(String(result)).toContain("outside your authorized scope")
        expect(checks).toBe(3)
        expect(yield* runtime.load(current.child.run.id)).toEqual(before)
        const session = yield* db
          .select({ title: SessionTable.title })
          .from(SessionTable)
          .where(eq(SessionTable.id, current.childSessionID))
          .get()
          .pipe(Effect.orDie)
        expect(session?.title).toBe("child")
      }),
    )
  it.effect("stops the remaining cancellation tree when authority changes after one descendant", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const current = yield* fixture
      const descendants: DurableRun.ChildSnapshot[] = []
      for (const name of ["first", "second"]) {
        const child = yield* runtime.createChild({
          ...current.child.run,
          ...current.child.run.child,
          parentRunID: current.child.run.id,
          idempotencyKey: `revoke-tree-${name}-${current.child.run.id}`,
          budget: { ...childBudget, maxAttempts: 1, maxDurationMs: 1_000, maxCostMicros: 1_000, maxTokens: 1_000 },
        })
        yield* running(runtime, child.run.id)
        descendants.push((yield* runtime.load(child.run.id)) as DurableRun.ChildSnapshot)
      }
      const check = Effect.gen(function* () {
        const states = yield* Effect.all(descendants.map((child) => runtime.load(child.run.id)))
        if (states.some((child) => child.run.status === "cancelled")) return yield* Effect.fail(new AccessDeniedError())
      })
      const result = yield* runtime
        .cancelChild({
          parentRunID: current.parent.run.id,
          childRunID: current.child.run.id,
          reason: "tree revoke boundary",
        })
        .pipe(Effect.provideService(CurrentCheck, check), Effect.exit)
      expect(String(result)).toContain("outside your authorized scope")
      const after = yield* Effect.all(descendants.map((child) => runtime.load(child.run.id)))
      expect(after.filter((child) => child.run.status === "cancelled")).toHaveLength(1)
      expect(after.filter((child) => child.run.status === "running")).toHaveLength(1)
      for (let i = 0; i < after.length; i++)
        if (after[i]!.run.status === "running") expect(after[i]).toEqual(descendants[i])
      expect((yield* runtime.load(current.child.run.id)).run.status).toBe("running")
    }),
  )
  for (const revokeAt of ["provider", "local-interrupt"] as const) {
    it.effect(`stops durable cancellation after authority changes at ${revokeAt}`, () =>
      Effect.gen(function* () {
        const control = yield* SubagentControl.Service
        const provider = yield* SubagentProvider.Service
        const local = yield* SessionExecution.Service
        const runtime = yield* DurableRun.Service
        const current = yield* fixture
        const before = yield* runtime.load(current.child.run.id)
        let allowed = true
        let providerCalls = 0
        let localCalls = 0
        const check = Effect.suspend(() => (allowed ? Effect.void : Effect.fail(new AccessDeniedError())))
        const result = yield* control
          .cancel({ ...common(current), operation: "cancel", reason: "authority window" })
          .pipe(
            Effect.provideService(CurrentCheck, check),
            Effect.provideService(SubagentProvider.Service, {
              ...provider,
              cancel: () =>
                Effect.sync(() => {
                  providerCalls++
                  if (revokeAt === "provider") allowed = false
                  return { timedOut: false }
                }),
            }),
            Effect.provideService(SessionExecution.Service, {
              ...local,
              interrupt: () =>
                Effect.sync(() => {
                  localCalls++
                  allowed = false
                }),
            }),
            Effect.exit,
          )
        expect(String(result)).toContain("outside your authorized scope")
        expect(providerCalls).toBe(1)
        expect(localCalls).toBe(revokeAt === "provider" ? 0 : 1)
        expect(yield* runtime.load(current.child.run.id)).toEqual(before)
      }),
    )
  }
  it.effect("uses the native provider seam only after durable admission and keeps the inbox fallback", () =>
    Effect.gen(function* () {
      RuntimeInsight.reset()
      const runtime = yield* DurableRun.Service
      const control = yield* SubagentControl.Service
      const current = yield* fixture
      yield* runtime.beginAttempt({ runID: current.child.run.id })
      const gate = yield* Deferred.make<void>()
      const nativeCalls: Array<SubagentProvider.ParentMessageControlInput> = []
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
        execute: <A, E, R>(_input: SubagentProvider.ExecuteInput, operation: Effect.Effect<A, E, R>) =>
          Deferred.await(gate).pipe(Effect.andThen(operation)),
        control: (input) =>
          Effect.sync(() => {
            nativeCalls.push(input)
            return { status: "accepted" as const }
          }),
      }
      const provider = yield* SubagentProvider.make({ adapters: [adapter] })
      const providerFiber = Effect.runFork(
        provider.execute(
          {
            provider: "codex",
            executionID: current.child.run.id,
            epoch: 1,
            sessionID: current.child.run.sessionID,
            modelID: "model-control",
            modelProviderID: "provider-control",
            childRunID: current.child.run.id,
            parentRunID: current.parent.run.id,
          },
          Effect.succeed("provider-done"),
        ),
      )
      yield* Effect.sleep(0)

      const result = yield* control
        .steer({
          ...common(current),
          operation: "steer",
          requestID: "native-control-request",
          prompt: { text: "native provider must receive only this envelope identity" },
        })
        .pipe(Effect.provideService(SubagentProvider.Service, provider))
      expect(result.request?.messageID).toMatch(/^msg_parent_control_/)
      expect(nativeCalls).toHaveLength(1)
      expect(nativeCalls[0]).toMatchObject({
        operation: "steer",
        callerRunID: current.parent.run.id,
        childParentRunID: current.parent.run.id,
        childRunID: current.child.run.id,
        executionID: current.child.run.id,
        epoch: 1,
        requestID: "native-control-request",
        delivery: "steer",
      })
      expect(nativeCalls[0]).not.toHaveProperty("prompt")
      const { db } = yield* Database.Service
      const admitted = yield* SessionInput.find(db, result.request!.messageID)
      expect(admitted?.prompt.text).toContain("native provider")

      yield* Deferred.succeed(gate, undefined)
      expect(yield* Fiber.join(providerFiber)).toBe("provider-done")
    }),
  )

  it.effect("uses one deterministic SessionInput envelope for steer/followup replays", () =>
    Effect.gen(function* () {
      RuntimeInsight.reset()
      const control = yield* SubagentControl.Service
      const current = yield* fixture
      const base = common(current)
      const first = yield* control.steer({
        ...base,
        operation: "steer",
        requestID: "request-1",
        prompt: { text: "private instruction: inspect the lock" },
      })
      const replay = yield* control.steer({
        ...base,
        operation: "steer",
        requestID: "request-1",
        prompt: { text: "private instruction: inspect the lock" },
      })
      const followup = yield* control.followup({
        ...base,
        operation: "followup",
        requestID: "request-1",
        prompt: { text: "continue with the same evidence" },
      })
      const concurrent = yield* Effect.all(
        [
          control.followup({
            ...base,
            operation: "followup",
            requestID: "request-concurrent",
            prompt: { text: "one concurrent request" },
          }),
          control.followup({
            ...base,
            operation: "followup",
            requestID: "request-concurrent",
            prompt: { text: "one concurrent request" },
          }),
        ],
        { concurrency: 2 },
      )
      expect(first.request?.messageID).toBe(replay.request?.messageID)
      expect(first.request?.delivery).toBe("steer")
      expect(followup.request?.delivery).toBe("queue")
      expect(followup.request?.messageID).not.toBe(first.request?.messageID)
      expect(concurrent[0]?.request?.messageID).toBe(concurrent[1]?.request?.messageID)

      const { db } = yield* Database.Service
      const rows = yield* SessionInput.listPending(db, current.childSessionID, "steer")
      const queued = yield* SessionInput.listPending(db, current.childSessionID, "queue")
      expect(rows).toHaveLength(1)
      expect(queued).toHaveLength(2)
      expect(rows[0]?.prompt.text).toBe("private instruction: inspect the lock")
      expect(
        JSON.stringify(RuntimeInsight.auditList(100).entries.filter((entry) => entry.action.includes("admitted"))),
      ).not.toContain("private instruction: inspect the lock")

      const conflict = yield* control
        .steer({
          ...base,
          operation: "steer",
          requestID: "request-1",
          prompt: { text: "changed request must not replace the original" },
        })
        .pipe(Effect.exit)
      expect(String(conflict)).toContain("SubagentControl.RequestConflictError")
    }),
  )

  it.effect("requires the direct parent lease and refuses stale authority", () =>
    Effect.gen(function* () {
      const control = yield* SubagentControl.Service
      const current = yield* fixture
      const base = common(current)
      const forged = yield* control
        .steer({
          ...base,
          callerRunID: AgentRuntime.RunID.make("run_forged-parent"),
          operation: "steer",
          requestID: "forged",
          prompt: { text: "must be rejected" },
        })
        .pipe(Effect.exit)
      expect(String(forged)).toContain("SubagentControl.InvalidRequestError")

      yield* (yield* DurableRun.Service).releaseLease({
        runID: current.parent.run.id,
        leaseID: current.lease.id,
        ownerID: current.lease.ownerID,
        reason: "stale authority test",
      })
      const stale = yield* control
        .steer({
          ...base,
          operation: "steer",
          requestID: "stale",
          prompt: { text: "must not be admitted" },
        })
        .pipe(Effect.exit)
      expect(String(stale)).toContain("DurableRun.LeaseMismatchError")

      const { db } = yield* Database.Service
      const rows = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, current.childSessionID))
        .all()
      expect(rows).toHaveLength(0)
    }),
  )

  it.effect("seals a previously admitted input through the formal control claim path", () =>
    Effect.gen(function* () {
      const control = yield* SubagentControl.Service
      const runtime = yield* DurableRun.Service
      const current = yield* fixture
      const base = common(current)
      const requestID = "cpr_subagent_control_claim"
      const admitted = yield* control.steer({
        ...base,
        operation: "steer",
        requestID,
        prompt: { text: "claim only the already admitted instruction" },
      })
      if (!admitted.request) throw new Error("expected a deterministic control envelope")
      const principal = { tenantID: "ten_subagent_control_claim", userID: "usr_subagent_control_claim" }
      const subject = AgentRuntime.ControlPlaneSubject.make({
        type: "control-plane",
        id: ControlPrincipal.controlPlaneID(principal, {
          location: String(location),
          projectID: project,
          action: "subagent.control.steer",
        }),
        location,
        project,
        actor: "user",
        principalRef: ControlPrincipal.principalRef(principal),
        requestID: AgentRuntime.ControlPlaneRequestID.make(requestID),
      })
      const claim = yield* control
        .claim({
          operation: "steer",
          subject,
          parentRunID: current.parent.run.id,
          childRunID: current.child.run.id,
          sessionID: current.child.run.sessionID,
          requestID: AgentRuntime.ControlPlaneRequestID.make(requestID),
          messageID: admitted.request.messageID,
          promptDigest: admitted.request.promptDigest,
          delivery: admitted.request.delivery,
        })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      expect(claim.kind).toBe("claimed")
      const loaded = yield* runtime.load(claim.snapshot.run.id)
      if (!("subject" in loaded.run)) throw new Error("expected a control run")
      expect(loaded.run.operation.payload).not.toHaveProperty("prompt")
      expect(loaded.run.operation.payload).toHaveProperty("messageID", admitted.request.messageID)
      expect(loaded.run.operation.payload).toHaveProperty("promptDigest", admitted.request.promptDigest)

      const replay = yield* control
        .claim({
          operation: "steer",
          subject,
          parentRunID: current.parent.run.id,
          childRunID: current.child.run.id,
          sessionID: current.child.run.sessionID,
          requestID: AgentRuntime.ControlPlaneRequestID.make(requestID),
          messageID: admitted.request.messageID,
          promptDigest: admitted.request.promptDigest,
          delivery: admitted.request.delivery,
        })
        .pipe(Effect.provideService(ControlClaimIndex.CurrentPrincipal, principal))
      expect(replay.kind).toBe("existing")
      expect(replay.snapshot.run.id).toBe(claim.snapshot.run.id)
    }),
  )

  it.effect("keeps wait bounded and makes cancel durable only when provider outcome is known", () =>
    Effect.gen(function* () {
      interruptCalls.length = 0
      const control = yield* SubagentControl.Service
      const runtime = yield* DurableRun.Service
      const current = yield* fixture
      const base = common(current)
      const snapshot = yield* control.wait({ ...base, operation: "wait", timeoutMs: 0 })
      expect(snapshot.timedOut).toBe(true)
      expect(snapshot.durable.run.status).toBe("running")

      const cancelled = yield* control.cancel({
        ...base,
        operation: "cancel",
        reason: "user stopped child",
        timeoutMs: 0,
      })
      expect(cancelled.timedOut).toBe(false)
      expect(cancelled.durable.run.status).toBe("cancelled")
      expect(interruptCalls).toEqual([current.childSessionID])
      expect((yield* runtime.load(current.child.run.id)).run.status).toBe("cancelled")

      const closed = yield* control
        .followup({
          ...base,
          operation: "followup",
          requestID: "closed-child",
          prompt: { text: "must not enter a terminal child" },
        })
        .pipe(Effect.exit)
      expect(String(closed)).toContain("SubagentControl.ControlClosedError")

      const replay = yield* control.cancel({
        ...base,
        operation: "cancel",
        reason: "replayed stop",
        timeoutMs: 0,
      })
      expect(replay.durable.run.status).toBe("cancelled")
      expect((yield* control.wait({ ...base, operation: "wait", timeoutMs: 0 })).timedOut).toBe(false)
    }),
  )

  it.effect("leaves the durable child running when the provider reports outcome_unknown", () =>
    Effect.gen(function* () {
      const control = yield* SubagentControl.Service
      const provider = yield* SubagentProvider.Service
      const runtime = yield* DurableRun.Service
      const current = yield* fixture
      const gate = yield* Deferred.make<void>()
      const fiber = yield* provider
        .execute(
          {
            provider: "in-process",
            executionID: current.child.run.id,
            epoch: 1,
            sessionID: current.child.run.sessionID,
            modelID: "control-model",
            modelProviderID: "control-provider",
            childRunID: current.child.run.id,
            parentRunID: current.parent.run.id,
            attempt: 1,
          },
          Deferred.await(gate),
        )
        .pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const cancelled = yield* control.cancel({
        ...common(current),
        operation: "cancel",
        reason: "provider timeout",
        timeoutMs: 0,
      })
      expect(cancelled.timedOut).toBe(true)
      // A cooperative in-process adapter may publish `cancelled` in the tiny
      // signal/timeout race; the control contract still treats the bounded
      // timeout as unsafe and leaves the durable child unreconciled.
      expect(cancelled.provider?.phase === "cancelled" || cancelled.provider?.phase === "outcome_unknown").toBe(true)
      expect((yield* runtime.load(current.child.run.id)).run.status).toBe("running")
      yield* Fiber.join(fiber).pipe(Effect.exit)
    }),
  )
})
