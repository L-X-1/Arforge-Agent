// Canonical Session create/admit/events/projector only; no seeded/repaired rows.
import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { ModelV2 } from "../src/model"
import { ProjectV2 } from "../src/project"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { Prompt } from "../src/session/prompt"
import { SessionCheckpointTable, SessionInputTable, SessionMessageTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(ProjectV2.Service, ProjectV2.Service.of({
  resolve: directory => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  directories: () => Effect.succeed([]), commit: () => Effect.void,
}))
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [[ProjectV2.node, projects], [SessionExecution.node, SessionExecution.noopLayer]],
))
const directory = AbsolutePath.make("/owned-projection-principal")
const owner = { tenantID: "ten_projection_owner", userID: "usr_projection_owner" }

const publishTurn = (promotedOnly = false) => Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const session = yield* sessions.create({ location: { directory } })
  const messageID = SessionMessage.ID.create()
  let prompt = Prompt.make({ text: "Owned canonical projection cause" })
  let timestamp = DateTime.makeUnsafe(1)
  if (!promotedOnly) {
    const admitted = yield* sessions.prompt({ sessionID: session.id, id: messageID, prompt, resume: false })
    prompt = admitted.prompt
    timestamp = admitted.timeCreated
  }
  yield* events.publish(SessionEvent.Prompted, { sessionID: session.id, messageID, prompt, delivery: "steer", timestamp })
  yield* events.publish(SessionEvent.Step.Started, {
    sessionID: session.id, assistantMessageID: SessionMessage.ID.create(), agent: "build",
    model: { providerID: ProviderV2.ID.make("owned"), id: ModelV2.ID.make("owned") }, timestamp: DateTime.makeUnsafe(2),
  })
  return { sessions, session, messageID }
})
const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    sessions: yield* db.select().from(SessionTable).orderBy(asc(SessionTable.id)).all(),
    inputs: yield* db.select().from(SessionInputTable).orderBy(asc(SessionInputTable.id)).all(),
    messages: yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.id)).all(),
    events: yield* db.select().from(EventTable).orderBy(asc(EventTable.id)).all(),
    checkpoints: yield* db.select().from(SessionCheckpointTable).all(),
  }
})

