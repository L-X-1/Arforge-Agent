import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { digest } from "@arforge-ai/core/runtime/insight"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { DateTime, Effect, Layer, Schema } from "effect"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { eq, sql } from "drizzle-orm"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]))
const it = testEffect(runtimeLayer)

const budget = AgentRuntime.Budget.make({
  maxAttempts: 3,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const create = (runtime: DurableRun.Interface, runBudget = budget) =>
  runtime.create({
    sessionID: SessionSchema.ID.create(),
    initiator: "user",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "test durable execution",
    budget: runBudget,
    traceID: "trace-test",
    visibility: "details",
  })

const moveToRunning = (runtime: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "attempt preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "attempt queued" })
    yield* runtime.transition({ runID, to: "running", reason: "attempt worker started" })
  })

const rootAdmission = AgentRuntime.SessionRunAdmission.make({
  version: 1,
  owner: "session-runner",
  credentialIDs: null,
  billing: null,
})

for (const status of ["completed", "failed", "cancelled"] as const)
  it.effect(`PersonalJob admission cannot recreate an occurrence after its original run is ${status}`, () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const legacy = yield* create(runtime)
      const admission = {
        ...rootAdmission,
        personalJob: {
          jobID: PersonalJob.ID.create(),
          occurrence: PersonalJob.Occurrence.make({
            version: 1,
            messageID: SessionMessage.ID.create(),
            digest: "a".repeat(64),
          }),
        },
      }
      const input = { ...legacy.run, id: AgentRuntime.RunID.create(), sessionID: SessionSchema.ID.create(), admission }
      const options = { exclusiveSession: true, initialLease: { ownerID: "job-admission", ttlMs: 1_000 } }
      const original = yield* runtime.create(input, options)
      yield* moveToRunning(runtime, original.run.id)
      yield* runtime.transition({ runID: original.run.id, to: status, reason: "original terminal fixture" })
      const before = yield* db.select().from(EventTable).all().pipe(Effect.orDie)
      const duplicate = yield* runtime.create({ ...input, id: AgentRuntime.RunID.create() }, options).pipe(Effect.exit)
      expect(duplicate._tag).toBe("Failure")
      expect(yield* db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual(before)
      expect(yield* runtime.list({ sessionID: input.sessionID })).toHaveLength(1)
      const next = yield* runtime.create(
        {
          ...input,
          id: AgentRuntime.RunID.create(),
          admission: {
            ...admission,
            personalJob: {
              ...admission.personalJob,
              occurrence: { ...admission.personalJob.occurrence, messageID: SessionMessage.ID.create() },
            },
          },
        },
        options,
      )
      expect(next.run.id).not.toBe(original.run.id)
    }),
  )

for (const phase of ["draft", "preflight", "queued", "awaiting_authorization"] as const) {
  it.effect(`root admission commits its lease atomically and recovers only an expired ${phase}`, () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const legacy = yield* create(runtime)
      const created = yield* runtime.create(
        {
          ...legacy.run,
          id: AgentRuntime.RunID.create(),
          sessionID: SessionSchema.ID.create(),
          admission: rootAdmission,
        },
        { exclusiveSession: true, initialLease: { ownerID: "original-admission", ttlMs: 1_000 } },
      )
      const runID = created.run.id
      expect(yield* runtime.load(runID)).toEqual(created)
      expect(created.lease?.generation).toBe(0)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, runID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      const receipt = Schema.decodeUnknownSync(AgentRuntime.Event.RunCreated.data)(rows[0].data)
      expect(receipt.initialLease).toMatchObject({ runID, ownerID: "original-admission", generation: 0 })
      expect(receipt.run.admission).toEqual(rootAdmission)
      if (phase !== "draft") yield* runtime.transition({ runID, to: "preflight", reason: "fixture preflight" })
      if (phase === "queued" || phase === "awaiting_authorization")
        yield* runtime.transition({ runID, to: phase, reason: "fixture admission" })
      expect(yield* runtime.recoverable(created.run.sessionID)).toEqual([])
      expect(yield* runtime.orphaned(created.run.sessionID)).toEqual([])
      yield* TestClock.adjust("1 second")
      const expected = phase === "awaiting_authorization" ? [] : [runID]
      expect((yield* runtime.recoverable(created.run.sessionID)).map((item) => item.run.id)).toEqual(expected)
      expect((yield* runtime.orphaned(created.run.sessionID)).map((item) => item.run.id)).toEqual(expected)
      expect(
        (yield* runtime.orphaned(created.run.sessionID, { includePendingChildren: true })).map((item) => item.run.id),
      ).toEqual(expected)
      expect(yield* runtime.recoverable(legacy.run.sessionID)).toEqual([])
      expect(yield* runtime.orphaned(legacy.run.sessionID)).toEqual([])
      const legacyData = Schema.encodeSync(AgentRuntime.Event.RunCreated.data)({
        runID: legacy.run.id,
        sessionID: legacy.run.sessionID,
        run: legacy.run,
      })
      expect(Object.hasOwn(legacyData, "initialLease")).toBe(false)
      expect(Object.hasOwn(legacyData.run, "admission")).toBe(false)
    }),
  )
}

it.effect("root admission rejects a missing initial lease without committing a new run", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const legacy = yield* create(runtime)
    const sessionID = SessionSchema.ID.create()
    const result = yield* runtime
      .create(
        { ...legacy.run, id: AgentRuntime.RunID.create(), sessionID, admission: rootAdmission },
        { exclusiveSession: true },
      )
      .pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* runtime.list({ sessionID })).toEqual([])
  }),
)

for (const mismatch of ["run", "generation", "time", "missing"] as const) {
  it.effect(`root admission rejects a corrupt initial lease: ${mismatch}`, () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const original = yield* create(runtime)
      const runID = AgentRuntime.RunID.create()
      const run = AgentRuntime.SessionRun.make({ ...original.run, id: runID, admission: rootAdmission })
      const now = run.time.created
      const initialLease =
        mismatch === "missing"
          ? undefined
          : AgentRuntime.RunLease.make({
              id: AgentRuntime.LeaseID.create(),
              runID: mismatch === "run" ? original.run.id : runID,
              ownerID: "corrupt-fixture",
              generation: mismatch === "generation" ? 1 : 0,
              acquiredAt: now,
              heartbeatAt: now,
              expiresAt: mismatch === "time" ? now : DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 1_000),
            })
      yield* events.publish(AgentRuntime.Event.RunCreated, { runID, sessionID: run.sessionID, run, initialLease })
      const result = yield* runtime.load(runID).pipe(Effect.flip)
      expect(result).toBeInstanceOf(DurableRun.CorruptHistoryError)
      if (!(result instanceof DurableRun.CorruptHistoryError)) throw new Error("Expected corrupt history")
      expect(result.reason).toContain("initial lease")
      expect(result.message).toContain("cannot be recovered automatically")
    }),
  )
}

it.effect("root admission cannot start an attempt after its lease was replaced", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const created = yield* create(runtime)
    const runID = created.run.id
    yield* moveToRunning(runtime, runID)
    const old = yield* runtime.acquireLease({ runID, ownerID: "old-admission", ttlMs: 1_000 })
    if (!old.lease) throw new Error("Expected admission lease")
    const execution = { leaseID: old.lease.id, ownerID: old.lease.ownerID, attempt: 0 }
    yield* TestClock.adjust("1 second")
    const expired = yield* runtime.beginAttempt({ runID, execution }).pipe(Effect.flip)
    expect(expired).toBeInstanceOf(DurableRun.InvalidRunLeaseCapabilityError)
    const replacement = yield* runtime.acquireLease({ runID, ownerID: "new-admission", ttlMs: 1_000 })
    const rejected = yield* runtime.beginAttempt({ runID, execution }).pipe(Effect.flip)
    expect(rejected).toBeInstanceOf(DurableRun.InvalidRunLeaseCapabilityError)
    expect(yield* runtime.load(runID)).toEqual(replacement)
    if (!replacement.lease) throw new Error("Expected replacement lease")
    const started = yield* runtime.beginAttempt({
      runID,
      execution: { ...execution, leaseID: replacement.lease.id, ownerID: replacement.lease.ownerID },
    })
    expect(started.activeAttempt?.attempt).toBe(1)
  }),
)

