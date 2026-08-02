import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client organizes, checkpoints, and safely rewinds a session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-session-organization-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Agent, Arforge, Location, Session, SessionOrganization } = await import("../src")
  const sessionID = Session.ID.make(`ses_organization_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const tags = SessionOrganization.Tags.make([
        SessionOrganization.Tag.make("Fusion"),
        SessionOrganization.Tag.make("backend"),
      ])
      expect(yield* arforge.sessions.tagsUpdate({ sessionID, tags })).toEqual([...tags])
      expect((yield* arforge.sessions.get({ sessionID })).tags).toEqual([...tags])
      expect((yield* arforge.sessions.list({ tags: "fusion" })).data.map((item) => item.id)).toContain(sessionID)

      const checkpoint = yield* arforge.sessions.checkpointCreate({
        sessionID,
        label: SessionOrganization.CheckpointLabel.make("Before experiment"),
      })
      yield* arforge.sessions.switchAgent({ sessionID, agent: Agent.ID.make("reviewer") })
      const preview = yield* arforge.sessions.rewindPreview({ sessionID, checkpointID: checkpoint.id })
      expect(preview.affectedMessages).toBe(1)
      expect(preview.workspaceEffectsUnchanged).toBe(true)

      yield* arforge.sessions.switchAgent({ sessionID, agent: Agent.ID.make("builder") })
      expect(
        yield* Effect.flip(
          arforge.sessions.rewindApply({
            sessionID,
            checkpointID: checkpoint.id,
            expectedLastSequence: preview.expectedLastSequence,
          }),
        ),
      ).toMatchObject({ _tag: "ConflictError", resource: checkpoint.id })

      const current = yield* arforge.sessions.rewindPreview({ sessionID, checkpointID: checkpoint.id })
      const rewound = yield* arforge.sessions.rewindApply({
        sessionID,
        checkpointID: checkpoint.id,
        expectedLastSequence: current.expectedLastSequence,
      })
      expect(rewound).toMatchObject({
        rewoundMessages: 2,
        workspaceEffectsUnchanged: true,
      })
      expect(yield* arforge.sessions.context({ sessionID })).toEqual([])
      expect((yield* arforge.sessions.checkpointList({ sessionID })).map((item) => item.id)).toEqual([checkpoint.id])
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