describe("canonical projected request ownership", () => {
  for (const promotedOnly of [false, true]) it.effect(`authenticated owner can preview exact ${promotedOnly ? "promoted-only compatibility" : "admitted then promoted"} prompt`, () => Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.runAsPrincipal(owner, Effect.gen(function* () {
      const { sessions, session, messageID } = yield* publishTurn(promotedOnly)
      const ownership = { tenant_id: owner.tenantID, owner_user_id: owner.userID }
      expect(yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()).toMatchObject(ownership)
      const durable = yield* database.db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all()
      expect(durable).toHaveLength(promotedOnly ? 3 : 4)
      for (const event of durable) expect(event).toMatchObject(ownership)
      const before = yield* snapshot
      // Causal RED: same exact existing ID/sequence fails RewindMessageNotFound.
      const result = yield* sessions.rewind.preview({ sessionID: session.id, messageID, expectedDirectory: directory }).pipe(Effect.result)
      expect(result).toMatchObject({ _tag: "Success", success: { workspaceEffectsUnchanged: true, affectedMessages: 2 } })
      expect(yield* snapshot).toEqual(before)
      expect(before.inputs).toMatchObject([ownership])
      expect(before.messages).toMatchObject([ownership, ownership])
    }))
    expect(yield* Database.CurrentPrincipal).toBeUndefined()
  }))

  it.effect("foreign tenant and same-tenant foreign user cannot preview or append to the owned turn", () => Effect.gen(function* () {
    const database = yield* Database.Service
    const { sessions, session, messageID } = yield* database.runAsPrincipal(owner, publishTurn())
    const before = yield* snapshot
    for (const foreign of [{ tenantID: "ten_foreign", userID: owner.userID }, { tenantID: owner.tenantID, userID: "usr_foreign" }]) {
      const denied = yield* database.runAsPrincipal(foreign, sessions.rewind.preview({ sessionID: session.id, messageID, expectedDirectory: directory }).pipe(Effect.result))
      expect(denied).toMatchObject({ _tag: "Failure", failure: { _tag: "Session.NotFoundError" } })
      const events = yield* EventV2.Service
      const append = yield* database.runAsPrincipal(foreign, events.publish(SessionEvent.Prompted, {
        sessionID: session.id, messageID: SessionMessage.ID.create(), prompt: Prompt.make({ text: "Must not project" }), delivery: "steer", timestamp: DateTime.makeUnsafe(3),
      }).pipe(Effect.exit))
      expect(append._tag).toBe("Failure")
      expect(yield* snapshot).toEqual(before)
    }
  }))

  it.effect("private/default-local projection and read-only preview remain valid", () => Effect.gen(function* () {
    const { sessions, session, messageID } = yield* publishTurn()
    const before = yield* snapshot
    const preview = yield* sessions.rewind.preview({ sessionID: session.id, messageID, expectedDirectory: directory })
    expect(preview.affectedMessages).toBe(2)
    expect(preview.workspaceEffectsUnchanged).toBe(true)
    expect(before.inputs).toMatchObject([{ tenant_id: "ten_local", owner_user_id: "usr_local" }])
    expect(before.messages).toMatchObject([{ tenant_id: "ten_local", owner_user_id: "usr_local" }, { tenant_id: "ten_local", owner_user_id: "usr_local" }])
    expect(yield* snapshot).toEqual(before)
  }))

  it.effect("all eight canonical message kinds use each execution's current principal", () => Effect.gen(function* () {
    const database = yield* Database.Service
    for (const principal of [owner, { tenantID: "ten_projection_second", userID: "usr_projection_second" }]) {
      yield* database.runAsPrincipal(principal, Effect.gen(function* () {
        const { session } = yield* publishTurn()
        const events = yield* EventV2.Service
        const base = { sessionID: session.id, timestamp: DateTime.makeUnsafe(3) }
        yield* events.publish(SessionEvent.AgentSwitched, { ...base, messageID: SessionMessage.ID.create(), agent: "review" })
        yield* events.publish(SessionEvent.ModelSwitched, { ...base, messageID: SessionMessage.ID.create(), model: { providerID: ProviderV2.ID.make("owned"), id: ModelV2.ID.make("other") } })
        yield* events.publish(SessionEvent.ContextUpdated, { ...base, messageID: SessionMessage.ID.create(), text: "Owned system context" })
        yield* events.publish(SessionEvent.Synthetic, { ...base, messageID: SessionMessage.ID.create(), text: "Owned synthetic context" })
        yield* events.publish(SessionEvent.Shell.Started, { ...base, messageID: SessionMessage.ID.create(), callID: "owned-call", command: "not executed by this projection test" })
        yield* events.publish(SessionEvent.Compaction.Ended, { ...base, messageID: SessionMessage.ID.create(), reason: "manual", text: "Owned summary", recent: "Owned recent" })
        const rows = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, session.id)).all()
        expect(rows.map(row => row.type).sort()).toEqual(["agent-switched", "assistant", "compaction", "model-switched", "shell", "synthetic", "system", "user"])
        for (const row of rows) expect(row).toMatchObject({ tenant_id: principal.tenantID, owner_user_id: principal.userID })
      }))
      expect(yield* Database.CurrentPrincipal).toBeUndefined()
    }
  }))

  it.effect("authenticated input/message projection rolls back atomically and observers see committed ownership", () => Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.runAsPrincipal(owner, Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location: { directory } })
      const observed: string[] = []
      yield* events.listen(event => event.type !== SessionEvent.Prompted.type ? Effect.void : Effect.gen(function* () {
        expect(yield* Database.CurrentPrincipal).toEqual(owner)
        const storedEvent = yield* database.db.select().from(EventTable).where(eq(EventTable.id, event.id)).get().pipe(Effect.orDie)
        expect(storedEvent).toMatchObject({ tenant_id: owner.tenantID, owner_user_id: owner.userID })
        const projected = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, session.id)).all().pipe(Effect.orDie)
        expect(projected).toHaveLength(1)
        expect(projected[0]).toMatchObject({ tenant_id: owner.tenantID, owner_user_id: owner.userID })
        observed.push(event.id)
      }))
      const before = yield* snapshot
      const data = { sessionID: session.id, messageID: SessionMessage.ID.create(), timestamp: DateTime.makeUnsafe(4), delivery: "steer" as const, prompt: Prompt.make({ text: "Rollback ownership projection" }) }
      for (const definition of [SessionEvent.PromptAdmitted, SessionEvent.Prompted]) {
        const rolledBack = yield* events.publish(definition, data, { commit: () => Effect.die("owned-projection-rollback") }).pipe(Effect.exit)
        expect(rolledBack._tag).toBe("Failure")
        expect(yield* snapshot).toEqual(before)
        expect(observed).toEqual([])
      }
      const committed = yield* events.publish(SessionEvent.Prompted, data)
      expect(observed).toEqual([committed.id])
    }))
    expect(yield* Database.CurrentPrincipal).toBeUndefined()
  }))
})
