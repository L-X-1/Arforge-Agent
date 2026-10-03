import { describe, expect } from "bun:test"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import * as PersonalJobInput from "@arforge-ai/schema/personal-job-input"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Credential } from "@arforge-ai/schema/credential"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { DateTime, Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventTable } from "@arforge-ai/core/event/sql"
import { PersonalJobV2 } from "@arforge-ai/core/personal-job"
import { dispatchDueWith, executeWith, type SessionRuntime } from "@arforge-ai/core/personal-job-executor"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import { resultDigest } from "@arforge-ai/core/personal-job-result"
import { OpaqueArtifact } from "@arforge-ai/core/runtime/artifact-ref"
import { testEffect } from "./lib/effect"

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, PersonalJobV2.node, SessionProjector.node]),
)
const it = testEffect(layer)
const testRun = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
const sessionID = SessionV2.ID.make(`ses_personal_job_${testRun}`)
const isolatedSessionID = SessionV2.ID.make(`ses_personal_job_tick_${testRun}`)
const dispatchSessionID = SessionV2.ID.make(`ses_personal_job_dispatch_${testRun}`)

const setupSession = (ownerSessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/personal-job"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: ownerSessionID,
        project_id: Project.ID.global,
        slug: ownerSessionID,
        directory: "/personal-job",
        title: "personal-job",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = setupSession(sessionID)

const policy = PersonalJob.ApprovalPolicy.make({ mode: "automatic", rationale: "test policy" })
const budget = PersonalJob.BudgetLimits.make({ maxAttempts: 2, maxDurationMs: 60_000, maxCostMicros: 10_000 })
const notificationPolicy = PersonalJob.NotificationPolicy.make({
  mode: "in_app",
  events: ["completed", "failed", "cancelled"],
})

const input = (idempotencyKey: string, now: number, recurring = false, ownerSessionID = sessionID) =>
  ({
    idempotencyKey: PersonalJob.IdempotencyKey.make(`${idempotencyKey}-${testRun}`),
    sessionID: ownerSessionID,
    title: PersonalJob.Title.make("Nightly personal task"),
    prompt: PersonalJob.Prompt.make("Review the current project and report verified changes."),
    schedule: PersonalJob.Schedule.make({
      kind: recurring ? "cron" : "once",
      label: recurring ? "每分钟审查" : "立即审查",
      ...(recurring ? { cron: ScheduledPrompt.Cron.make("* * * * *") } : {}),
      nextRunAt: DateTime.makeUnsafe(now - 1_000),
      timezone: "UTC",
    }),
    budget,
    approvalPolicy: policy,
    notificationPolicy,
  }) satisfies PersonalJobV2.CreateInput

const result = () => {
  const payload = {
    status: "completed" as const,
    summary: "Verified project changes.",
    artifactRefs: [],
    usage: { durationMs: 250, costMicros: 20 },
  }
  const digest = canonicalHash(payload)
  if (!digest) throw new Error("test result must be canonical")
  return { ...payload, digest }
}

describe("PersonalJobV2", () => {
  for (const boundary of ["recovery", "pause"] as const) {
    it.effect(`reuses the original executor input after ${boundary} changes the job revision`, () =>
      Effect.gen(function* () {
        const ownerSessionID = SessionV2.ID.make(`ses_personal_job_input_${boundary}_${testRun}`)
        yield* setupSession(ownerSessionID)
        const jobs = yield* PersonalJobV2.Service
        const created = yield* jobs.create(input(`input-${boundary}`, Date.now(), false, ownerSessionID))
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        const inputs: SessionMessage.ID[] = []
        const sessions: SessionRuntime = {
          context: () => Effect.succeed([]),
          prompt: (request) =>
            Effect.gen(function* () {
              if (!request.id) return yield* Effect.die("Expected the durable occurrence input ID")
              inputs.push(request.id)
              yield* SessionInput.admit(db, events, {
                id: request.id,
                sessionID: request.sessionID,
                prompt: Prompt.make({ text: request.prompt.text }),
                delivery: "queue",
              })
              return yield* Effect.die("Injected interruption after input admission")
            }),
          resume: () => Effect.die("No model execution belongs to this admission-only test"),
          resumeWithCredentials: () => Effect.die("No model execution belongs to this admission-only test"),
          interrupt: () => Effect.void,
        }
        // Keep the original job running as if the worker was lost before its
        // result transaction. This is injected lifecycle coverage, not SIGKILL.
        const execute = (revision: number) =>
          executeWith(
            { jobs: { ...jobs, recordResult: () => Effect.die("Injected lost settlement") }, sessions },
            { jobID: created.id, expectedRevision: revision },
          ).pipe(Effect.exit)
        yield* execute(created.revision)
        const first = yield* jobs.get(created.id)
        if (boundary === "recovery") {
          expect(yield* jobs.recover({ sessionID: ownerSessionID, now: Date.now() + 62_000 })).toBe(1)
        } else {
          const paused = yield* jobs.pause({ jobID: first.id, expectedRevision: first.revision })
          yield* jobs.resume({ jobID: paused.id, expectedRevision: paused.revision })
        }
        const queued = yield* jobs.get(created.id)
        yield* execute(queued.revision)
        const resumed = yield* jobs.get(created.id)
        expect(resumed.revision).toBeGreaterThan(first.revision)
        expect(inputs).toHaveLength(2)
        expect(inputs[1]).toBe(inputs[0])
        expect(resumed.occurrence?.messageID).toBe(inputs[0])
        expect(resumed.occurrence).toEqual(first.occurrence)
        const pending = yield* SessionInput.listQueued(db, ownerSessionID)
        expect(pending).toHaveLength(1)
        expect(pending[0]?.id).toBe(inputs[0])
        expect(pending[0]?.prompt.text).toBe(created.prompt)
      }),
    )
  }

  it.effect("durably admits, settles, notifies, and logically deletes a visible background job", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const created = yield* jobs.create(input("job-replay", now))
      const replay = yield* jobs.create(input("job-replay", now))

      expect(replay).toEqual(created)
      expect(created.visibility).toEqual({ mode: "background", label: "后台自动", userVisible: true })
      expect(created.status).toBe("queued")

      const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision, now })
      const completed = yield* jobs.recordResult({
        jobID: created.id,
        expectedRevision: running.revision,
        result: result(),
      })
      expect(completed.status).toBe("completed")
      expect(completed.result?.artifactRefs).toEqual([])
      expect((yield* jobs.notifications(created.id)).map((item) => item.kind)).toEqual(["completed"])

      const { db } = yield* Database.Service
      const events = yield* db
        .select({ type: EventTable.type, seq: EventTable.seq })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, created.id),
            eq(EventTable.type, EventV2.versionedType("personal.job.created", 1)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      expect(events).toEqual([{ type: "personal.job.created.1", seq: 0 }])

      yield* jobs.delete({ jobID: completed.id, expectedRevision: completed.revision, now })
      expect(yield* jobs.list({ sessionID })).toEqual([])
      expect(yield* Effect.flip(jobs.get(created.id))).toMatchObject({ _tag: "PersonalJob.NotFoundError" })
    }),
  )

  it.effect("the original result owner verifies the same canonical opaque receipt as its executor", () =>
    Effect.gen(function* () {
      const ownerSessionID = SessionV2.ID.make(`ses_personal_job_result_receipt_${testRun}`)
      yield* setupSession(ownerSessionID)
      const jobs = yield* PersonalJobV2.Service
      const created = yield* jobs.create(input("canonical-result-receipt", Date.now(), false, ownerSessionID))
      const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision })
      const artifactRef = OpaqueArtifact.make({
        version: 1,
        kind: "primary_delivery",
        digest: "c".repeat(64),
        mime: "text/markdown",
        sizeBytes: 128,
        owner: { scope: "session", id: ownerSessionID },
        retention: { mode: "session" },
        retrievalHint: { kind: "managed", handle: "artifact_personal_job" },
        createdAt: DateTime.makeUnsafe(0),
      })
      const artifact = PersonalJob.ResultArtifact.make({
        id: artifactRef.artifactID,
        artifactRef,
        kind: "primary_delivery",
        uri: "C:/fixture/report.md",
        name: "report.md",
        mime: artifactRef.mime,
        sizeBytes: artifactRef.sizeBytes,
        digest: artifactRef.digest,
      })
      const original = { ...result(), artifactRefs: [artifact.id], artifacts: [artifact] }
      const recorded = yield* jobs.recordResult({
        jobID: running.id,
        expectedRevision: running.revision,
        result: { ...original, digest: resultDigest(original) },
      })
      expect(recorded.status).toBe("completed")
      expect(recorded.result?.artifacts?.[0]?.artifactRef).toEqual(artifactRef)
      expect(yield* jobs.get(running.id)).toEqual(recorded)
    }),
  )

  it.effect("keeps approval and lifecycle mutations revisioned and fail-closed", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const pending = yield* jobs.create({
        ...input("job-approval", now),
        approvalPolicy: PersonalJob.ApprovalPolicy.make({ mode: "user_once", rationale: "review before running" }),
      })
      expect(pending.status).toBe("awaiting_approval")
      const approved = yield* jobs.approve({ jobID: pending.id, expectedRevision: pending.revision })
      const paused = yield* jobs.pause({ jobID: approved.id, expectedRevision: approved.revision })
      const resumed = yield* jobs.resume({ jobID: paused.id, expectedRevision: paused.revision })
      const cancelled = yield* jobs.cancel({
        jobID: resumed.id,
        expectedRevision: resumed.revision,
        reason: "user stop",
      })

      expect(cancelled.status).toBe("cancelled")
      expect(cancelled.revision).toBe(resumed.revision + 1)
      expect(
        yield* Effect.flip(jobs.start({ jobID: cancelled.id, expectedRevision: cancelled.revision, now })),
      ).toMatchObject({ _tag: "PersonalJob.InvalidStateError", action: "start" })
      expect(
        yield* Effect.flip(jobs.cancel({ jobID: cancelled.id, expectedRevision: resumed.revision })),
      ).toMatchObject({ _tag: "PersonalJob.StaleRevisionError", actualRevision: cancelled.revision })

      const eachRun = yield* jobs.create({
        ...input("job-each-run", now),
        approvalPolicy: PersonalJob.ApprovalPolicy.make({ mode: "user_each_run", rationale: "approve every run" }),
      })
      const eachRunApproved = yield* jobs.approve({ jobID: eachRun.id, expectedRevision: eachRun.revision })
      const eachRunStarted = yield* jobs.start({ jobID: eachRun.id, expectedRevision: eachRunApproved.revision, now })
      expect(eachRunStarted.approvalState).toBe("pending")
      const eachRunPaused = yield* jobs.pause({ jobID: eachRun.id, expectedRevision: eachRunStarted.revision })
      const eachRunResumed = yield* jobs.resume({ jobID: eachRun.id, expectedRevision: eachRunPaused.revision })
      expect(eachRunResumed.status).toBe("awaiting_approval")
      expect(
        yield* Effect.flip(jobs.start({ jobID: eachRun.id, expectedRevision: eachRunResumed.revision, now })),
      ).toMatchObject({ _tag: "PersonalJob.ApprovalError", action: "start" })
    }),
  )

  it.effect("heartbeats the execution fence and safely requeues an abandoned worker", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const created = yield* jobs.create(input("job-recovery", now))
      const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision, now })
      expect(running.execution?.leaseID).toMatch(/^pje_/)

      const heartbeat = yield* jobs.heartbeat({
        jobID: running.id,
        expectedRevision: running.revision,
        now: now + 1_000,
      })
      expect(heartbeat.revision).toBe(running.revision + 1)
      expect(heartbeat.occurrence).toEqual(running.occurrence)
      expect(DateTime.toEpochMillis(heartbeat.execution!.heartbeatAt)).toBe(now + 1_000)

      expect(
        yield* jobs.recover({
          now: now + 62_000,
          staleAfterMs: 60_000,
          sessionID,
        }),
      ).toBe(1)
      const recovered = yield* jobs.get(created.id)
      expect(recovered.status).toBe("queued")
      expect(recovered.execution).toBeUndefined()
      expect(recovered.occurrence).toEqual(running.occurrence)
      expect(recovered.lastError).toContain("重新排队")
    }),
  )

  it.effect("advances a recurring schedule only through durable tick", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const created = yield* jobs.create(input("job-recurring", now, true))
      const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision, now })
      const completed = yield* jobs.recordResult({
        jobID: running.id,
        expectedRevision: running.revision,
        result: result(),
      })

      expect(completed.status).toBe("completed")
      expect(yield* jobs.tick({ now: now + 2_000 })).toBe(1)
      const queued = yield* jobs.get(created.id)
      expect(queued.status).toBe("queued")
      expect(running.occurrence?.messageID).toBeDefined()
      expect(queued.occurrence?.messageID).toBeDefined()
      expect(queued.occurrence?.messageID).not.toBe(running.occurrence?.messageID)
      const nextRun = yield* jobs.start({ jobID: queued.id, expectedRevision: queued.revision, now: now + 2_000 })
      expect(nextRun.occurrence).toEqual(queued.occurrence)
      expect(DateTime.toEpochMillis(queued.schedule.nextRunAt)).toBeGreaterThan(now + 2_000)

      const cancelled = yield* jobs.create(input("job-recurring-cancel", now, true))
      const cancelledJob = yield* jobs.cancel({
        jobID: cancelled.id,
        expectedRevision: cancelled.revision,
        reason: "test",
      })
      expect(cancelledJob.status).toBe("cancelled")
      yield* jobs.tick({ now: now + 2_000 })
      expect((yield* jobs.get(cancelled.id)).status).toBe("cancelled")
    }),
  )

  it.effect("ticks due recurring jobs beyond an earlier non-recurring queue entry", () =>
    Effect.gen(function* () {
      yield* setupSession(isolatedSessionID)
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const queued = yield* jobs.create(input("job-tick-queued", now, false, isolatedSessionID))
      const recurring = yield* jobs.create(input("job-tick-recurring", now, true, isolatedSessionID))
      const running = yield* jobs.start({ jobID: recurring.id, expectedRevision: recurring.revision, now })
      const completed = yield* jobs.recordResult({
        jobID: recurring.id,
        expectedRevision: running.revision,
        result: result(),
      })

      expect(queued.status).toBe("queued")
      expect(completed.status).toBe("completed")
      expect(yield* jobs.tick({ sessionID: isolatedSessionID, now, limit: 1 })).toBe(1)
      expect((yield* jobs.get(recurring.id)).status).toBe("queued")
    }),
  )

  it.effect("dispatches a just-advanced recurring occurrence through the real start gate", () =>
    Effect.gen(function* () {
      yield* setupSession(dispatchSessionID)
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const created = yield* jobs.create(input("job-dispatch-recurring", now, true, dispatchSessionID))
      const firstRun = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision, now })
      const firstResult = yield* jobs.recordResult({
        jobID: firstRun.id,
        expectedRevision: firstRun.revision,
        result: result(),
      })

      const dispatched = yield* dispatchDueWith(
        {
          jobs,
          execute: ({ jobID, expectedRevision, allowEarly }) =>
            Effect.gen(function* () {
              const running = yield* jobs.start({ jobID, expectedRevision, now: now + 2_000, allowEarly })
              return yield* jobs.recordResult({
                jobID,
                expectedRevision: running.revision,
                result: result(),
              })
            }),
        },
        { now: now + 2_000, limit: 1, sessionID: dispatchSessionID },
      )

      expect(firstResult.status).toBe("completed")
      expect(dispatched).toMatchObject({ attempted: 1, completed: 1, failed: 0, skipped: 0 })
      expect((yield* jobs.get(created.id)).status).toBe("completed")
    }),
  )

  it.effect("allows only an explicit manual run to start before its saved schedule", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const future = yield* jobs.create({
        ...input("job-run-now", now),
        schedule: PersonalJob.Schedule.make({
          kind: "once",
          label: "later",
          nextRunAt: DateTime.makeUnsafe(now + 60_000),
          timezone: "UTC",
        }),
      })

      expect(
        yield* Effect.flip(jobs.start({ jobID: future.id, expectedRevision: future.revision, now })),
      ).toMatchObject({ _tag: "PersonalJob.ScheduleNotDueError" })

      const running = yield* jobs.start({
        jobID: future.id,
        expectedRevision: future.revision,
        now,
        allowEarly: true,
      })
      expect(running.status).toBe("running")
      expect(DateTime.toEpochMillis(running.schedule.nextRunAt)).toBe(now)
    }),
  )

  it.effect("stops an exhausted recurring job instead of leaving it permanently queued", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()
      const created = yield* jobs.create({
        ...input("job-recurring-budget-stop", now, true),
        budget: PersonalJob.BudgetLimits.make({ maxAttempts: 1, maxDurationMs: 60_000, maxCostMicros: 0 }),
        notificationPolicy: PersonalJob.NotificationPolicy.make({ mode: "in_app", events: ["budget_exhausted"] }),
      })
      const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision, now })
      const zeroCostResult = {
        status: "completed" as const,
        summary: "Completed without billable usage.",
        artifactRefs: [],
        usage: { durationMs: 10, costMicros: 0 },
      }
      const digest = canonicalHash(zeroCostResult)
      if (!digest) throw new Error("zero-cost result must be canonical")
      const completed = yield* jobs.recordResult({
        jobID: running.id,
        expectedRevision: running.revision,
        result: { ...zeroCostResult, digest },
      })

      expect(yield* jobs.tick({ now: now + 2_000, sessionID })).toBe(1)
      const stopped = yield* jobs.get(completed.id)
      expect(stopped.status).toBe("cancelled")
      expect(stopped.lastError).toContain("预算已用尽")
      expect(stopped.notifications.map((item) => item.kind)).toEqual(["budget_exhausted"])
    }),
  )

  it.effect("enforces credential scope, quiet hours, per-job budget, and retention", () =>
    Effect.gen(function* () {
      yield* setup
      const jobs = yield* PersonalJobV2.Service
      const now = Date.now()

      const missingCredential = yield* Effect.flip(
        jobs.create({
          ...input("job-missing-credential", now),
          credentialIDs: [Credential.ID.make("cred_missing_personal_job")],
        }),
      )
      expect(missingCredential).toMatchObject({ _tag: "PersonalJob.CredentialScopeError" })

      const quietNow = Date.UTC(2026, 0, 15, 12, 0)
      const quietJob = yield* jobs.create({
        ...input("job-quiet-hours", quietNow),
        quietHours: PersonalJob.QuietHours.make({ timezone: "UTC", startMinute: 0, endMinute: 1_439 }),
        notificationPolicy: PersonalJob.NotificationPolicy.make({ mode: "in_app", events: ["started"] }),
      })
      const quietStarted = yield* jobs.start({ jobID: quietJob.id, expectedRevision: quietJob.revision, now: quietNow })
      expect(DateTime.toEpochMillis(quietStarted.notifications[0].availableAt)).toBeGreaterThan(quietNow)

      const budgetJob = yield* jobs.create({
        ...input("job-budget", now),
        budget: PersonalJob.BudgetLimits.make({ maxAttempts: 1, maxDurationMs: 1_000, maxCostMicros: 10 }),
      })
      const budgetRunning = yield* jobs.start({ jobID: budgetJob.id, expectedRevision: budgetJob.revision, now })
      const invalidUsage = result()
      const invalidUsagePayload = { ...invalidUsage, usage: { durationMs: -1, costMicros: 1 } }
      const invalidUsageDigest = canonicalHash({
        status: invalidUsagePayload.status,
        summary: invalidUsagePayload.summary,
        artifactRefs: [...invalidUsagePayload.artifactRefs],
        usage: invalidUsagePayload.usage,
      })
      if (!invalidUsageDigest) throw new Error("invalid usage test result must be canonical")
      const invalidUsageError = yield* Effect.flip(
        jobs.recordResult({
          jobID: budgetRunning.id,
          expectedRevision: budgetRunning.revision,
          result: { ...invalidUsagePayload, digest: invalidUsageDigest },
        }),
      )
      expect(invalidUsageError).toMatchObject({ _tag: "PersonalJob.InvalidInputError" })
      const exhausted = yield* Effect.flip(
        jobs.recordResult({ jobID: budgetRunning.id, expectedRevision: budgetRunning.revision, result: result() }),
      )
      expect(exhausted).toMatchObject({ _tag: "PersonalJob.BudgetExhaustedError", jobID: budgetJob.id })

      const failedOverBudget = {
        status: "failed" as const,
        summary: "Provider reported a final charge above the estimate.",
        artifactRefs: [],
        usage: { durationMs: 1, costMicros: 11 },
      }
      const failedOverBudgetDigest = canonicalHash(failedOverBudget)
      if (!failedOverBudgetDigest) throw new Error("over-budget failure result must be canonical")
      const settledOverBudget = yield* jobs.recordResult({
        jobID: budgetRunning.id,
        expectedRevision: budgetRunning.revision,
        result: { ...failedOverBudget, digest: failedOverBudgetDigest },
      })
      expect(settledOverBudget.status).toBe("failed")
      expect(settledOverBudget.execution).toBeUndefined()
      expect(settledOverBudget.budget.costMicrosUsed).toBe(11)

      expect(yield* Effect.flip(jobs.tick({ now, limit: 0 }))).toMatchObject({
        _tag: "PersonalJob.InvalidInputError",
      })

      const retentionBase = Date.now()
      const retained = yield* jobs.create({
        ...input("job-retention", retentionBase),
        retainUntil: DateTime.makeUnsafe(retentionBase + 60_000),
      })
      const cancelled = yield* jobs.cancel({ jobID: retained.id, expectedRevision: retained.revision, reason: "test" })
      const retentionError = yield* Effect.flip(
        jobs.delete({ jobID: retained.id, expectedRevision: cancelled.revision, now: retentionBase }),
      )
      expect(retentionError).toMatchObject({ _tag: "PersonalJob.RetentionActiveError", jobID: retained.id })
    }),
  )

  it.effect("decodes legacy jobs without inventing an occurrence and refuses an unidentified retry", () =>
    Effect.gen(function* () {
      expect(PersonalJob.ID).toBe(PersonalJobInput.ID)
      expect(PersonalJob.Occurrence).toBe(PersonalJobInput.Occurrence)
      expect(PersonalJob.Digest).toBe(PersonalJobInput.Digest)
      const oldAdmission = { version: 1 as const, owner: "session-runner" as const, credentialIDs: null, billing: null }
      const admissionWire = Schema.encodeSync(AgentRuntime.SessionRunAdmission)({
        ...oldAdmission,
        personalJob: undefined,
      })
      expect(Object.hasOwn(admissionWire, "personalJob")).toBe(false)
      expect(Schema.decodeUnknownSync(AgentRuntime.SessionRunAdmission)(admissionWire)).toEqual(oldAdmission)
      const ownerSessionID = SessionV2.ID.make(`ses_personal_job_legacy_${testRun}`)
      yield* setupSession(ownerSessionID)
      const jobs = yield* PersonalJobV2.Service
      const events = yield* EventV2.Service
      const now = Date.now()
      const created = yield* jobs.create(input("legacy-occurrence", now, false, ownerSessionID))
      const wire = Schema.encodeSync(PersonalJob.Info)({ ...created, occurrence: undefined })
      expect(Object.hasOwn(wire, "occurrence")).toBe(false)
      expect(Schema.decodeUnknownSync(PersonalJob.Info)(wire).occurrence).toBeUndefined()
      const legacy: PersonalJob.Info = {
        ...created,
        status: "running",
        revision: created.revision + 1,
        budget: { ...created.budget, attemptsUsed: 1 },
        execution: { leaseID: "legacy-execution", heartbeatAt: DateTime.makeUnsafe(now - 62_000) },
        time: { ...created.time, started: DateTime.makeUnsafe(now - 62_000) },
      }
      yield* events.publish(PersonalJob.Event.Changed, {
        jobID: created.id,
        job: legacy,
        reason: "start",
        changedAt: legacy.time.updated,
      })
      expect(yield* jobs.recover({ sessionID: ownerSessionID, now })).toBe(1)
      const queued = yield* jobs.get(created.id)
      const error = yield* Effect.flip(jobs.start({ jobID: queued.id, expectedRevision: queued.revision, now }))
      expect(error).toMatchObject({ _tag: "PersonalJob.InvalidInputError" })
      expect(yield* jobs.get(created.id)).toEqual(queued)
    }),
  )

  for (const change of ["message", "digest", "drop", "prompt"] as const) {
    it.effect(`rejects occurrence ${change} drift while replaying the original job`, () =>
      Effect.gen(function* () {
        const ownerSessionID = SessionV2.ID.make(`ses_personal_job_corrupt_${change}_${testRun}`)
        yield* setupSession(ownerSessionID)
        const jobs = yield* PersonalJobV2.Service
        const events = yield* EventV2.Service
        const created = yield* jobs.create(input(`corrupt-${change}`, Date.now(), false, ownerSessionID))
        const running = yield* jobs.start({ jobID: created.id, expectedRevision: created.revision })
        if (!running.occurrence) return yield* Effect.die("Original occurrence missing")
        const prompt = change === "prompt" ? PersonalJob.Prompt.make("Different task") : running.prompt
        const messageID =
          change === "message" ? SessionMessage.ID.make("msg_wrong_occurrence") : running.occurrence.messageID
        const digest =
          change === "digest"
            ? "0".repeat(64)
            : canonicalHash({
                version: 1,
                jobID: running.id,
                sessionID: running.sessionID,
                prompt,
                messageID,
              })
        if (!digest) return yield* Effect.die("Fixture binding is not canonical")
        const corrupt: PersonalJob.Info = {
          ...running,
          revision: running.revision + 1,
          prompt,
          occurrence: change === "drop" ? undefined : { version: 1, messageID, digest },
        }
        yield* events.publish(PersonalJob.Event.Changed, {
          jobID: running.id,
          job: corrupt,
          reason: "heartbeat",
          changedAt: corrupt.time.updated,
        })
        const { db } = yield* Database.Service
        const before = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, running.id)).all()
        expect(yield* Effect.flip(jobs.get(running.id))).toMatchObject({ _tag: "PersonalJob.CorruptHistoryError" })
        expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, running.id)).all()).toEqual(before)
        return yield* Effect.void
      }),
    )
  }
})
