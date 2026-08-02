import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TeamV2 } from "@arforge-ai/core/team"
import { testEffect } from "./lib/effect"

const sessionA = SessionV2.ID.make("ses_team_a")
const sessionB = SessionV2.ID.make("ses_team_b")
const coder = AgentV2.ID.make("coder")
const tester = AgentV2.ID.make("tester")

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, AgentV2.node, TeamV2.node])),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values([
      {
        id: sessionA,
        project_id: Project.ID.global,
        slug: "team-a",
        directory: "/project",
        title: "team-a",
        version: "test",
      },
      {
        id: sessionB,
        project_id: Project.ID.global,
        slug: "team-b",
        directory: "/project",
        title: "team-b",
        version: "test",
      },
    ])
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) => {
    editor.update(coder, (agent) => {
      agent.mode = "subagent"
    })
    editor.update(tester, (agent) => {
      agent.mode = "subagent"
    })
  })
})

describe("Team", () => {
  it.effect("owns one durable bounded team and binds unique subagent roles", () =>
    Effect.gen(function* () {
      yield* setup
      const teams = yield* TeamV2.Service
      const created = yield* teams.create({
        sessionID: sessionA,
        name: TeamV2.Name.make("Release Team"),
        description: TeamV2.Description.make("prepare release"),
      })
      expect(created).toMatchObject({ memberCount: 0, messageCount: 0, nextSequence: 1 })
      expect(yield* Effect.flip(teams.create({ sessionID: sessionA, name: TeamV2.Name.make("Other") }))).toBeInstanceOf(
        TeamV2.ExistsError,
      )

      const member = yield* teams.addMember({
        sessionID: sessionA,
        name: TeamV2.CollaboratorName.make("Coder"),
        agentID: coder,
      })
      expect(member).toMatchObject({ name: "Coder", agentID: coder, status: "active" })
      expect(
        yield* Effect.flip(
          teams.addMember({
            sessionID: sessionA,
            name: TeamV2.CollaboratorName.make("coder"),
            agentID: tester,
          }),
        ),
      ).toBeInstanceOf(TeamV2.MemberExistsError)
      expect(
        yield* Effect.flip(
          teams.addMember({
            sessionID: sessionA,
            name: TeamV2.CollaboratorName.make("tester"),
            agentID: coder,
          }),
        ),
      ).toBeInstanceOf(TeamV2.RoleInUseError)
      expect(yield* teams.resolveActor({ sessionID: sessionA, agentID: coder })).toBe("Coder")
      expect((yield* teams.get(sessionA)).members.map((item) => item.name)).toEqual(["lead", "Coder"])
    }),
  )

  it.effect("isolates direct and broadcast inboxes by team member and session", () =>
    Effect.gen(function* () {
      yield* setup
      const teams = yield* TeamV2.Service
      yield* teams.create({ sessionID: sessionA, name: TeamV2.Name.make("Alpha") })
      yield* teams.addMember({ sessionID: sessionA, name: TeamV2.CollaboratorName.make("coder"), agentID: coder })
      yield* teams.addMember({ sessionID: sessionA, name: TeamV2.CollaboratorName.make("tester"), agentID: tester })
      yield* teams.create({ sessionID: sessionB, name: TeamV2.Name.make("Beta") })
      yield* teams.addMember({ sessionID: sessionB, name: TeamV2.CollaboratorName.make("other"), agentID: coder })

      const direct = yield* teams.sendMessage({
        sessionID: sessionA,
        recipient: "coder",
        message: TeamV2.MessageText.make("implement feature"),
      })
      const broadcast = yield* teams.sendMessage({
        sessionID: sessionA,
        recipient: "*",
        message: TeamV2.MessageText.make("status check"),
        kind: "request",
      })
      expect(direct.recipients).toEqual(["coder"])
      expect(broadcast.recipients).toEqual(["coder", "tester"])
      expect(
        (yield* teams.listMessages({ sessionID: sessionA, actor: TeamV2.MemberName.make("coder") })).messages.map(
          (item) => item.message,
        ),
      ).toEqual(["implement feature", "status check"])
      expect(
        (yield* teams.listMessages({ sessionID: sessionA, actor: TeamV2.MemberName.make("tester") })).messages.map(
          (item) => item.message,
        ),
      ).toEqual(["status check"])
      expect(
        (yield* teams.listMessages({ sessionID: sessionB, actor: TeamV2.MemberName.make("other") })).messages,
      ).toEqual([])
      expect(
        yield* Effect.flip(
          teams.sendMessage({
            sessionID: sessionB,
            recipient: "tester",
            message: TeamV2.MessageText.make("cross-team attempt"),
          }),
        ),
      ).toBeInstanceOf(TeamV2.MemberNotFoundError)
    }),
  )

  it.effect("requires the member's explicit shutdown approval before removal", () =>
    Effect.gen(function* () {
      yield* setup
      const teams = yield* TeamV2.Service
      yield* teams.create({ sessionID: sessionA, name: TeamV2.Name.make("Team") })
      yield* teams.addMember({ sessionID: sessionA, name: TeamV2.CollaboratorName.make("coder"), agentID: coder })

      expect(
        yield* Effect.flip(
          teams.removeMember({ sessionID: sessionA, member: TeamV2.CollaboratorName.make("coder") }),
        ),
      ).toBeInstanceOf(TeamV2.InvalidStateError)
      const first = yield* teams.requestShutdown({
        sessionID: sessionA,
        member: TeamV2.CollaboratorName.make("coder"),
        reason: TeamV2.ShutdownReason.make("work complete"),
      })
      expect(
        yield* Effect.flip(
          teams.respondShutdown({
            sessionID: sessionA,
            shutdownID: first.id,
            approve: true,
            actor: TeamV2.MemberName.make("lead"),
          }),
        ),
      ).toBeInstanceOf(TeamV2.AccessDeniedError)
      const rejected = yield* teams.respondShutdown({
        sessionID: sessionA,
        shutdownID: first.id,
        approve: false,
        reason: TeamV2.ShutdownReason.make("tests still running"),
        actor: TeamV2.MemberName.make("coder"),
      })
      expect(rejected.status).toBe("rejected")
      expect((yield* teams.get(sessionA)).members[1]).toMatchObject({ status: "active" })

      const second = yield* teams.requestShutdown({
        sessionID: sessionA,
        member: TeamV2.CollaboratorName.make("coder"),
      })
      expect(
        yield* teams.respondShutdown({
          sessionID: sessionA,
          shutdownID: second.id,
          approve: true,
          actor: TeamV2.MemberName.make("coder"),
        }),
      ).toMatchObject({ status: "approved" })
      yield* teams.removeMember({ sessionID: sessionA, member: TeamV2.CollaboratorName.make("coder") })
      expect(yield* teams.delete({ sessionID: sessionA })).toEqual(expect.stringMatching(/^team_/))
      expect(yield* teams.hasTeam(sessionA)).toBe(false)
    }),
  )

  it.effect("reserves unique monotonic mailbox sequences under concurrent sends", () =>
    Effect.gen(function* () {
      yield* setup
      const teams = yield* TeamV2.Service
      yield* teams.create({ sessionID: sessionA, name: TeamV2.Name.make("Concurrent") })
      yield* teams.addMember({ sessionID: sessionA, name: TeamV2.CollaboratorName.make("coder"), agentID: coder })
      const sent = yield* Effect.forEach(
        Array.from({ length: 40 }, (_, index) => index),
        (index) =>
          teams.sendMessage({
            sessionID: sessionA,
            recipient: "coder",
            message: TeamV2.MessageText.make(`message-${index}`),
          }),
        { concurrency: 8 },
      )
      expect(sent.map((message) => message.sequence).sort((left, right) => left - right)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      )
      expect(new Set(sent.map((message) => message.id)).size).toBe(40)
      expect(
        (yield* teams.listMessages({
          sessionID: sessionA,
          actor: TeamV2.MemberName.make("coder"),
          limit: 100,
        })).count,
      ).toBe(40)
    }),
  )

  it.effect("enforces the eight-collaborator and 500-message retention bounds", () =>
    Effect.gen(function* () {
      yield* setup
      const teams = yield* TeamV2.Service
      const agents = yield* AgentV2.Service
      const roles = Array.from({ length: 9 }, (_, index) => AgentV2.ID.make(`worker-${index + 1}`))
      yield* agents.transform((editor) => {
        for (const role of roles)
          editor.update(role, (agent) => {
            agent.mode = "subagent"
          })
      })
      yield* teams.create({ sessionID: sessionA, name: TeamV2.Name.make("Bounded") })
      for (const [index, role] of roles.slice(0, 8).entries())
        yield* teams.addMember({
          sessionID: sessionA,
          name: TeamV2.CollaboratorName.make(`member${index + 1}`),
          agentID: role,
        })
      expect(
        yield* Effect.flip(
          teams.addMember({
            sessionID: sessionA,
            name: TeamV2.CollaboratorName.make("overflow"),
            agentID: roles[8]!,
          }),
        ),
      ).toBeInstanceOf(TeamV2.LimitError)

      yield* Effect.forEach(
        Array.from({ length: 505 }, (_, index) => index),
        (index) =>
          teams.sendMessage({
            sessionID: sessionA,
            recipient: "member1",
            message: TeamV2.MessageText.make(`bounded-${index}`),
          }),
        { concurrency: 16, discard: true },
      )
      expect((yield* teams.get(sessionA)).messageCount).toBe(500)
      const inbox = yield* teams.listMessages({
        sessionID: sessionA,
        actor: TeamV2.MemberName.make("member1"),
        limit: 100,
      })
      expect(inbox.count).toBe(100)
      expect(inbox.messages[0]?.sequence).toBe(6)
    }),
  )
})
