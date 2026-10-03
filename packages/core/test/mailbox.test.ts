import { describe, expect } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Mailbox } from "@arforge-ai/schema/mailbox"
import { Effect, Schema } from "effect"
import { AgentV2 } from "@arforge-ai/core/agent"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { MailboxV2 } from "@arforge-ai/core/mailbox"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import { TeamV2 } from "@arforge-ai/core/team"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_mailbox_protocol")
const coderAgent = AgentV2.ID.make("mailbox-coder")
const testerAgent = AgentV2.ID.make("mailbox-tester")
const observerAgent = AgentV2.ID.make("mailbox-observer")
const budget = AgentRuntime.Budget.make({
  maxAttempts: 3,
  maxDurationMs: 60_000,
  maxCostMicros: 100_000,
  maxTokens: 1_000_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      AgentV2.node,
      TaskGraphV2.node,
      TeamV2.node,
      DurableRun.node,
      MailboxV2.node,
    ]),
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "mailbox-protocol",
      directory: "/project",
      title: "mailbox protocol",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* AgentV2.Service
  yield* agents.transform((editor) => {
    editor.update(coderAgent, (agent) => {
      agent.mode = "subagent"
    })
    editor.update(testerAgent, (agent) => {
      agent.mode = "subagent"
    })
    editor.update(observerAgent, (agent) => {
      agent.mode = "subagent"
    })
  })
})

const fixture = Effect.gen(function* () {
  yield* setup
  const teams = yield* TeamV2.Service
  const team = yield* teams.create({
    sessionID,
    name: TeamV2.Name.make("Mailbox Team"),
    description: TeamV2.Description.make("canonical collaboration fixture"),
  })
  yield* teams.addMember({
    sessionID,
    name: TeamV2.CollaboratorName.make("coder"),
    agentID: coderAgent,
  })
  yield* teams.addMember({
    sessionID,
    name: TeamV2.CollaboratorName.make("tester"),
    agentID: testerAgent,
  })
  yield* teams.addMember({
    sessionID,
    name: TeamV2.CollaboratorName.make("observer"),
    agentID: observerAgent,
  })
  const tasks = yield* TaskGraphV2.Service
  const task = yield* tasks.create({
    sessionID,
    title: TaskGraphV2.Title.make("mailbox task"),
  })
  const durableRuns = yield* DurableRun.Service
  const run = yield* durableRuns.create({
    sessionID,
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "mailbox protocol fixture",
    budget,
    traceID: "trace-mailbox-protocol",
    visibility: "details",
  })
  return {
    team,
    task,
    runID: run.run.id,
    coder: TeamV2.MemberName.make("coder"),
    tester: TeamV2.MemberName.make("tester"),
    observer: TeamV2.MemberName.make("observer"),
  }
})

const payload = (text = "ready") =>
  MailboxV2.Payload.make({
    summary: "protocol update",
    text,
    artifactRefs: [AgentRuntime.ArtifactID.make("art_mailbox_test")],
    evidenceRefs: [AgentRuntime.EvidenceID.make("evd_mailbox_test")],
  })

const sendInput = (
  fixture: {
    team: TeamV2.Info
    task: TaskGraphV2.Info
    runID: AgentRuntime.RunID
    coder: TeamV2.MemberName
    tester: TeamV2.MemberName
  },
  idempotencyKey: string,
  text = "ready",
) => ({
  teamID: fixture.team.id,
  runID: fixture.runID,
  taskID: fixture.task.id,
  sender: fixture.coder,
  recipient: fixture.tester,
  idempotencyKey: MailboxV2.IdempotencyKey.make(idempotencyKey),
  kind: MailboxV2.Kind.make("request"),
  payload: payload(text),
})

