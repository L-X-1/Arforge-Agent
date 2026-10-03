import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { DateTime, Effect } from "effect"

test("embedded client exposes a bounded safe Personal Workspace projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-personal-workspace-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, Session, TaskGraph } = await import("../src")
  const sessionID = Session.ID.make(`ses_personal_workspace_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const task = yield* arforge.tasks.create({
        sessionID,
        title: TaskGraph.Title.make("Review projection boundary"),
      })
      yield* arforge.tasks.create({
        sessionID,
        title: TaskGraph.Title.make("Keep projection bounded"),
      })
      const job = yield* arforge.personalJobs.create({
        sessionID,
        idempotencyKey: `workspace-job-${crypto.randomUUID()}`,
        title: "Visible workspace review",
        prompt: "This prompt must never be returned by the workspace projection.",
        schedule: {
          kind: "once",
          label: "一次性审查",
          nextRunAt: DateTime.makeUnsafe(Date.now() + 60_000),
          timezone: "UTC",
        },
        budget: { maxAttempts: 1, maxDurationMs: 30_000, maxCostMicros: 2_000 },
        approvalPolicy: { mode: "user_once", rationale: "Require a human review." },
      })

      const view = yield* arforge.personalWorkspace.snapshot({ location: { directory }, limit: 50 })
      expect(view.sessions).toContainEqual(
        expect.objectContaining({ id: sessionID, state: "needs_human", attentionCount: 1 }),
      )
      expect(view.tasks).toContainEqual(expect.objectContaining({ id: task.id, title: task.title }))
      expect(view.personalJobs).toContainEqual(
        expect.objectContaining({
          id: job.id,
          visibility: { mode: "background", label: "后台自动", userVisible: true },
          approvalState: "pending",
          needsHuman: true,
        }),
      )
      expect(view.attention).toContainEqual(expect.objectContaining({ kind: "pending_approval", resourceID: job.id }))
      expect(view.personalJobs[0]).not.toHaveProperty("prompt")
      expect(view.personalJobs[0]).not.toHaveProperty("credentialIDs")
      expect(view.runs.every((run) => !("lease" in run) && !("subject" in run))).toBe(true)
      expect(view.project.directory).toBeDefined()

      const bounded = yield* arforge.personalWorkspace.snapshot({ location: { directory }, limit: 1 })
      expect(bounded.sessions).toHaveLength(1)
      expect(bounded.tasks).toHaveLength(1)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ARFORGE_DB = database
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
