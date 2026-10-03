import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { DateTime, Effect } from "effect"

test("embedded client exposes a visible, revision-safe Personal Job lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-personal-job-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, PersonalJob, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_personal_job_${crypto.randomUUID()}`)
  const otherSessionID = Session.ID.make(`ses_personal_job_other_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* arforge.sessions.create({
        id: otherSessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })

      const created = yield* arforge.personalJobs.create({
        sessionID,
        idempotencyKey: `personal-job-${crypto.randomUUID()}`,
        title: "Visible nightly review",
        prompt: "Review the current implementation and report verified changes.",
        schedule: {
          kind: "cron",
          label: "每分钟审查",
          cron: "* * * * *",
          nextRunAt: DateTime.makeUnsafe(Date.now() - 1_000),
          timezone: "UTC",
        },
        budget: { maxAttempts: 2, maxDurationMs: 60_000, maxCostMicros: 10_000 },
        approvalPolicy: { mode: "user_once", rationale: "Review before background execution." },
        notificationPolicy: { mode: "in_app", events: ["started", "cancelled"] },
      })

      expect(created.visibility).toEqual({ mode: "background", label: "后台自动", userVisible: true })
      expect(created.status).toBe("awaiting_approval")
      expect((yield* arforge.personalJobs.list({ sessionID })).map((job) => job.id)).toEqual([created.id])

      const approved = yield* arforge.personalJobs.approve({
        sessionID,
        jobID: created.id,
        expectedRevision: created.revision,
      })
      const staleExecution = yield* Effect.flip(
        arforge.personalJobs.execute({ sessionID, jobID: created.id, expectedRevision: created.revision }),
      )
      expect(staleExecution._tag).toBe("ConflictError")
      const notifications = yield* arforge.personalJobs.notifications({ sessionID, jobID: created.id })
      expect(notifications.map((item) => item.kind)).toEqual(["started"])
      const read = yield* arforge.personalJobs.notificationRead({
        sessionID,
        jobID: created.id,
        notificationID: notifications[0]!.id,
        expectedRevision: approved.revision,
      })
      expect(yield* arforge.personalJobs.notifications({ sessionID, jobID: created.id })).toEqual([])

      const running = yield* arforge.personalJobs.start({
        sessionID,
        jobID: created.id,
        expectedRevision: read.revision,
      })
      const paused = yield* arforge.personalJobs.pause({
        sessionID,
        jobID: created.id,
        expectedRevision: running.revision,
      })
      const resumed = yield* arforge.personalJobs.resume({
        sessionID,
        jobID: created.id,
        expectedRevision: paused.revision,
      })
      const cancelled = yield* arforge.personalJobs.cancel({
        sessionID,
        jobID: created.id,
        expectedRevision: resumed.revision,
        reason: "user stop",
      })
      expect(cancelled.status).toBe("cancelled")

      const wrongSession = yield* Effect.flip(
        arforge.personalJobs.get({ sessionID: otherSessionID, jobID: created.id }),
      )
      expect(wrongSession._tag).toBe("PersonalJobNotFoundError")

      yield* arforge.personalJobs.delete({
        sessionID,
        jobID: created.id,
        expectedRevision: cancelled.revision,
      })
      expect(yield* arforge.personalJobs.list({ sessionID })).toEqual([])
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ARFORGE_DB = database
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15_000)
