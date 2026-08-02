import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

const originalDisableFileWatcher = process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER
if (process.platform === "win32") process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
afterAll(() => {
  if (originalDisableFileWatcher === undefined) delete process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER
  else process.env.ARFORGE_EXPERIMENTAL_DISABLE_FILEWATCHER = originalDisableFileWatcher
})

test("embedded feedback API redacts before local storage and reverses linked learning on delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-feedback-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_feedback_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      const location = { directory }
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const secret = `sk-${"S".repeat(38)}`
      const submitted = yield* arforge.feedback.submit({
        location,
        category: "bug",
        rating: 1,
        message: `Search failed with api_key=${secret}`,
        sessionID,
      })
      yield* arforge.feedback.submit({
        location,
        category: "feature",
        rating: 5,
        message: "Add a compact report",
      })
      const listed = yield* arforge.feedback.list({ location, limit: 10 })
      const summary = yield* arforge.feedback.summary({ location })
      const learningBefore = yield* arforge.learning.status({ location })
      const deleted = yield* arforge.feedback.delete({ location, feedbackID: submitted.feedback.id })
      const missing = yield* arforge.feedback.delete({ location, feedbackID: submitted.feedback.id })
      const learningAfter = yield* arforge.learning.status({ location })

      expect(submitted.storedLocally).toBe(true)
      expect(submitted.feedback.message).not.toContain(secret)
      expect(submitted.feedback.message).toContain("[REDACTED_SECRET]")
      expect(submitted.feedback.learningOutcomeID).toBeDefined()
      expect(listed.items.map((item) => item.category)).toEqual(["feature", "bug"])
      expect(summary).toMatchObject({ total: 2, averageRating: 3, storedLocally: true })
      expect(learningBefore.totalTurns).toBe(2)
      expect(deleted.status).toBe("deleted")
      expect(missing.status).toBe("not_found")
      expect(learningAfter.totalTurns).toBe(1)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ARFORGE_DB = database
    await cleanup(directory)
  }
})

async function cleanup(directory: string) {
  Bun.gc(true)
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      const transient =
        process.platform === "win32" &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
      if (!transient || attempt >= 5) throw error
      Bun.gc(true)
      await Bun.sleep(100 * (attempt + 1))
    }
  }
}
