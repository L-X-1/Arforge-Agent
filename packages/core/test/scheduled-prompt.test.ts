import { describe, expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { PromptInput } from "@arforge-ai/schema/prompt-input"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { SessionInputTable, ScheduledPromptTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { testEffect } from "./lib/effect"

const active = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    exclusive: () => Effect.die(new Error("Exclusive execution is not part of this fixture")),
    active: Effect.sync(() => new Set(active)),
    resume: () => Effect.void,
    resumeWith: () => Effect.void,
    interrupt: () => Effect.void,
    wake: () => Effect.void,
    wakeAndWait: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      ScheduledPromptV2.node,
    ]),
    [[SessionExecution.node, execution]],
  ),
)
const sessionID = SessionV2.ID.make("ses_scheduled_prompt_test")

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
      slug: "scheduled",
      directory: "/project",
      title: "scheduled",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const create = (durable = true) =>
  ScheduledPromptV2.Service.use((service) =>
    service.create({
      sessionID,
      name: ScheduledPromptV2.Name.make(durable ? "daily review" : "ephemeral review"),
      cron: ScheduledPromptV2.Cron.make("* * * * *"),
      prompt: ScheduledPromptV2.Prompt.make("Review the current implementation."),
      durable,
    }),
  )

describe("ScheduledPrompt", () => {
  it.effect("persists a bounded schedule and rejects stale revisions", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* ScheduledPromptV2.Service
      const scheduled = yield* create()

      expect(scheduled.status).toBe("scheduled")
      expect(scheduled.revision).toBe(1)
      expect(yield* service.list(sessionID)).toEqual([scheduled])

      const updated = yield* service.update({
        sessionID,
        scheduleID: scheduled.id,
        expectedRevision: scheduled.revision,
        enabled: false,
      })
      expect(updated.enabled).toBe(false)
      expect(updated.revision).toBe(2)

      const stale = yield* Effect.flip(
        service.update({
          sessionID,
          scheduleID: scheduled.id,
          expectedRevision: 1,
          enabled: true,
        }),
      )
      expect(stale).toMatchObject({
        _tag: "ScheduledPrompt.StaleRevisionError",
        expectedRevision: 1,
        actualRevision: 2,
      })
    }),
  )

  it.effect("rejects run-missed before claiming a schedule and preserves its state", () =>
    Effect.gen(function* () {
      yield* setup
      const service = yield* ScheduledPromptV2.Service
      const scheduled = yield* create()

      const error = yield* Effect.flip(
        service.runMissed({
          sessionID,
          scheduleID: scheduled.id,
          expectedRevision: scheduled.revision,
        }),
      )
      expect(error).toMatchObject({
        _tag: "ScheduledPrompt.InvalidStateError",
        scheduleID: scheduled.id,
        status: "scheduled",
        action: "run missed",
      })

      const unchanged = yield* service.get({ sessionID, scheduleID: scheduled.id })
      expect(unchanged.status).toBe("scheduled")
      expect(unchanged.revision).toBe(scheduled.revision)
      expect(unchanged.lastError).toBe("")
    }),
  )

  it.effect("recovers an expired lease as missed and admits a one-shot prompt exactly once", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const service = yield* ScheduledPromptV2.Service
      const scheduled = yield* create()
      const now = Date.now()
      yield* db
        .update(ScheduledPromptTable)
        .set({ status: "running", next_run: now - 1_000, lease_owner: "dead-process", lease_until: now - 1 })
        .where(eq(ScheduledPromptTable.id, scheduled.id))
        .run()
        .pipe(Effect.orDie)

      yield* service.recover(now)
      const missed = yield* service.get({ sessionID, scheduleID: scheduled.id })
      expect(missed.status).toBe("missed")

      const messageID = SessionMessage.ID.make(`msg_scheduled_${scheduled.id}_1`)
      yield* SessionV2.Service.use((sessions) =>
        sessions.prompt({
          id: messageID,
          sessionID,
          prompt: PromptInput.Prompt.make({ text: scheduled.prompt }),
          delivery: "queue",
        }),
      )
      const completed = yield* service.runMissed({
        sessionID,
        scheduleID: scheduled.id,
        expectedRevision: missed.revision,
      })
      expect(completed.status).toBe("completed")

      const inputs = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]?.id).toBe(messageID)
    }),
  )

  it.effect("restores a missed schedule when its session is busy", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const service = yield* ScheduledPromptV2.Service
      const scheduled = yield* create()
      yield* db
        .update(ScheduledPromptTable)
        .set({ status: "missed", next_run: Date.now() - 1 })
        .where(eq(ScheduledPromptTable.id, scheduled.id))
        .run()
        .pipe(Effect.orDie)
      active.add(sessionID)
      const error = yield* Effect.flip(
        service.runMissed({ sessionID, scheduleID: scheduled.id, expectedRevision: scheduled.revision }),
      ).pipe(Effect.ensuring(Effect.sync(() => active.delete(sessionID))))

      expect(error._tag).toBe("Session.BusyError")
      const restored = yield* service.get({ sessionID, scheduleID: scheduled.id })
      expect(restored.status).toBe("missed")
      expect(restored.lastError).toBe("Session.BusyError")
    }),
  )

  it.effect("removes non-durable schedules during startup recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const service = yield* ScheduledPromptV2.Service
      const durable = yield* create(true)
      const ephemeral = yield* create(false)

      yield* service.recover()
      const rows = yield* db
        .select({ id: ScheduledPromptTable.id })
        .from(ScheduledPromptTable)
        .where(and(eq(ScheduledPromptTable.session_id, sessionID), eq(ScheduledPromptTable.durable, true)))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([{ id: durable.id }])
      expect(yield* service.list(sessionID)).not.toContainEqual(expect.objectContaining({ id: ephemeral.id }))
    }),
  )
})
