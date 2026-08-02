import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client preserves task dependencies, claims, and revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-task-graph-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Arforge, Location, Session, TaskGraph } = await import("../src")
  const sessionID = Session.ID.make(`ses_task_graph_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const design = yield* arforge.tasks.create({
        sessionID,
        title: TaskGraph.Title.make("Design protocol"),
      })
      const implementation = yield* arforge.tasks.create({
        sessionID,
        title: TaskGraph.Title.make("Implement protocol"),
        blockedBy: [design.id],
      })

      expect(implementation).toMatchObject({
        blockedBy: [design.id],
        unresolvedBlockers: 1,
        status: "pending",
      })
      expect(yield* arforge.tasks.get({ sessionID, taskID: design.id })).toMatchObject({
        blocks: [implementation.id],
      })

      const blocked = yield* Effect.flip(
        arforge.tasks.claim({
          sessionID,
          taskID: implementation.id,
          expectedRevision: implementation.revision,
          owner: TaskGraph.Owner.make("worker-1"),
        }),
      )
      expect(blocked).toMatchObject({ _tag: "ConflictError", resource: implementation.id })

      const completed = yield* arforge.tasks.complete({
        sessionID,
        taskID: design.id,
        expectedRevision: design.revision,
      })
      expect(completed).toMatchObject({ status: "completed", revision: 2 })
      const claimed = yield* arforge.tasks.claim({
        sessionID,
        taskID: implementation.id,
        expectedRevision: implementation.revision,
        owner: TaskGraph.Owner.make("worker-1"),
      })
      expect(claimed).toMatchObject({
        owner: "worker-1",
        status: "in_progress",
        unresolvedBlockers: 0,
      })

      const stale = yield* Effect.flip(
        arforge.tasks.update({
          sessionID,
          taskID: implementation.id,
          expectedRevision: implementation.revision,
          description: TaskGraph.Description.make("stale mutation"),
        }),
      )
      expect(stale).toMatchObject({ _tag: "ConflictError", resource: implementation.id })
      expect((yield* arforge.tasks.list({ sessionID })).total).toBe(2)
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
