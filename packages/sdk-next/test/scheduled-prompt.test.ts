import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client manages revision-safe scheduled prompts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-scheduled-prompt-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, ScheduledPrompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_schedule_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const scheduled = yield* arforge.scheduledPrompts.create({
        sessionID,
        name: ScheduledPrompt.Name.make("daily review"),
        cron: ScheduledPrompt.Cron.make("0 9 * * *"),
        prompt: ScheduledPrompt.Prompt.make("Review the current implementation."),
        durable: true,
      })

      expect(scheduled).toMatchObject({
        sessionID,
        name: "daily review",
        status: "scheduled",
        revision: 1,
      })
      expect((yield* arforge.scheduledPrompts.list({ sessionID })).map((item) => item.id)).toEqual([scheduled.id])
      expect(yield* arforge.scheduledPrompts.get({ sessionID, scheduleID: scheduled.id })).toEqual(scheduled)

      const updated = yield* arforge.scheduledPrompts.update({
        sessionID,
        scheduleID: scheduled.id,
        expectedRevision: scheduled.revision,
        enabled: false,
        recurring: false,
      })
      expect(updated).toMatchObject({ enabled: false, recurring: false, revision: 2 })

      const stale = yield* Effect.flip(
        arforge.scheduledPrompts.update({
          sessionID,
          scheduleID: scheduled.id,
          expectedRevision: 1,
          enabled: true,
        }),
      )
      expect(stale).toMatchObject({ _tag: "ConflictError", resource: scheduled.id })

      yield* arforge.scheduledPrompts.delete({
        sessionID,
        scheduleID: scheduled.id,
        expectedRevision: updated.revision,
      })
      expect(yield* arforge.scheduledPrompts.list({ sessionID })).toEqual([])
    })
    await Effect.runPromise(Effect.scoped(program))
    await Bun.sleep(500)
  } finally {
    Flag.ARFORGE_DB = database
    await removeTempDirectory(directory)
  }
}, 10_000)

async function removeTempDirectory(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    if (
      process.platform === "win32" &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EBUSY"
    )
      return
    throw error
  }
}