it.effect("lease conflict explains why a competing execution cannot resume", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const first = yield* create(runtime)
    yield* runtime.acquireLease({ runID: first.run.id, ownerID: "first-owner", ttlMs: 30_000 })
    const outcome = yield* runtime
      .acquireLease({ runID: first.run.id, ownerID: "second-owner", ttlMs: 30_000 })
      .pipe(Effect.flip)
    expect(outcome).toBeInstanceOf(DurableRun.LeaseHeldError)
    expect(outcome.message).toContain("Another execution currently owns this run")
    expect(outcome.message).toContain("before resuming")
  }),
)

for (const status of [
  "draft",
  "preflight",
  "awaiting_authorization",
  "queued",
  "running",
  "paused",
  "recovering",
  "completed",
  "failed",
  "cancelled",
] as const) {
  it.effect(`exclusive Session admission respects the original ${status} run`, () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const first = yield* create(runtime)
      const runID = first.run.id
      if (status !== "draft") yield* runtime.transition({ runID, to: "preflight", reason: "fixture preflight" })
      if (status === "awaiting_authorization")
        yield* runtime.transition({ runID, to: status, reason: "fixture approval" })
      if (!["draft", "preflight", "awaiting_authorization"].includes(status)) {
        yield* runtime.transition({ runID, to: "queued", reason: "fixture queue" })
        if (status !== "queued") yield* runtime.transition({ runID, to: "running", reason: "fixture running" })
        if (!["queued", "running"].includes(status))
          yield* runtime.transition({ runID, to: status, reason: "fixture boundary" })
      }
      const before = yield* runtime.load(runID)
      const candidate = AgentRuntime.RunID.create()
      const result = yield* runtime
        .create({ ...first.run, id: candidate }, { exclusiveSession: true })
        .pipe(Effect.exit)
      const terminal = ["completed", "failed", "cancelled"].includes(status)
      expect(result._tag).toBe(terminal ? "Success" : "Failure")
      expect(yield* runtime.load(runID)).toEqual(before)
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, candidate)).all().pipe(Effect.orDie),
      ).toHaveLength(terminal ? 1 : 0)
      expect(
        yield* db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, candidate))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(terminal ? 1 : 0)
      expect(yield* runtime.list({ sessionID: first.run.sessionID })).toHaveLength(terminal ? 2 : 1)
    }),
  )
}

it.effect("exclusive Session admission serializes competing new run IDs in the original event transaction", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const sessionID = SessionSchema.ID.create()
    const candidates = Array.from({ length: 6 }, () => AgentRuntime.RunID.create())
    const results = yield* Effect.all(
      candidates.map((id) =>
        runtime
          .create(
            {
              id,
              sessionID,
              initiator: "user",
              authority: "automatic",
              riskTier: "L0",
              reasonSummary: "concurrent root admission",
              budget,
              traceID: "trace-concurrent-admission",
              visibility: "details",
            },
            { exclusiveSession: true },
          )
          .pipe(Effect.exit),
      ),
      { concurrency: "unbounded" },
    )
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
    expect(results.filter((result) => result._tag === "Failure")).toHaveLength(5)
    const saved = yield* runtime.list({ sessionID })
    expect(saved).toHaveLength(1)
    expect(saved[0].run.status).toBe("draft")
    expect(saved[0].run.budget.attemptsUsed).toBe(0)
  }),
)

it.effect("lease validation locks its aggregate on the caller transaction and rolls back with it", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const database = yield* Database.Service
    const { db } = database
    const created = yield* create(runtime)
    const leased = yield* runtime.acquireLease({ runID: created.run.id, ownerID: "transaction-owner", ttlMs: 60_000 })
    if (!leased.lease) throw new Error("Expected fixture lease")
    const binding = { runID: created.run.id, leaseID: leased.lease.id, ownerID: leased.lease.ownerID }
    const before = yield* runtime.load(created.run.id)
    yield* db.run(sql`CREATE TEMP TABLE lease_transaction_probe (value INTEGER NOT NULL)`).pipe(Effect.orDie)
    yield* Effect.addFinalizer(() =>
      db
        .run(sql`DROP TRIGGER IF EXISTS lease_transaction_probe_trigger`)
        .pipe(Effect.andThen(db.run(sql`DROP TABLE IF EXISTS lease_transaction_probe`)), Effect.orDie),
    )
    yield* db
      .run(
        sql`CREATE TEMP TRIGGER lease_transaction_probe_trigger AFTER UPDATE ON event_sequence
      WHEN NEW.seq = OLD.seq
      BEGIN INSERT INTO lease_transaction_probe(value) VALUES (1); END`,
      )
      .pipe(Effect.orDie)
    yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
      runtime.validateLease({ ...binding, transaction }),
    )
    expect(yield* db.all(sql`SELECT value FROM lease_transaction_probe`).pipe(Effect.orDie)).toEqual([{ value: 1 }])
    for (const mode of ["stale-owner", "caller-failure"]) {
      const exit = yield* database
        .transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
          Effect.gen(function* () {
            yield* runtime.validateLease({
              ...binding,
              ownerID: mode === "stale-owner" ? "foreign" : binding.ownerID,
              transaction,
            })
            yield* transaction.run(sql`INSERT INTO lease_transaction_probe(value) VALUES (2)`).pipe(Effect.orDie)
            return yield* Effect.fail("fixture caller failed after lease validation")
          }),
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* db.all(sql`SELECT value FROM lease_transaction_probe`).pipe(Effect.orDie)).toEqual([{ value: 1 }])
      expect(yield* runtime.load(created.run.id)).toEqual(before)
    }
  }),
)

it.effect("checkpoint updates recompute against the latest durable state under contention", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const created = yield* create(runtime)
    const runID = created.run.id
    yield* runtime.checkpoint({ runID, state: { count: 0, taskRecovery: { notification: "retained" } } })
    yield* Effect.all(
      ["provider", "sessionLoop", "admission"].map((key) =>
        runtime.checkpoint({
          runID,
          state: (current) => ({ ...current, count: Number(current?.count ?? 0) + 1, [key]: { saved: true } }),
        }),
      ),
      { concurrency: "unbounded" },
    )
    const loaded = yield* runtime.load(runID)
    expect(loaded.checkpoint?.state).toEqual({
      count: 3,
      taskRecovery: { notification: "retained" },
      provider: { saved: true },
      sessionLoop: { saved: true },
      admission: { saved: true },
    })
    expect(loaded.checkpoint?.stateDigest).toBe(digest(loaded.checkpoint!.state))
  }),
)

