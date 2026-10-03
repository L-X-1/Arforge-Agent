import { expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { CurrentCheck, AccessDeniedError } from "@arforge-ai/core/runtime/subagent-control-access"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { DateTime, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node])))
const create = (runs: DurableRun.Interface) =>
  runs.create({
    sessionID: SessionSchema.ID.create(),
    initiator: "user",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "Historical pending task",
    traceID: "trace-pending",
    visibility: "details",
    budget: {
      maxAttempts: 3,
      maxDurationMs: 60_000,
      maxCostMicros: 100_000,
      maxTokens: 100_000,
      attemptsUsed: 0,
      durationMsUsed: 0,
      costMicrosUsed: 0,
      tokensUsed: 0,
    },
  })

for (const state of ["draft", "preflight", "queued", "awaiting_authorization"] as const) {
  it.effect(`inspects and explicitly cancels only the original unstarted ${state} task`, () =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const { db } = yield* Database.Service
      const created = yield* create(runs)
      const runID = created.run.id
      const sessionID = created.run.sessionID
      if (state !== "draft") yield* runs.transition({ runID, to: "preflight", reason: "fixture preflight" })
      if (state === "queued" || state === "awaiting_authorization")
        yield* runs.transition({ runID, to: state, reason: "fixture pending" })
      const before = yield* runs.load(runID)
      const inspected = yield* runs.sessionRecovery(sessionID)
      expect(inspected).toEqual([
        {
          runID,
          sessionID,
          status: state,
          revision: before.lastSequence,
          admissionRecorded: false,
          leaseExpiresAt: null,
          cancellationBlocker: null,
        },
      ])
      expect(yield* runs.load(runID)).toEqual(before)
      const rows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, runID))
        .all()
        .pipe(Effect.orDie)
      const cancelled = yield* runs.cancelPendingSession({ runID, sessionID, expectedSequence: before.lastSequence })
      expect(yield* runs.load(runID)).toEqual(cancelled)
      expect(cancelled.run.status).toBe("cancelled")
      expect(cancelled.run.budget).toEqual(before.run.budget)
      expect(cancelled.lastSequence).toBe(before.lastSequence + 1)
      expect(yield* runs.sessionRecovery(sessionID)).toEqual([])
      const after = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, runID))
        .all()
        .pipe(Effect.orDie)
      expect(after.slice(0, rows.length)).toEqual(rows)
      expect(after).toHaveLength(rows.length + 1)
      const replay = yield* runs
        .cancelPendingSession({ runID, sessionID, expectedSequence: before.lastSequence })
        .pipe(Effect.flip)
      expect(replay).toMatchObject({ code: "stale-revision" })
      expect(yield* runs.load(runID)).toEqual(cancelled)
    }),
  )
}

for (const blocker of [
  "foreign-session",
  "stale-revision",
  "lease-held",
  "checkpoint",
  "request",
  "running",
] as const) {
  it.effect(`pending cancellation rejects ${blocker} without changing original facts`, () =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const created = yield* create(runs)
      const runID = created.run.id
      const sessionID = created.run.sessionID
      if (blocker === "lease-held") yield* runs.acquireLease({ runID, ownerID: "live-owner", ttlMs: 1_000 })
      if (blocker === "checkpoint") yield* runs.checkpoint({ runID, state: { outcome: "unknown" } })
      if (blocker === "request")
        yield* events.publish(SessionEvent.RequestEnvelopePrepared, {
          sessionID,
          runID,
          timestamp: yield* DateTime.now,
          turnStep: 0,
          schemaVersion: "1.0",
          requestDigest: "a".repeat(64),
          envelope: "{}",
        })
      if (blocker === "running") {
        for (const to of ["preflight", "queued", "running"] as const)
          yield* runs.transition({ runID, to, reason: "fixture running" })
        yield* runs.beginAttempt({ runID })
      }
      const before = yield* runs.load(runID)
      const result = yield* runs
        .cancelPendingSession({
          runID,
          sessionID: blocker === "foreign-session" ? SessionSchema.ID.create() : sessionID,
          expectedSequence: blocker === "stale-revision" ? before.lastSequence + 1 : before.lastSequence,
        })
        .pipe(Effect.flip)
      expect(result).toMatchObject({
        code:
          blocker === "checkpoint" || blocker === "request"
            ? "dependent-work"
            : blocker === "running"
              ? "not-pending"
              : blocker,
      })
      expect(result.message.length).toBeGreaterThan(10)
      expect(yield* runs.load(runID)).toEqual(before)
      if (blocker === "lease-held") {
        yield* TestClock.adjust("1 second")
        expect((yield* runs.sessionRecovery(sessionID))[0].cancellationBlocker).toBeNull()
      }
    }),
  )
}

for (const change of ["revision", "request", "access"] as const) {
  it.effect(`pending cancellation rechecks ${change} at its original commit boundary`, () =>
    Effect.gen(function* () {
      const runs = yield* DurableRun.Service
      const events = yield* EventV2.Service
      const created = yield* create(runs)
      const {
        run: { id: runID, sessionID },
      } = created
      const original = events.publish
      const owner: { publish: typeof original } = events
      let changed = false
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          owner.publish = original
        }),
      )
      owner.publish = (definition, data, options) =>
        Effect.gen(function* () {
          if (!changed && definition.type === AgentRuntime.Event.RunStateChanged.type) {
            changed = true
            if (change === "revision")
              yield* runs.transition({ runID, to: "preflight", reason: "concurrent progress" }).pipe(Effect.orDie)
            if (change === "request")
              yield* original(SessionEvent.RequestEnvelopePrepared, {
                sessionID,
                runID,
                timestamp: yield* DateTime.now,
                turnStep: 0,
                schemaVersion: "1.0",
                requestDigest: "a".repeat(64),
                envelope: "{}",
              })
          }
          return yield* original(definition, data, options)
        })
      const result = yield* runs.cancelPendingSession({ runID, sessionID, expectedSequence: 0 }).pipe(
        Effect.provideService(
          CurrentCheck,
          Effect.gen(function* () {
            if (change === "access" && changed) return yield* Effect.fail(new AccessDeniedError())
            return yield* Effect.void
          }),
        ),
        Effect.exit,
      )
      expect(result._tag).toBe("Failure")
      expect(changed).toBe(true)
      const after = yield* runs.load(runID)
      expect(after.run.status).toBe(change === "revision" ? "preflight" : "draft")
      expect(after.lastSequence).toBe(change === "revision" ? 1 : 0)
      expect(after.run.budget).toEqual(created.run.budget)
    }),
  )
}
