import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { AgentV2 } from "@arforge-ai/core/agent"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { LocationServiceMap } from "@arforge-ai/core/location-service-map"
import type { LocationError, LocationServices } from "../src/location-services"
import type { Location } from "@arforge-ai/core/location"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { Project } from "@arforge-ai/core/project"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { Prompt } from "@arforge-ai/core/session/prompt"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionStore } from "@arforge-ai/core/session/store"
import { testEffect } from "./lib/effect"

const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    exclusive: () => Effect.die(new Error("Exclusive execution is not part of this fixture")),
    active: Effect.sync(() => new Set(activeSessions)),
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    resumeWith: () => Effect.void,
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
    wakeAndWait: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)
const recordingLocations = Layer.effect(LocationServiceMap.Service, Effect.gen(function* () {
  const agents = Layer.effect(AgentV2.Service, AgentV2.Service.use((service) => Effect.gen(function* () {
    yield* service.transform((draft) => {
      draft.update(AgentV2.ID.make("build"), () => {})
      draft.update(AgentV2.ID.make("review"), () => {})
    })
    return service
  }))).pipe(Layer.provide(AgentV2.locationLayer))
  const map = yield* LayerMap.make((_ref: Location.Ref) => agents)
  return map as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
}))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution], [LocationServiceMap.node, recordingLocations]],
  ),
)
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

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
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