describe("MailboxV2", () => {
  it.effect("binds messages to team/run/task, redacts payloads, and keeps inboxes addressed", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const first = yield* mailbox.send(sendInput(fixtureValue, "message-1", "api_key=supersecret"))
      expect(first.teamID).toBe(fixtureValue.team.id)
      expect(first.runID).toBe(fixtureValue.runID)
      expect(first.taskID).toBe(fixtureValue.task.id)
      expect(first.payload.text).not.toContain("supersecret")
      expect(first.payload.text).toContain("[REDACTED_SECRET]")
      expect(first.payload.artifactRefs).toEqual([AgentRuntime.ArtifactID.make("art_mailbox_test")])
      expect(first.payload.evidenceRefs).toEqual([AgentRuntime.EvidenceID.make("evd_mailbox_test")])

      const testerInbox = yield* mailbox.list({
        teamID: fixtureValue.team.id,
        runID: fixtureValue.runID,
        taskID: fixtureValue.task.id,
        recipient: fixtureValue.tester,
      })
      expect(testerInbox.count).toBe(1)
      expect(testerInbox.messages[0]?.id).toBe(first.id)
      const coderInbox = yield* mailbox.list({
        teamID: fixtureValue.team.id,
        runID: fixtureValue.runID,
        taskID: fixtureValue.task.id,
        recipient: fixtureValue.coder,
      })
      expect(coderInbox.count).toBe(0)

      const invalidTask = TaskGraphV2.ID.make("tsk_not_bound")
      const invalidBinding = yield* Effect.flip(
        mailbox.send({ ...sendInput(fixtureValue, "message-invalid"), taskID: invalidTask }),
      )
      expect(invalidBinding).toBeInstanceOf(MailboxV2.InvalidBindingError)
    }),
  )

  it.effect("provides deterministic send idempotency, bounded concurrency, and durable acknowledgements", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const first = yield* mailbox.send(sendInput(fixtureValue, "replay-key"))
      const replay = yield* mailbox.send(sendInput(fixtureValue, "replay-key"))
      expect(replay).toEqual(first)

      const concurrent = yield* Effect.forEach(
        ["concurrent-1", "concurrent-2", "concurrent-3"],
        (key) => mailbox.send(sendInput(fixtureValue, key)),
        { concurrency: 3 },
      )
      expect(new Set([first.sequence, ...concurrent.map((message) => message.sequence)]).size).toBe(4)

      const conflict = yield* Effect.flip(mailbox.send(sendInput(fixtureValue, "replay-key", "different payload")))
      expect(conflict).toBeInstanceOf(MailboxV2.MessageConflictError)

      const receipt = yield* mailbox.acknowledge({
        messageID: first.id,
        recipient: fixtureValue.tester,
        status: "accepted",
      })
      const receiptReplay = yield* mailbox.acknowledge({
        messageID: first.id,
        recipient: fixtureValue.tester,
        status: "accepted",
      })
      expect(receiptReplay).toEqual(receipt)
      const delivery = yield* mailbox.inspect({
        messageID: first.id,
        actor: fixtureValue.coder,
      })
      expect(delivery.message.status).toBe("acknowledged")
      expect(delivery.receipt).toEqual(receipt)
      const unauthorizedInspection = yield* Effect.flip(
        mailbox.inspect({
          messageID: first.id,
          actor: fixtureValue.observer,
        }),
      )
      expect(unauthorizedInspection).toBeInstanceOf(MailboxV2.UnauthorizedMailboxActionError)
      const receiptConflict = yield* Effect.flip(
        mailbox.acknowledge({
          messageID: first.id,
          recipient: fixtureValue.tester,
          status: "rejected",
          reason: Mailbox.Reason.make("not accepted"),
        }),
      )
      expect(receiptConflict).toBeInstanceOf(MailboxV2.ReceiptConflictError)

      const inbox = yield* mailbox.list({
        teamID: fixtureValue.team.id,
        runID: fixtureValue.runID,
        taskID: fixtureValue.task.id,
        recipient: fixtureValue.tester,
      })
      expect(inbox.messages.find((message) => message.id === first.id)?.status).toBe("acknowledged")

      const durableRuns = yield* DurableRun.Service
      yield* durableRuns.cancel({ runID: fixtureValue.runID, reason: "close after acknowledgement" })
      expect(yield* mailbox.send(sendInput(fixtureValue, "replay-key"))).toEqual(delivery.message)
      expect(
        yield* mailbox.acknowledge({
          messageID: first.id,
          recipient: fixtureValue.tester,
          status: "accepted",
        }),
      ).toEqual(receipt)
    }),
  )

  it.effect("fails closed when task or member shutdown closes the collaboration gate", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const tasks = yield* TaskGraphV2.Service
      const message = yield* mailbox.send(sendInput(fixtureValue, "cancel-after-task"))
      const cancelledTask = yield* tasks.cancel({
        sessionID,
        taskID: fixtureValue.task.id,
        expectedRevision: fixtureValue.task.revision,
      })
      expect(cancelledTask.status).toBe("cancelled")

      const taskClosed = yield* Effect.flip(mailbox.send(sendInput(fixtureValue, "task-closed")))
      expect(taskClosed).toBeInstanceOf(MailboxV2.TaskClosedError)
      const cancelledMessage = yield* mailbox.cancel({
        messageID: message.id,
        actor: fixtureValue.coder,
        reason: Mailbox.Reason.make("task cancelled"),
      })
      expect(cancelledMessage.status).toBe("cancelled")
      const cancelledDelivery = yield* mailbox.inspect({
        messageID: message.id,
        actor: fixtureValue.coder,
      })
      expect(cancelledDelivery.receipt?.status).toBe("cancelled")
      expect(cancelledDelivery.receipt?.reason).toBe("task cancelled")
    }),
  )

  it.effect("closes delivery to a member after a durable shutdown request", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const teams = yield* TeamV2.Service
      yield* mailbox.send(sendInput(fixtureValue, "shutdown-before-send"))
      yield* teams.requestShutdown({
        sessionID,
        member: TeamV2.CollaboratorName.make("tester"),
      })
      const memberClosed = yield* Effect.flip(mailbox.send(sendInput(fixtureValue, "shutdown-closed")))
      expect(memberClosed).toBeInstanceOf(MailboxV2.MemberInactiveError)
    }),
  )

  it.effect("fails closed after the owning durable run is cancelled", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const durableRuns = yield* DurableRun.Service
      const queued = yield* mailbox.send(sendInput(fixtureValue, "inspect-after-run-close"))
      const cancelled = yield* durableRuns.cancel({
        runID: fixtureValue.runID,
        reason: "cancel mailbox run",
      })
      expect(cancelled.run.status).toBe("cancelled")
      expect(yield* mailbox.send(sendInput(fixtureValue, "inspect-after-run-close"))).toEqual(queued)
      const runClosed = yield* Effect.flip(mailbox.send(sendInput(fixtureValue, "run-closed")))
      expect(runClosed).toBeInstanceOf(MailboxV2.RunClosedError)
      const historical = yield* mailbox.inspect({
        messageID: queued.id,
        actor: fixtureValue.coder,
      })
      expect(historical.message).toEqual(queued)
      expect(historical.receipt).toBeUndefined()
    }),
  )

  it.effect("does not treat chat text as a capability field", () =>
    Effect.gen(function* () {
      const value = {
        ...payload("ordinary text"),
        capabilities: ["filesystem:write"],
      }
      expect(() => Schema.decodeUnknownSync(Mailbox.Payload, { onExcessProperty: "error" })(value)).toThrow()
    }),
  )

  it.effect("does not persist secret-like idempotency keys", () =>
    Effect.gen(function* () {
      const fixtureValue = yield* fixture
      const mailbox = yield* MailboxV2.Service
      const rejected = yield* Effect.flip(
        mailbox.send({
          ...sendInput(fixtureValue, "safe-key"),
          idempotencyKey: MailboxV2.IdempotencyKey.make("api_key=supersecret"),
        }),
      )
      expect(rejected).toBeInstanceOf(MailboxV2.PayloadRejectedError)
    }),
  )
})