it.effect("checkpoint rejects stale execution before evaluating its updater", () =>
  Effect.gen(function* () {
    const runtime = yield* DurableRun.Service
    const created = yield* create(runtime)
    const runID = created.run.id
    const lease = yield* runtime.acquireLease({ runID, ownerID: "checkpoint-owner", ttlMs: 1_000 })
    yield* moveToRunning(runtime, runID)
    yield* runtime.beginAttempt({ runID })
    if (!lease.lease) return yield* Effect.die("fixture lease missing")
    const execution = { leaseID: lease.lease.id, ownerID: lease.lease.ownerID, attempt: 1 }
    yield* runtime.checkpoint({ runID, execution, state: { valid: true } })
    const before = yield* runtime.load(runID)
    let evaluated = 0
    for (const invalid of [
      { ...execution, attempt: 2 },
      { ...execution, ownerID: "other-owner" },
    ]) {
      const exit = yield* runtime
        .checkpoint({
          runID,
          execution: invalid,
          state: () => {
            evaluated++
            return { forged: true }
          },
        })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }
    yield* TestClock.adjust("1 second")
    expect(
      (yield* runtime
        .checkpoint({
          runID,
          execution,
          state: () => {
            evaluated++
            return { expired: true }
          },
        })
        .pipe(Effect.exit))._tag,
    ).toBe("Failure")
    expect(evaluated).toBe(0)
    expect(yield* runtime.load(runID)).toEqual(before)
    const replacement = yield* runtime.acquireLease({ runID, ownerID: "replacement-owner", ttlMs: 1_000 })
    expect((yield* runtime.checkpoint({ runID, execution, state: { stale: true } }).pipe(Effect.exit))._tag).toBe(
      "Failure",
    )
    expect(yield* runtime.load(runID)).toEqual(replacement)
    if (!replacement.lease) return yield* Effect.die("replacement lease missing")
    yield* runtime.checkpoint({
      runID,
      state: { replacement: true },
      execution: {
        leaseID: replacement.lease.id,
        ownerID: replacement.lease.ownerID,
        attempt: 1,
      },
    })
    expect((yield* runtime.load(runID)).checkpoint?.state).toEqual({ replacement: true })
  }),
)

const controlInput = (suffix = "test"): DurableRun.ControlCreateInput => {
  const payload = { commit: `abc123-${suffix}`, target: "sandbox" }
  const payloadDigest = canonicalHash(payload)
  if (!payloadDigest) throw new Error("control test payload must be canonical")
  const subject = AgentRuntime.ControlPlaneSubject.make({
    type: "control-plane",
    id: AgentRuntime.ControlPlaneID.make(`ctl_control-${suffix}`),
    location: AbsolutePath.make(`/control-${suffix}`),
    project: ProjectID.global,
    actor: "user",
    principalRef: AgentRuntime.ControlPrincipalRef.make("prn_test"),
    requestID: AgentRuntime.ControlPlaneRequestID.make(`cpr_control-${suffix}`),
  })
  const generation = 0
  const claimDigest = `claim-control-${suffix}`
  const operationID = DurableRun.controlOperationID({ subject, claimDigest, generation })
  if (!operationID) throw new Error("control test operation ID must be canonical")
  return {
    subject,
    operation: AgentRuntime.ControlOperationSnapshot.make({
      version: 1,
      id: operationID,
      kind: "worktree.create",
      generation,
      policyVersion: "arforge-risk/1",
      claimDigest,
      authorizationDigest: `authorization-control-${suffix}`,
      inputDigest: `input-control-${suffix}`,
      actionID: AgentRuntime.ActionID.make(`act_control-${suffix}`),
      resources: [`filesystem:/control-${suffix}`, "git"],
      semantics: AgentRuntime.EffectSemantics.make({
        riskTier: "L3",
        authority: "human",
        idempotency: "idempotent",
        retryability: "safe",
        reversibility: "irreversible",
        filesystemScope: [`/control-${suffix}`],
        networkScope: [],
        secretScope: [],
        externalServices: ["git"],
        expectedArtifacts: [],
        successCriteria: ["worktree exists"],
      }),
      payload,
      payloadDigest,
    }),
    initiator: "user",
    authority: "human",
    riskTier: "L3",
    reasonSummary: "create an approved worktree",
    budget,
    traceID: `control-${suffix}`,
    visibility: "details",
  }
}