describe("SessionV2.prompt", () => {
  it.effect("wakes an exact Guide retry after its original commit missed the wake", () =>
    Effect.gen(function* () {
      yield* setup
      wakeCalls.length = 0
      interruptCalls.length = 0
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const original = yield* session.prompt({
        sessionID, delivery: "queue", resume: false,
        prompt: {
          text: "Guide this exact prompt",
          files: [{ uri: "evidence://same", mime: "text/plain", resource: { server: "original", uri: "evidence://same" } }],
          route: { agent: "build", model: { id: ModelV2.ID.make("selected"), providerID: ProviderV2.ID.make("test") } },
        },
      })
      const input = { sessionID, messageID: original.id, expectedAdmittedSeq: original.admittedSeq }
      const steered = yield* SessionInput.steerQueued(db, events, input)
      expect(steered).toEqual({ ...original, delivery: "steer" })
      expect(wakeCalls).toEqual([])
      expect(yield* session.promptQueue.steer(input)).toEqual(steered)
      expect(wakeCalls).toEqual([sessionID])
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      expect((yield* session.promptQueue.steer(input)).promotedSeq).toBeDefined()
      expect(wakeCalls).toEqual([sessionID])
      expect(interruptCalls).toEqual([])
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptQueueSteered.type, 1))).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
    }),
  )

  for (const operation of ["edit", "remove"] as const)
    it.effect(`rejects stale promotion without publishing its routes when a queue ${operation} wins`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service
        const queued = yield* session.prompt({
          sessionID, delivery: "queue", resume: false,
          prompt: { text: "Old text", route: { agent: "build" } },
        })
        const selected = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, queued.id)).all().pipe(Effect.orDie)
        const input = { sessionID, messageID: queued.id, expectedAdmittedSeq: queued.admittedSeq }
        if (operation === "edit")
          yield* session.promptQueue.update({ ...input, prompt: { text: "Edited text", route: { agent: "review" } } })
        else yield* session.promptQueue.remove(input)
        expect(yield* SessionInput.promoteSelected(db, events, sessionID, selected)).toBe(0)
        expect(yield* eventCount(EventV2.versionedType(SessionEvent.AgentSwitched.type, 1))).toBe(0)
        expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(0)
        if (operation === "edit") {
          const steered = yield* session.promptQueue.steer(input)
          expect(steered.prompt).toMatchObject({ text: "Edited text", route: { agent: "review" } })
          const retry = (text: string) => session.prompt({
            sessionID, id: queued.id, delivery: "queue", resume: false,
            prompt: { text, route: { agent: "build" } },
          })
          expect(yield* retry("Old text")).toEqual(steered)
          expect((yield* retry("Different text").pipe(Effect.flip))._tag).toBe("Session.PromptConflictError")
          expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
        } else {
          expect((yield* session.promptQueue.steer(input).pipe(Effect.flip))._tag).toBe("SessionInput.QueuedPromptNotFoundError")
        }
      }),
    )

  it.effect("rejects queued resource retargeting without changing its row, sequence or events", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const id = SessionMessage.ID.create()
      const first = yield* session.prompt({
        sessionID,
        id,
        delivery: "queue",
        resume: false,
        prompt: {
          text: "@manual",
          files: [
            { uri: "evidence://shared/manual", resource: { server: "server-A", uri: "evidence://shared/manual" } },
          ],
        },
      })
      const snapshot = Effect.all({
        input: admitted(id),
        revision: db
          .select()
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, sessionID))
          .get()
          .pipe(Effect.orDie),
        events: db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie),
      })
      const before = yield* snapshot
      const failure = yield* session.promptQueue
        .update({
          sessionID,
          messageID: id,
          expectedAdmittedSeq: first.admittedSeq,
          prompt: {
            text: "@manual",
            files: [
              { uri: "evidence://shared/manual", resource: { server: "server-B", uri: "evidence://other/private" } },
            ],
          },
        })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionExecution.OperationError", reason: "invalid" })
      expect(yield* snapshot).toEqual(before)
    }),
  )

  it.effect("rejects a conflicting resource target before durable admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          resume: false,
          prompt: {
            text: "@manual",
            files: [
              { uri: "evidence://displayed/manual", resource: { server: "server-B", uri: "evidence://other/private" } },
            ],
          },
        })
        .pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionExecution.OperationError", reason: "invalid" })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )
  it.effect("retains exact MCP sources through durable queue, history replay and retry identity", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const uri = "evidence://shared/manual"
      const prompt = Prompt.make({
        text: "@manual @manual",
        files: ["server-A", "server-B"].map((server) => ({ uri, mime: "text/plain", resource: { server, uri } })),
        system: { text: "Retain request policy.", source: "request", scope: "turn" },
        route: {
          agent: "build",
          model: {
            id: ModelV2.ID.make("current"),
            providerID: ProviderV2.ID.make("owned"),
            variant: ModelV2.VariantID.make("high"),
          },
        },
      })
      const input = { sessionID, id: messageID, prompt, delivery: "queue" as const, resume: false }
      const first = yield* session.prompt(input)
      expect((yield* SessionInput.listQueued(db, sessionID))[0]?.prompt).toEqual(prompt)
      expect(yield* session.prompt(input)).toEqual(first)
      const conflicting = Prompt.make({
        ...prompt,
        files: prompt.files?.map((file) => ({ ...file, resource: { server: "server-C", uri } })),
      })
      expect(yield* session.prompt({ ...input, prompt: conflicting }).pipe(Effect.flip)).toMatchObject({
        _tag: "Session.PromptConflictError",
      })
      expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
      const messages = yield* session.messages({ sessionID })
      const user = messages.find((message) => message.type === "user")
      expect(user?.type === "user" ? Prompt.fromUserMessage(user) : undefined).toEqual(prompt)
      expect((yield* admitted(messageID))?.prompt).toEqual(prompt)
      const committed = yield* admitted(messageID)
      if (!committed) throw new Error("Committed resource prompt disappeared")
      expect(yield* session.prompt(input)).toEqual(committed)
    }),
  )

  it.effect("exposes the execution registry", () =>
    Effect.gen(function* () {
      activeSessions.add(sessionID)
      expect(Array.from(yield* (yield* SessionV2.Service).active)).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("drains and waits through the same SessionExecution owner", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.wait(sessionID)
      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(SessionV2.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionV2.ID.make("ses_missing")])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("resolves attachment MIME before admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: {
          text: "Inspect this image",
          files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "image.png" }],
        },
        resume: false,
      })

      expect(message.prompt.files).toEqual([
        { uri: "data:image/png;base64,aGVsbG8=", name: "image.png", mime: "image/png" },
      ])
      expect((yield* admitted(message.id))?.prompt.files).toEqual(message.prompt.files)
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("lists, updates, and removes durable queued prompts through one Core state owner", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const firstID = SessionMessage.ID.create()
      const secondID = SessionMessage.ID.create()

      const first = yield* session.prompt({
        id: firstID,
        sessionID,
        prompt: Prompt.make({ text: "First queued prompt" }),
        delivery: "queue",
        resume: false,
      })
      yield* session.prompt({
        id: secondID,
        sessionID,
        prompt: Prompt.make({ text: "Second queued prompt" }),
        delivery: "queue",
        resume: false,
      })

      expect((yield* session.promptQueue.list(sessionID)).map((item) => item.id)).toEqual([firstID, secondID])

      const updated = yield* session.promptQueue.update({
        sessionID,
        messageID: firstID,
        expectedAdmittedSeq: first.admittedSeq,
        prompt: Prompt.make({ text: "Edited queued prompt" }),
      })
      expect(updated).toMatchObject({
        id: firstID,
        delivery: "queue",
        prompt: { text: "Edited queued prompt" },
      })

      yield* session.promptQueue.remove({
        sessionID,
        messageID: firstID,
        expectedAdmittedSeq: first.admittedSeq,
      })
      expect((yield* session.promptQueue.list(sessionID)).map((item) => item.id)).toEqual([secondID])
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptQueueUpdated.type, 1))).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptQueueRemoved.type, 1))).toBe(1)
    }),
  )

  it.effect("rejects stale queue model consent when an edit keeps the same FIFO sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const model = {
        providerID: ProviderV2.ID.make("queue-provider"),
        id: ModelV2.ID.make("queue-model"),
      }
      const retired = { ...model, variant: ModelV2.VariantID.make("retired") }
      const selected = { ...model, variant: ModelV2.VariantID.make("selected") }
      const first = yield* session.prompt({
        sessionID,
        delivery: "queue",
        resume: false,
        prompt: { text: "First queued prompt", route: { model: retired } },
      })
      const second = yield* session.prompt({
        sessionID,
        delivery: "queue",
        resume: false,
        prompt: { text: "Second queued prompt" },
      })
      const target = { sessionID, messageID: first.id, expectedAdmittedSeq: first.admittedSeq }
      const changed = yield* session.promptQueue.update({
        ...target,
        prompt: { text: "Edited in the other window", route: { model: selected } },
      })
      expect(changed.admittedSeq).toBe(first.admittedSeq)
      const history = yield* session.history({ sessionID, limit: 20 })
      const prompt = { text: "Use default", route: { model } }

      for (const expectedModel of [
        retired,
        model,
        { ...selected, providerID: ProviderV2.ID.make("other-provider") },
        { ...selected, id: ModelV2.ID.make("other-model") },
      ]) {
        const failure = yield* session.promptQueue.update({ ...target, expectedModel, prompt }).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "SessionExecution.OperationError", reason: "conflict" })
      }
      // This fixture has no command preparer. A stale route must fail before reaching it.
      const commandFailure = yield* session.promptQueue.update({
        ...target,
        expectedModel: retired,
        prompt: { ...prompt, command: { name: "test-command", arguments: "" } },
      }).pipe(Effect.flip)
      expect(commandFailure).toMatchObject({ _tag: "SessionExecution.OperationError", reason: "conflict" })
      expect(yield* session.promptQueue.list(sessionID)).toEqual([changed, second])
      expect(yield* session.history({ sessionID, limit: 20 })).toEqual(history)

      const updated = yield* session.promptQueue.update({ ...target, expectedModel: selected, prompt })
      expect(updated.prompt).toMatchObject(prompt)
      expect(updated.admittedSeq).toBe(first.admittedSeq)
      expect(yield* session.promptQueue.list(sessionID)).toEqual([updated, second])
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("applies per-prompt agent and model routing only when a queued prompt is promoted", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const model = {
        id: ModelV2.ID.make("private-model"),
        providerID: ProviderV2.ID.make("private-provider"),
        variant: ModelV2.VariantID.make("high"),
      }
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Use the queued route", route: { agent: "review", model } }),
        delivery: "queue",
        resume: false,
      })

      expect((yield* session.get(sessionID)).agent).not.toBe("review")
      yield* SessionInput.promoteNextQueued(db, events, sessionID)

      expect(yield* session.get(sessionID)).toMatchObject({
        agent: "review",
        model,
      })
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.AgentSwitched.type, 1))).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.ModelSwitched.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )
})
