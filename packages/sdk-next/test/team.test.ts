import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@arforge-ai/core/flag/flag"
import { Effect } from "effect"

test("embedded client manages a session-scoped team without exposing member identity overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arforge-team-"))
  const database = Flag.ARFORGE_DB
  Flag.ARFORGE_DB = join(directory, "arforge.sqlite")
  const { AbsolutePath, Agent, Arforge, Location, Session, Team } = await import("../src")
  const sessionID = Session.ID.make(`ses_team_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const arforge = yield* Arforge.create()
      yield* arforge.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const created = yield* arforge.teams.create({
        sessionID,
        name: Team.Name.make("Embedded team"),
        description: Team.Description.make("SDK coverage"),
      })
      expect(created).toMatchObject({ sessionID, memberCount: 0, messageCount: 0 })

      const invalidRole = yield* Effect.flip(
        arforge.teams.memberAdd({
          sessionID,
          memberName: Team.CollaboratorName.make("worker"),
          agentID: Agent.ID.make("missing-subagent"),
        }),
      )
      expect(invalidRole).toMatchObject({ _tag: "InvalidRequestError", field: "agentID" })
      const member = yield* arforge.teams.memberAdd({
        sessionID,
        memberName: Team.CollaboratorName.make("worker"),
        agentID: Agent.ID.make("general"),
      })
      expect(member).toMatchObject({ name: "worker", agentID: "general", status: "active" })
      const sent = yield* arforge.teams.messageSend({
        sessionID,
        recipient: "worker",
        message: Team.MessageText.make("Inspect the implementation."),
        kind: "request",
      })
      expect(sent).toMatchObject({ sender: "lead", recipients: ["worker"], sequence: 1 })
      expect((yield* arforge.teams.messageList({ sessionID })).messages).toEqual([])

      const shutdown = yield* arforge.teams.shutdownRequest({
        sessionID,
        memberName: Team.CollaboratorName.make("worker"),
        reason: Team.ShutdownReason.make("handoff complete"),
      })
      expect(shutdown).toMatchObject({ member: "worker", status: "pending" })
      expect((yield* arforge.teams.get({ sessionID })).pendingShutdowns).toBe(1)
      expect(yield* Effect.flip(arforge.teams.delete({ sessionID }))).toMatchObject({ _tag: "ConflictError" })
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