describe("DurableRun", () => {
  it.effect("reconstructs run state and the latest semantic checkpoint from durable events", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* runtime.transition({ runID: created.run.id, to: "preflight", reason: "scope inspected" })
      yield* runtime.transition({ runID: created.run.id, to: "queued", reason: "no up-front approval required" })
      yield* runtime.transition({ runID: created.run.id, to: "running", reason: "worker acquired run" })
      const state = { turn: 2, promotion: "steer", pendingActionIDs: ["act_example"] }
      const checkpoint = yield* runtime.checkpoint({ runID: created.run.id, state })

      const loaded = yield* runtime.load(created.run.id)

      expect(loaded.run.status).toBe("running")
      expect(loaded.run.time.started).toBeDefined()
      expect(loaded.checkpoint?.id).toBe(checkpoint.id)
      expect(loaded.checkpoint?.state).toEqual(state)
      expect(loaded.checkpoint?.stateDigest).toBe(digest(state))
      expect(checkpoint.eventSequence).toBe(4)
      expect(loaded.checkpoint?.eventSequence).toBe(4)
      expect(loaded.lastSequence).toBe(4)
    }),
  )

  it.effect("rejects state-machine shortcuts without appending a false transition", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)

      const exit = yield* runtime
        .transition({ runID: created.run.id, to: "completed", reason: "invalid shortcut" })
        .pipe(Effect.exit)
      const loaded = yield* runtime.load(created.run.id)

      expect(String(exit)).toContain("DurableRun.InvalidTransitionError")
      expect(loaded.run.status).toBe("draft")
      expect(loaded.lastSequence).toBe(0)
    }),
  )

  it.effect("allows an explicitly failed run to enter recovery", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* runtime.transition({ runID: created.run.id, to: "preflight", reason: "scope inspected" })
      yield* runtime.transition({ runID: created.run.id, to: "queued", reason: "ready" })
      yield* runtime.transition({ runID: created.run.id, to: "running", reason: "started" })
      yield* runtime.transition({ runID: created.run.id, to: "failed", reason: "process terminated" })

      const recovering = yield* runtime.transition({
        runID: created.run.id,
        to: "recovering",
        reason: "latest checkpoint is available",
      })

      expect(recovering.run.status).toBe("recovering")
      expect(recovering.run.time.finished).toBeDefined()
    }),
  )

  it.effect("lists only resumable runs for the requested session", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const active = yield* create(runtime)
      yield* runtime.transition({ runID: active.run.id, to: "preflight", reason: "scope inspected" })
      yield* runtime.transition({ runID: active.run.id, to: "queued", reason: "ready" })
      yield* runtime.transition({ runID: active.run.id, to: "running", reason: "started" })
      const terminal = yield* create(runtime)
      yield* runtime.transition({ runID: terminal.run.id, to: "cancelled", reason: "user cancelled" })

      const recoverable = yield* runtime.recoverable(active.run.sessionID)

      expect(recoverable.map((item) => item.run.id)).toEqual([active.run.id])
    }),
  )

  it.effect("records each execution attempt and closes the configured retry budget", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* moveToRunning(runtime, created.run.id)

      for (let attempt = 1; attempt <= 3; attempt++) {
        expect((yield* runtime.beginAttempt({ runID: created.run.id })).run.budget.attemptsUsed).toBe(attempt)
        yield* runtime.finishAttempt({
          runID: created.run.id,
          attempt,
          outcome: "interrupted",
          durationMs: 0,
          costMicros: 0,
          tokens: 0,
        })
      }
      const exhausted = yield* runtime.beginAttempt({ runID: created.run.id }).pipe(Effect.exit)
      const loaded = yield* runtime.load(created.run.id)

      expect(String(exhausted)).toContain("DurableRun.BudgetExhaustedError")
      expect(loaded.run.budget.attemptsUsed).toBe(3)
      expect(loaded.lastSequence).toBe(9)
    }),
  )

  it.effect("rejects a duplicate start while an attempt is still active", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* moveToRunning(runtime, created.run.id)
      yield* runtime.beginAttempt({ runID: created.run.id })

      const duplicate = yield* runtime.beginAttempt({ runID: created.run.id }).pipe(Effect.exit)
      const loaded = yield* runtime.load(created.run.id)

      expect(String(duplicate)).toContain("DurableRun.AttemptInProgressError")
      expect(loaded.activeAttempt?.attempt).toBe(1)
      expect(loaded.lastSequence).toBe(4)
    }),
  )

  it.effect("persists attempt completion, measured duration, cost, and active-attempt state", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* moveToRunning(runtime, created.run.id)
      const started = yield* runtime.beginAttempt({
        runID: created.run.id,
        usageBaseline: { costMicros: 700, tokens: 900 },
      })

      expect(started.activeAttempt?.attempt).toBe(1)
      expect(started.activeAttempt?.usageBaseline).toEqual({ costMicros: 700, tokens: 900 })
      expect((yield* runtime.load(created.run.id)).activeAttempt?.usageBaseline).toEqual({
        costMicros: 700,
        tokens: 900,
      })
      const finished = yield* runtime.finishAttempt({
        runID: created.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: 125,
        costMicros: 42,
        tokens: 123,
      })

      expect(finished.activeAttempt).toBeUndefined()
      expect(finished.run.budget).toMatchObject({
        attemptsUsed: 1,
        durationMsUsed: 125,
        costMicrosUsed: 42,
        tokensUsed: 123,
      })
    }),
  )

  it.effect("refuses another attempt after duration or cost budget is exhausted", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const durationRun = yield* create(runtime)
      yield* moveToRunning(runtime, durationRun.run.id)
      yield* runtime.beginAttempt({ runID: durationRun.run.id })
      yield* runtime.finishAttempt({
        runID: durationRun.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: budget.maxDurationMs,
        costMicros: 0,
        tokens: 0,
      })
      const durationExit = yield* runtime.beginAttempt({ runID: durationRun.run.id }).pipe(Effect.exit)

      const costRun = yield* create(runtime)
      yield* moveToRunning(runtime, costRun.run.id)
      yield* runtime.beginAttempt({ runID: costRun.run.id })
      yield* runtime.finishAttempt({
        runID: costRun.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: 1,
        costMicros: budget.maxCostMicros,
        tokens: 0,
      })
      const costExit = yield* runtime.beginAttempt({ runID: costRun.run.id }).pipe(Effect.exit)

      expect(String(durationExit)).toContain("DurableRun.BudgetExhaustedError")
      expect(String(costExit)).toContain("DurableRun.BudgetExhaustedError")
      expect((yield* runtime.load(durationRun.run.id)).run.budget.durationMsUsed).toBe(budget.maxDurationMs)
      expect((yield* runtime.load(costRun.run.id)).run.budget.costMicrosUsed).toBe(budget.maxCostMicros)

      const tokenRun = yield* create(runtime, AgentRuntime.Budget.make({ ...budget, maxTokens: 10, tokensUsed: 0 }))
      yield* moveToRunning(runtime, tokenRun.run.id)
      yield* runtime.beginAttempt({ runID: tokenRun.run.id })
      yield* runtime.finishAttempt({
        runID: tokenRun.run.id,
        attempt: 1,
        outcome: "completed",
        durationMs: 1,
        costMicros: 0,
        tokens: 10,
      })
      const tokenExit = yield* runtime.beginAttempt({ runID: tokenRun.run.id }).pipe(Effect.exit)

      expect(String(tokenExit)).toContain("DurableRun.BudgetExhaustedError")
      expect((yield* runtime.load(tokenRun.run.id)).run.budget.tokensUsed).toBe(10)
    }),
  )

  it.effect("uses an exclusive expiring lease so a live worker is not recovered twice", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* runtime.transition({ runID: created.run.id, to: "preflight", reason: "scope inspected" })
      yield* runtime.transition({ runID: created.run.id, to: "queued", reason: "ready" })
      yield* runtime.transition({ runID: created.run.id, to: "running", reason: "started" })

      const leased = yield* runtime.acquireLease({ runID: created.run.id, ownerID: "worker-a", ttlMs: 1_000 })
      expect(yield* runtime.acquireLease({ runID: created.run.id, ownerID: "worker-a", ttlMs: 1_000 })).toEqual(leased)
      const duplicate = yield* runtime
        .acquireLease({
          runID: created.run.id,
          ownerID: "worker-a",
          ttlMs: 1_000,
          reuseExisting: false,
        })
        .pipe(Effect.exit)
      expect(String(duplicate)).toContain("DurableRun.LeaseHeldError")
      expect(yield* runtime.load(created.run.id)).toEqual(leased)
      const competing = yield* runtime
        .acquireLease({ runID: created.run.id, ownerID: "worker-b", ttlMs: 1_000 })
        .pipe(Effect.exit)

      expect(leased.lease?.ownerID).toBe("worker-a")
      expect(String(competing)).toContain("DurableRun.LeaseHeldError")
      expect(yield* runtime.recoverable(created.run.sessionID)).toEqual([])
      expect(yield* runtime.orphaned(created.run.sessionID)).toEqual([])

      yield* TestClock.adjust("1001 millis")
      expect((yield* runtime.recoverable(created.run.sessionID)).map((item) => item.run.id)).toEqual([created.run.id])
      expect((yield* runtime.orphaned(created.run.sessionID)).map((item) => item.run.id)).toEqual([created.run.id])
      const replacement = yield* runtime.acquireLease({
        runID: created.run.id,
        ownerID: "worker-b",
        ttlMs: 1_000,
      })
      expect(replacement.lease?.ownerID).toBe("worker-b")
      expect(replacement.lease?.generation).toBe(1)
    }),
  )

  it.effect("only one same-owner fresh lease acquisition wins concurrent calls", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      const acquire = () =>
        runtime
          .acquireLease({
            runID: created.run.id,
            ownerID: "shared-owner",
            ttlMs: 1_000,
            reuseExisting: false,
          })
          .pipe(Effect.exit)
      const results = yield* Effect.all([acquire(), acquire()], { concurrency: "unbounded" })
      expect(results.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      const failures = results.filter((exit) => exit._tag === "Failure")
      expect(failures).toHaveLength(1)
      expect(String(failures[0])).toContain("DurableRun.LeaseHeldError")
      expect((yield* runtime.load(created.run.id)).lease?.generation).toBe(0)
    }),
  )

  it.effect("rejects a control lease request for a session run before appending a lease", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)

      const exit = yield* runtime
        .acquireControlLease({ runID: created.run.id, ownerID: "control-worker", ttlMs: 1_000 })
        .pipe(Effect.exit)
      const loaded = yield* runtime.load(created.run.id)

      expect(String(exit)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(loaded.lease).toBeUndefined()
      expect(loaded.lastSequence).toBe(0)
    }),
  )

  it.effect("rejects every plaintext run mutation for a control run without appending an event", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const runID = claimed.snapshot.run.id
      const leaseID = AgentRuntime.LeaseID.create()
      const exits = yield* Effect.all(
        [
          runtime.transition({ runID, to: "preflight", reason: "plaintext transition" }).pipe(Effect.exit),
          runtime.checkpoint({ runID, state: { forged: true } }).pipe(Effect.exit),
          runtime.beginAttempt({ runID }).pipe(Effect.exit),
          runtime
            .finishAttempt({ runID, attempt: 1, outcome: "failed", durationMs: 0, costMicros: 0, tokens: 0 })
            .pipe(Effect.exit),
          runtime.acquireLease({ runID, ownerID: "plaintext-owner", ttlMs: 1_000 }).pipe(Effect.exit),
          runtime.heartbeat({ runID, leaseID, ownerID: "plaintext-owner", ttlMs: 1_000 }).pipe(Effect.exit),
          runtime
            .releaseLease({ runID, leaseID, ownerID: "plaintext-owner", reason: "plaintext release" })
            .pipe(Effect.exit),
        ],
        { concurrency: 1 },
      )

      for (const exit of exits) expect(String(exit)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect((yield* runtime.load(runID)).lastSequence).toBe(0)
    }),
  )

  it.effect("records heartbeats and releases with owner-bound lease identity", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      const leased = yield* runtime.acquireLease({ runID: created.run.id, ownerID: "worker-a", ttlMs: 1_000 })
      const leaseID = leased.lease!.id

      yield* TestClock.adjust("500 millis")
      const heartbeat = yield* runtime.heartbeat({
        runID: created.run.id,
        leaseID,
        ownerID: "worker-a",
        ttlMs: 2_000,
      })
      const wrongOwner = yield* runtime
        .releaseLease({ runID: created.run.id, leaseID, ownerID: "worker-b", reason: "invalid takeover" })
        .pipe(Effect.exit)

      expect(DateTime.toEpochMillis(heartbeat.lease!.expiresAt)).toBe(2_500)
      expect(String(wrongOwner)).toContain("DurableRun.LeaseMismatchError")
      const released = yield* runtime.releaseLease({
        runID: created.run.id,
        leaseID,
        ownerID: "worker-a",
        reason: "worker shutdown",
      })
      expect(released.lease).toBeUndefined()
      expect(released.lastLeaseGeneration).toBe(0)

      const reacquired = yield* runtime.acquireLease({
        runID: created.run.id,
        ownerID: "worker-b",
        ttlMs: 1_000,
      })
      expect(reacquired.lease?.generation).toBe(1)
      expect(reacquired.lastLeaseGeneration).toBe(1)
    }),
  )

  it.effect("pending child recovery respects the oldest unfinished session item", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const parent = yield* create(runtime)
      yield* moveToRunning(runtime, parent.run.id)
      const sessionID = SessionSchema.ID.create()
      const child = (idempotencyKey: string) =>
        runtime.createChild({
          parentRunID: parent.run.id,
          sessionID,
          idempotencyKey,
          delegatedObjective: idempotencyKey,
          allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
          project: ProjectID.global,
          location: AbsolutePath.make("/recovery-fixture"),
          expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
          initiator: "agent",
          authority: "automatic",
          riskTier: "L0",
          reasonSummary: "recovery order",
          budget: AgentRuntime.Budget.make({
            ...budget,
            maxAttempts: 1,
            maxDurationMs: 10_000,
            maxCostMicros: 10_000,
            maxTokens: 100_000,
          }),
          traceID: idempotencyKey,
          visibility: "details",
        })
      const first = yield* child("first")
      const second = yield* child("second")
      const pending = () =>
        runtime
          .orphaned(sessionID, { includePendingChildren: true })
          .pipe(Effect.map((items) => items.map((item) => item.run.id)))
      expect(yield* runtime.orphaned(sessionID)).toEqual([])
      expect(yield* pending()).toEqual([first.run.id])
      yield* moveToRunning(runtime, first.run.id)
      yield* runtime.acquireLease({ runID: first.run.id, ownerID: "live-worker", ttlMs: 60_000 })
      expect(yield* pending()).toEqual([])
      yield* runtime.transition({ runID: first.run.id, to: "paused", reason: "user pause" })
      yield* TestClock.adjust(60_001)
      expect(yield* pending()).toEqual([])
      yield* runtime.transition({ runID: first.run.id, to: "cancelled", reason: "user cancellation" })
      expect(yield* pending()).toEqual([second.run.id])
    }),
  )

  it.effect("does not classify an explicitly paused run as crash-orphaned", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(runtime)
      yield* runtime.transition({ runID: created.run.id, to: "preflight", reason: "scope inspected" })
      yield* runtime.transition({ runID: created.run.id, to: "queued", reason: "ready" })
      yield* runtime.transition({ runID: created.run.id, to: "paused", reason: "user declined continuation" })

      expect((yield* runtime.recoverable(created.run.sessionID)).map((item) => item.run.id)).toEqual([created.run.id])
      expect(yield* runtime.orphaned(created.run.sessionID)).toEqual([])
    }),
  )

  it.effect("claims one immutable control run with an atomic projection seam and recovers it by subject", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      let committed: { readonly runID: AgentRuntime.RunID; readonly sequence: number } | undefined
      const first = yield* runtime.claimControl(input, {
        onCreated: ({ run, sequence }) =>
          Effect.sync(() => {
            committed = { runID: run.id, sequence }
          }),
      })
      const retried = yield* runtime.claimControl(input)

      expect(first.kind).toBe("claimed")
      expect(retried.kind).toBe("existing")
      expect(first.snapshot.run.id).toBe(retried.snapshot.run.id)
      expect(first.snapshot.run.operation).toEqual(input.operation)
      expect(committed).toEqual({ runID: first.snapshot.run.id, sequence: 0 })
      expect((yield* runtime.list({ subject: input.subject })).map((item) => item.run.id)).toEqual([
        first.snapshot.run.id,
      ])
      expect((yield* runtime.recoverableControl(input.subject)).map((item) => item.run.id)).toEqual([
        first.snapshot.run.id,
      ])
    }),
  )

  it.effect("finds a recoverable control run older than the default presentation page", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const control = yield* runtime.claimControl(controlInput("older-than-session-page"))
      yield* Effect.forEach(Array.from({ length: 100 }), () => create(runtime), {
        concurrency: 1,
        discard: true,
      })

      const recoverable = yield* runtime.recoverableControl()

      expect(recoverable.map((item) => item.run.id)).toContain(control.snapshot.run.id)
    }),
  )

  it.effect("quarantines one malformed aggregate without starving other control recovery", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const control = yield* runtime.claimControl(controlInput("survives-poisoned-neighbor"))
      const poisoned = yield* create(runtime)
      yield* db
        .update(EventTable)
        .set({ data: { malformed: true } })
        .where(eq(EventTable.aggregate_id, poisoned.run.id))
        .run()
        .pipe(Effect.orDie)

      const recoverable = yield* runtime.recoverableControl()

      expect(recoverable.map((item) => item.run.id)).toContain(control.snapshot.run.id)
      expect(recoverable.map((item) => item.run.id)).not.toContain(poisoned.run.id)
    }),
  )

  it.effect("rejects a forged control operation ID before the created event or projection callback", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      const forged: DurableRun.ControlCreateInput = {
        ...input,
        operation: AgentRuntime.ControlOperationSnapshot.make({
          ...input.operation,
          id: AgentRuntime.ControlOperationID.create(),
        }),
      }
      let projected = false

      const exit = yield* runtime
        .claimControl(forged, {
          onCreated: () =>
            Effect.sync(() => {
              projected = true
            }),
        })
        .pipe(Effect.exit)

      expect(String(exit)).toContain("DurableRun.InvalidControlClaimError")
      expect(projected).toBe(false)
      expect(yield* runtime.list({ subject: input.subject })).toEqual([])
    }),
  )

  it.effect("fails closed when a deterministic control claim is presented with a different frozen snapshot", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      yield* runtime.claimControl(input)
      const changedPayload = { commit: "def456", target: "sandbox" }
      const changedDigest = canonicalHash(changedPayload)
      if (!changedDigest) return yield* Effect.die(new Error("control test payload must be canonical"))
      const forged: DurableRun.ControlCreateInput = {
        ...input,
        operation: AgentRuntime.ControlOperationSnapshot.make({
          ...input.operation,
          inputDigest: "forged-input-digest",
          payload: changedPayload,
          payloadDigest: changedDigest,
        }),
      }

      const exit = yield* runtime.claimControl(forged).pipe(Effect.exit)
      expect(String(exit)).toContain("DurableRun.ControlClaimConflictError")
    }),
  )

  it.effect("returns the canonical control run only for a byte-identical retry under a later request", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      const first = yield* runtime.claimControl(input)
      const retried: DurableRun.ControlCreateInput = {
        ...input,
        subject: AgentRuntime.ControlPlaneSubject.make({
          ...input.subject,
          requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_control-alias"),
        }),
      }

      const alias = yield* runtime.claimControl(retried)

      expect(first.kind).toBe("claimed")
      expect(alias.kind).toBe("existing")
      expect(alias.presentedRequestID).toBe(retried.subject.requestID)
      expect(alias.snapshot.run.id).toBe(first.snapshot.run.id)
      expect(alias.snapshot.run.subject.requestID).toBe(input.subject.requestID)
      expect((yield* runtime.list({ subject: input.subject })).map((item) => item.run.id)).toEqual([
        first.snapshot.run.id,
      ])
    }),
  )

  it.effect("does not treat a later request with a new action or binding as the first request alias", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      yield* runtime.claimControl(input)
      const secondRequest: DurableRun.ControlCreateInput = {
        ...input,
        subject: AgentRuntime.ControlPlaneSubject.make({
          ...input.subject,
          requestID: AgentRuntime.ControlPlaneRequestID.make("cpr_control-new-request"),
        }),
        operation: AgentRuntime.ControlOperationSnapshot.make({
          ...input.operation,
          actionID: AgentRuntime.ActionID.make("act_control-new-request"),
          authorizationDigest: "authorization-control-new-request",
        }),
      }

      const exit = yield* runtime.claimControl(secondRequest).pipe(Effect.exit)

      expect(String(exit)).toContain("DurableRun.ControlClaimConflictError")
    }),
  )

  it.effect("rolls back the control created event when its atomic projection fails", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const input = controlInput()
      const runID = DurableRun.controlRunID(input)
      if (!runID) return yield* Effect.die(new Error("control test run ID must be canonical"))
      const exit = yield* runtime
        .claimControl(input, { onCreated: () => Effect.die(new Error("projection failed")) })
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const loaded = yield* runtime.load(runID).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.NotFoundError")
    }),
  )

  it.effect("replays control @2 transitions, checkpoints, and leases without a session identity", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const owned = yield* runtime.acquireControlLease({
        runID: claimed.snapshot.run.id,
        ownerID: "control-worker",
        ttlMs: 1_000,
      })
      yield* runtime.transitionControl(owned.capability, {
        runID: claimed.snapshot.run.id,
        to: "preflight",
        reason: "snapshot persisted",
      })
      yield* runtime.transitionControl(owned.capability, {
        runID: claimed.snapshot.run.id,
        to: "awaiting_authorization",
        reason: "human approval required",
      })
      yield* runtime.transitionControl(owned.capability, {
        runID: claimed.snapshot.run.id,
        to: "queued",
        reason: "approval received",
      })
      yield* runtime.transitionControl(owned.capability, {
        runID: claimed.snapshot.run.id,
        to: "running",
        reason: "worker acquired the task",
      })
      const checkpoint = yield* runtime.checkpointControl(owned.capability, {
        runID: claimed.snapshot.run.id,
        lastActionID: claimed.snapshot.run.operation.actionID,
        state: { phase: "worktree-created", actionID: claimed.snapshot.run.operation.actionID },
      })
      const loaded = yield* runtime.load(claimed.snapshot.run.id)

      if (!("subject" in loaded.run)) return yield* Effect.die(new Error("expected a control run"))
      expect("sessionID" in loaded.run).toBe(false)
      expect(loaded.run.status).toBe("running")
      expect(loaded.checkpoint?.id).toBe(checkpoint.id)
      expect(loaded.lease?.id).toBe(owned.snapshot.lease?.id)
      expect(loaded.lease?.generation).toBe(0)
    }),
  )

  it.effect("drives the complete control lifecycle through one rotating lease capability", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const runID = claimed.snapshot.run.id
      const owned = yield* runtime.acquireControlLease({ runID, ownerID: "control-worker", ttlMs: 5_000 })

      yield* runtime.transitionControl(owned.capability, { runID, to: "preflight", reason: "preflight" })
      yield* runtime.transitionControl(owned.capability, { runID, to: "queued", reason: "authorized" })
      yield* runtime.transitionControl(owned.capability, { runID, to: "running", reason: "worker started" })
      const checkpoint = yield* runtime.checkpointControl(owned.capability, {
        runID,
        lastActionID: claimed.snapshot.run.operation.actionID,
        state: { phase: "executing" },
      })
      expect(checkpoint.eventSequence).toBe(5)
      const startedControl = yield* runtime.beginControlAttempt(owned.capability, {
        runID,
        usageBaseline: { costMicros: 3, tokens: 4 },
      })
      expect(startedControl.activeAttempt).toMatchObject({
        attempt: 1,
        usageBaseline: { costMicros: 3, tokens: 4 },
      })
      expect(
        (yield* runtime.finishControlAttempt(owned.capability, {
          runID,
          attempt: 1,
          outcome: "completed",
          durationMs: 10,
          costMicros: 5,
          tokens: 7,
        })).activeAttempt,
      ).toBeUndefined()
      expect((yield* runtime.load(runID)).run.budget.tokensUsed).toBe(7)

      yield* TestClock.adjust("100 millis")
      const renewed = yield* runtime.heartbeatControl(owned.capability, { runID, ttlMs: 5_000 })
      expect(String(yield* runtime.validateControlLease(owned.capability).pipe(Effect.exit))).toContain(
        "DurableRun.InvalidRunLeaseCapabilityError",
      )
      expect((yield* runtime.validateControlLease(renewed.capability)).lease?.heartbeatAt).toEqual(
        renewed.snapshot.lease?.heartbeatAt,
      )

      yield* runtime.transitionControl(renewed.capability, { runID, to: "verifying", reason: "verify" })
      yield* runtime.transitionControl(renewed.capability, { runID, to: "completed", reason: "verified" })
      const terminalSequence = (yield* runtime.load(runID)).lastSequence
      const terminalCheckpoint = yield* runtime
        .checkpointControl(renewed.capability, { runID, state: { forbidden: true } })
        .pipe(Effect.exit)
      const terminalHeartbeat = yield* runtime
        .heartbeatControl(renewed.capability, { runID, ttlMs: 5_000 })
        .pipe(Effect.exit)
      const terminalAttempt = yield* runtime.beginControlAttempt(renewed.capability, { runID }).pipe(Effect.exit)
      expect(String(terminalCheckpoint)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(String(terminalHeartbeat)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(String(terminalAttempt)).toContain("DurableRun.InvalidAttemptStateError")
      expect((yield* runtime.load(runID)).lastSequence).toBe(terminalSequence)

      const released = yield* runtime.releaseControlLease(renewed.capability, { runID, reason: "worker finished" })
      expect(released.lease).toBeUndefined()
      expect(String(yield* runtime.validateControlLease(renewed.capability).pipe(Effect.exit))).toContain(
        "DurableRun.InvalidRunLeaseCapabilityError",
      )
    }),
  )

  it.effect("serializes competing control mutations and recomputes checkpoint identity after CAS contention", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const runID = claimed.snapshot.run.id
      const owned = yield* runtime.acquireControlLease({ runID, ownerID: "cas-worker", ttlMs: 5_000 })

      const transitions = yield* Effect.all(
        [
          runtime.transitionControl(owned.capability, { runID, to: "preflight", reason: "winner-a" }).pipe(Effect.exit),
          runtime.transitionControl(owned.capability, { runID, to: "preflight", reason: "winner-b" }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(transitions.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      yield* runtime.transitionControl(owned.capability, { runID, to: "queued", reason: "ready" })
      yield* runtime.transitionControl(owned.capability, { runID, to: "running", reason: "started" })

      const checkpoints = yield* Effect.all(
        [
          runtime.checkpointControl(owned.capability, { runID, state: { worker: "a" } }),
          runtime.checkpointControl(owned.capability, { runID, state: { worker: "b" } }),
        ],
        { concurrency: "unbounded" },
      )
      expect(new Set(checkpoints.map((checkpoint) => checkpoint.eventSequence)).size).toBe(2)
      const checkpointRows = yield* db
        .select({ data: EventTable.data, type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, runID))
        .all()
        .pipe(Effect.orDie)
      const storedCheckpoints = checkpointRows
        .filter((row) => row.type === EventV2.versionedType(AgentRuntime.Event.ControlRunCheckpointCreated.type, 2))
        .map(
          (row) => Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunCheckpointCreated.data)(row.data).checkpoint,
        )
      expect(storedCheckpoints).toHaveLength(2)
      for (const checkpoint of storedCheckpoints)
        expect(checkpoint.resumeToken).toBe(
          digest({
            checkpointID: checkpoint.id,
            runID: checkpoint.runID,
            lastActionID: checkpoint.lastActionID ?? null,
            eventSequence: checkpoint.eventSequence,
            stateDigest: checkpoint.stateDigest,
            createdAt: DateTime.toEpochMillis(checkpoint.createdAt),
          }),
        )

      const starts = yield* Effect.all(
        [
          runtime.beginControlAttempt(owned.capability, { runID }).pipe(Effect.exit),
          runtime.beginControlAttempt(owned.capability, { runID }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(starts.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      const finishes = yield* Effect.all(
        [
          runtime
            .finishControlAttempt(owned.capability, {
              runID,
              attempt: 1,
              outcome: "completed",
              durationMs: 1,
              costMicros: 1,
              tokens: 0,
            })
            .pipe(Effect.exit),
          runtime
            .finishControlAttempt(owned.capability, {
              runID,
              attempt: 1,
              outcome: "completed",
              durationMs: 1,
              costMicros: 1,
              tokens: 0,
            })
            .pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(finishes.filter((exit) => exit._tag === "Success")).toHaveLength(1)

      yield* TestClock.adjust("10 millis")
      const heartbeats = yield* Effect.all(
        [
          runtime.heartbeatControl(owned.capability, { runID, ttlMs: 5_000 }).pipe(Effect.exit),
          runtime.heartbeatControl(owned.capability, { runID, ttlMs: 5_000 }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      const renewed = heartbeats.find((exit) => exit._tag === "Success")
      if (!renewed || renewed._tag !== "Success") return yield* Effect.die(new Error("expected one heartbeat winner"))
      expect(heartbeats.filter((exit) => exit._tag === "Success")).toHaveLength(1)
      const releases = yield* Effect.all(
        [
          runtime.releaseControlLease(renewed.value.capability, { runID, reason: "release-a" }).pipe(Effect.exit),
          runtime.releaseControlLease(renewed.value.capability, { runID, reason: "release-b" }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      )
      expect(releases.filter((exit) => exit._tag === "Success")).toHaveLength(1)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, runID))
        .all()
        .pipe(Effect.orDie)
      const count = (event: { readonly type: string }) =>
        rows.filter((row) => row.type === EventV2.versionedType(event.type, 2)).length
      expect(count(AgentRuntime.Event.ControlRunStateChanged)).toBe(3)
      expect(count(AgentRuntime.Event.ControlRunAttemptStarted)).toBe(1)
      expect(count(AgentRuntime.Event.ControlRunAttemptFinished)).toBe(1)
      expect(count(AgentRuntime.Event.ControlRunHeartbeatRecorded)).toBe(1)
      expect(count(AgentRuntime.Event.ControlRunLeaseReleased)).toBe(1)
    }),
  )

  it.effect("fails closed when the event-sequence projection is ahead of the aggregate", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const created = yield* create(runtime)
      yield* db
        .update(EventSequenceTable)
        .set({ seq: 1 })
        .where(eq(EventSequenceTable.aggregate_id, created.run.id))
        .run()
        .pipe(Effect.orDie)

      const loaded = yield* runtime.load(created.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("fails closed when an unknown durable tail event exists", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const created = yield* create(runtime)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(EventTable)
              .values({
                id: EventV2.ID.create(),
                aggregate_id: created.run.id,
                seq: 1,
                type: "agent.run.unknown-tail",
                data: {},
              })
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(EventSequenceTable)
              .set({ seq: 1 })
              .where(eq(EventSequenceTable.aggregate_id, created.run.id))
              .run()
              .pipe(Effect.orDie)
          }),
        )
        .pipe(Effect.orDie)

      const loaded = yield* runtime.load(created.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("recomputes the frozen control payload digest during replay", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const row = yield* db
        .select({ id: EventTable.id, data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, claimed.snapshot.run.id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error("expected the control created event"))
      const created = Schema.decodeUnknownSync(AgentRuntime.Event.ControlRunCreated.data)(row.data)
      yield* db
        .update(EventTable)
        .set({
          data: {
            ...created,
            run: {
              ...created.run,
              operation: { ...created.run.operation, payloadDigest: "forged-payload-digest" },
            },
          },
        })
        .where(eq(EventTable.id, row.id))
        .run()
        .pipe(Effect.orDie)

      const loaded = yield* runtime.load(claimed.snapshot.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("rejects a second attempt-start event while an attempt is active during replay", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const created = yield* create(runtime)
      yield* moveToRunning(runtime, created.run.id)
      yield* runtime.beginAttempt({ runID: created.run.id })
      yield* events.publish(
        AgentRuntime.Event.RunAttemptStarted,
        {
          runID: created.run.id,
          sessionID: created.run.sessionID,
          attempt: 2,
          startedAt: yield* DateTime.now,
        },
        { expectedSequence: 4 },
      )

      const loaded = yield* runtime.load(created.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("rejects an overlapping control lease acquisition during replay", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const claimed = yield* runtime.claimControl(controlInput())
      yield* runtime.acquireControlLease({ runID: claimed.snapshot.run.id, ownerID: "worker-a", ttlMs: 1_000 })
      const acquiredAt = yield* DateTime.now
      const lease = AgentRuntime.RunLease.make({
        id: AgentRuntime.LeaseID.create(),
        runID: claimed.snapshot.run.id,
        ownerID: "worker-b",
        generation: 1,
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(acquiredAt) + 1_000),
      })
      yield* events.publish(
        AgentRuntime.Event.ControlRunLeaseAcquired,
        { runID: claimed.snapshot.run.id, subject: claimed.snapshot.run.subject, lease },
        { expectedSequence: 1 },
      )

      const loaded = yield* runtime.load(claimed.snapshot.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("fails closed if a control run history contains a session @1 event", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const claimed = yield* runtime.claimControl(controlInput())
      yield* events.publish(
        AgentRuntime.Event.RunStateChanged,
        {
          runID: claimed.snapshot.run.id,
          sessionID: SessionSchema.ID.create(),
          from: "draft",
          to: "preflight",
          reason: "forged cross-family event",
          changedAt: DateTime.makeUnsafe(1),
        },
        { expectedSequence: 0 },
      )

      const loaded = yield* runtime.load(claimed.snapshot.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("never revives an expired control lease through a public heartbeat or an old capability", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const owned = yield* runtime.acquireControlLease({
        runID: claimed.snapshot.run.id,
        ownerID: "worker-old",
        ttlMs: 1_000,
      })
      yield* TestClock.adjust("1 second")

      const heartbeat = yield* runtime
        .heartbeat({
          runID: claimed.snapshot.run.id,
          leaseID: owned.snapshot.lease!.id,
          ownerID: "worker-old",
          ttlMs: 1_000,
        })
        .pipe(Effect.exit)
      const oldCapability = yield* runtime.validateControlLease(owned.capability).pipe(Effect.exit)
      const replacement = yield* runtime.acquireControlLease({
        runID: claimed.snapshot.run.id,
        ownerID: "worker-new",
        ttlMs: 1_000,
      })
      const afterReplacement = yield* runtime.validateControlLease(owned.capability).pipe(Effect.exit)

      expect(String(heartbeat)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(String(oldCapability)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(replacement.snapshot.lease?.generation).toBe(1)
      expect(String(afterReplacement)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
    }),
  )

  it.effect("binds a control capability to one layer, run, lease revision, and generation", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const first = yield* runtime.claimControl(controlInput("owner-a"))
      const second = yield* runtime.claimControl(controlInput("owner-b"))
      const runID = first.snapshot.run.id
      const otherRunID = second.snapshot.run.id
      const owned = yield* runtime.acquireControlLease({ runID, ownerID: "worker", ttlMs: 1_000 })
      const clone: DurableRun.RunLeaseCapability = { ...owned.capability }

      const sameOwner = yield* runtime.acquireControlLease({ runID, ownerID: "worker", ttlMs: 1_000 }).pipe(Effect.exit)
      const cloned = yield* runtime
        .transitionControl(clone, { runID, to: "preflight", reason: "cloned token" })
        .pipe(Effect.exit)
      const wrongRun = yield* runtime
        .transitionControl(owned.capability, { runID: otherRunID, to: "preflight", reason: "wrong run" })
        .pipe(Effect.exit)
      const crossLayer = yield* Effect.gen(function* () {
        const otherRuntime = yield* DurableRun.Service
        return yield* otherRuntime.validateControlLease(owned.capability)
      }).pipe(Effect.provide(Layer.fresh(runtimeLayer)), Effect.exit)

      expect(String(sameOwner)).toContain("DurableRun.LeaseHeldError")
      expect(String(cloned)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(String(wrongRun)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(String(crossLayer)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect((yield* runtime.load(runID)).lastSequence).toBe(1)
      expect((yield* runtime.load(otherRunID)).lastSequence).toBe(0)

      yield* TestClock.adjust("1 second")
      const expired = yield* runtime
        .transitionControl(owned.capability, { runID, to: "preflight", reason: "expired token" })
        .pipe(Effect.exit)
      const replacement = yield* runtime.acquireControlLease({ runID, ownerID: "worker-next", ttlMs: 1_000 })
      const oldGeneration = yield* runtime
        .transitionControl(owned.capability, { runID, to: "preflight", reason: "old generation" })
        .pipe(Effect.exit)

      expect(String(expired)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect(replacement.snapshot.lease?.generation).toBe(1)
      expect(String(oldGeneration)).toContain("DurableRun.InvalidRunLeaseCapabilityError")
      expect((yield* runtime.load(runID)).lastSequence).toBe(2)
    }),
  )

  it.effect("rejects a raw lease heartbeat at the exact expiry boundary during replay", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const claimed = yield* runtime.claimControl(controlInput())
      const owned = yield* runtime.acquireControlLease({
        runID: claimed.snapshot.run.id,
        ownerID: "worker-old",
        ttlMs: 1_000,
      })
      const lease = owned.snapshot.lease!
      yield* events.publish(
        AgentRuntime.Event.ControlRunHeartbeatRecorded,
        {
          runID: claimed.snapshot.run.id,
          subject: claimed.snapshot.run.subject,
          leaseID: lease.id,
          ownerID: lease.ownerID,
          generation: lease.generation,
          heartbeatAt: lease.expiresAt,
          expiresAt: DateTime.makeUnsafe(DateTime.toEpochMillis(lease.expiresAt) + 1_000),
        },
        { expectedSequence: 1 },
      )

      const loaded = yield* runtime.load(claimed.snapshot.run.id).pipe(Effect.exit)
      expect(String(loaded)).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("binds checkpoint resume tokens to identity, last action, and creation time", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const { db } = yield* Database.Service
      for (const mutation of ["checkpointID", "lastActionID", "createdAt"] as const) {
        const created = yield* create(runtime)
        const checkpoint = yield* runtime.checkpoint({ runID: created.run.id, state: { phase: mutation } })
        const rows = yield* db
          .select({ id: EventTable.id, seq: EventTable.seq, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, created.run.id))
          .all()
          .pipe(Effect.orDie)
        const row = rows.find((candidate) => candidate.seq === checkpoint.eventSequence)
        if (!row) return yield* Effect.die(new Error("expected checkpoint event"))
        const data = Schema.decodeUnknownSync(AgentRuntime.Event.RunCheckpointCreated.data)(row.data)
        const tampered = {
          ...data.checkpoint,
          ...(mutation === "checkpointID" ? { id: AgentRuntime.CheckpointID.create() } : {}),
          ...(mutation === "lastActionID" ? { lastActionID: AgentRuntime.ActionID.create() } : {}),
          ...(mutation === "createdAt"
            ? { createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(checkpoint.createdAt) + 1) }
            : {}),
        }
        const tamperedData = Schema.encodeSync(AgentRuntime.Event.RunCheckpointCreated.data)({
          ...data,
          checkpoint: tampered,
        })
        yield* db
          .update(EventTable)
          .set({ data: tamperedData })
          .where(eq(EventTable.id, row.id))
          .run()
          .pipe(Effect.orDie)

        const loaded = yield* runtime.load(created.run.id).pipe(Effect.exit)
        expect(String(loaded), mutation).toContain("DurableRun.CorruptHistoryError")
      }
    }),
  )

  it.effect("rejects attempts outside running state and refuses state changes while one is active", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const draft = yield* create(runtime)
      const draftAttempt = yield* runtime.beginAttempt({ runID: draft.run.id }).pipe(Effect.exit)
      expect(String(draftAttempt)).toContain("DurableRun.InvalidAttemptStateError")
      expect((yield* runtime.load(draft.run.id)).lastSequence).toBe(0)

      yield* events.publish(
        AgentRuntime.Event.RunAttemptStarted,
        {
          runID: draft.run.id,
          sessionID: draft.run.sessionID,
          attempt: 1,
          startedAt: yield* DateTime.now,
        },
        { expectedSequence: 0 },
      )
      expect(String(yield* runtime.load(draft.run.id).pipe(Effect.exit))).toContain("DurableRun.CorruptHistoryError")

      const running = yield* create(runtime)
      yield* moveToRunning(runtime, running.run.id)
      yield* runtime.beginAttempt({ runID: running.run.id })
      const publicTransition = yield* runtime
        .transition({ runID: running.run.id, to: "verifying", reason: "attempt not closed" })
        .pipe(Effect.exit)
      expect(String(publicTransition)).toContain("DurableRun.InvalidTransitionError")
      yield* events.publish(
        AgentRuntime.Event.RunStateChanged,
        {
          runID: running.run.id,
          sessionID: running.run.sessionID,
          from: "running",
          to: "verifying",
          reason: "forged transition with active attempt",
          changedAt: yield* DateTime.now,
        },
        { expectedSequence: 4 },
      )
      expect(String(yield* runtime.load(running.run.id).pipe(Effect.exit))).toContain("DurableRun.CorruptHistoryError")
    }),
  )

  it.effect("bounds one provider output by settled, in-flight, and estimated input tokens", () =>
    Effect.gen(function* () {
      const runtime = yield* DurableRun.Service
      const created = yield* create(
        runtime,
        AgentRuntime.Budget.make({
          ...budget,
          maxTokens: 1_000,
        }),
      )
      yield* moveToRunning(runtime, created.run.id)
      const active = yield* runtime.beginAttempt({
        runID: created.run.id,
        usageBaseline: AgentRuntime.RunUsageBaseline.make({ costMicros: 0, tokens: 100 }),
      })

      expect(
        DurableRun.providerOutputTokenAllowance({
          snapshot: active,
          cumulativeSessionTokens: 150,
          estimatedInputTokens: 200,
          modelMaxOutputTokens: 800,
        }),
      ).toBe(750)
      expect(
        DurableRun.providerOutputTokenAllowance({
          snapshot: active,
          cumulativeSessionTokens: 150,
          estimatedInputTokens: 200,
          modelMaxOutputTokens: 300,
        }),
      ).toBe(300)
      expect(
        DurableRun.providerOutputTokenAllowance({
          snapshot: active,
          cumulativeSessionTokens: 1_100,
          estimatedInputTokens: 1,
        }),
      ).toBe(0)
    }),
  )
})
