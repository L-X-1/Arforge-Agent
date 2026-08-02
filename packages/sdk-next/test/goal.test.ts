import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client persists and validates the autonomous goal lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-goal-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Goal, Location, Arforge, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_goal_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const first = yield* arforge.goals.create({
        sessionID,
        objective: Goal.Objective.make("Finish the native fusion"),
      })
      const second = yield* arforge.goals.create({
        sessionID,
        objective: Goal.Objective.make("Verify the native fusion"),
      })
      const page = yield* arforge.goals.list({ sessionID })
      const replaced = yield* arforge.goals.replace({
        sessionID,
        goalID: second.id,
        expectedRevision: second.revision,
        objective: Goal.Objective.make("Verify every fusion boundary"),
      })
      const stale = yield* Effect.flip(
        arforge.goals.replace({
          sessionID,
          goalID: second.id,
          expectedRevision: second.revision,
          objective: Goal.Objective.make("This stale update must fail"),
        }),
      )

      expect(first.status).toBe("active")
      expect(second.status).toBe("queued")
      expect(page.active?.id).toBe(first.id)
      expect(page.queued.map((goal) => goal.id)).toEqual([second.id])
      expect(replaced).toMatchObject({
        objective: "Verify every fusion boundary",
        revision: second.revision + 1,
      })
      expect(stale).toMatchObject({
        _tag: "ConflictError",
        resource: second.id,
      })
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
