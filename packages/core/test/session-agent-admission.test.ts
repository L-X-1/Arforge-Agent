import { expect } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer, LayerMap } from "effect"
import { AgentV2 } from "../src/agent"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventSequenceTable, EventTable } from "../src/event/sql"
import { Location } from "../src/location"
import type { LocationError, LocationServices } from "../src/location-services"
import { LocationServiceMap } from "../src/location-service-map"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionInputTable, SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { testEffect } from "./lib/effect"

const sourceA = AbsolutePath.make(path.resolve("E:/owned-admission44/A"))
const sourceB = AbsolutePath.make(path.resolve("E:/owned-admission44/B"))
const name = AgentV2.ID.make("owned-r02-review")
const catalogs = new Map<string, AgentV2.Interface>()
const enabled = new Set<string>()
const lookups: string[] = [], wakes: SessionV2.ID[] = [], interrupts: SessionV2.ID[] = []
const running = new Set<SessionV2.ID>()
let onLookup: Effect.Effect<void> = Effect.void

const locationMap = Layer.effect(LocationServiceMap.Service, Effect.gen(function* () {
  const map = yield* LayerMap.make((key: string) => Layer.effect(AgentV2.Service, Effect.gen(function* () {
    const directory: string = JSON.parse(key)[0]
    const actual = yield* AgentV2.Service
    yield* actual.transform(draft => Effect.sync(() => {
      if (enabled.has(directory)) draft.update(name, () => {})
      else draft.remove(name)
    }))
    catalogs.set(directory, actual)
    return AgentV2.Service.of({ ...actual, get: id => Effect.gen(function* () {
      lookups.push(directory)
      yield* onLookup
      return yield* actual.get(id)
    }) })
  })).pipe(Layer.provide(LayerNode.compile(AgentV2.node))), { idleTimeToLive: "60 minutes" })
  // This isolated map provides the real per-Location Agent leaf exercised by admission.
  // Missing unrelated Location services fail rather than gaining fake behavior.
  return { ...map, get: (ref: Location.Ref) => map.get(JSON.stringify([path.normalize(ref.directory), ref.workspaceID ?? null])) } as unknown as LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
}))
const execution = Layer.mock(SessionExecution.Service, {
  active: Effect.succeed(running),
  wake: id => Effect.sync(() => { wakes.push(id) }),
  interrupt: id => Effect.sync(() => { interrupts.push(id) }),
})
const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
  [[SessionExecution.node, execution], [LocationServiceMap.node, locationMap]],
))

const setup = Effect.gen(function* () {
  catalogs.clear(); lookups.length = 0; wakes.length = 0; interrupts.length = 0; running.clear(); onLookup = Effect.void
  enabled.clear(); enabled.add(sourceA)
  const { db } = yield* Database.Service
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: sourceA, sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
  const a = SessionV2.ID.make("ses_" + randomUUID()), b = SessionV2.ID.make("ses_" + randomUUID())
  for (const [id, directory] of [[a, sourceA], [b, sourceB]] as const)
    yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global, slug: "owned", directory, title: "owned", version: "test" }).run().pipe(Effect.orDie)
  return { a, b, db, session: yield* SessionV2.Service }
})
const snapshot = (id: SessionV2.ID) => Database.Service.use(({ db }) => Effect.all({
  inputs: db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, id)).all().pipe(Effect.orDie),
  events: db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie),
  sequence: db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, id)).get().pipe(Effect.orDie),
}))

for (const delivery of ["steer", "queue"] as const)
  it.effect("unknown explicit Agent rejects " + delivery + " before any durable admission or wake", () => Effect.gen(function* () {
    const { a, session } = yield* setup
    const before = yield* snapshot(a)
    const failure = yield* session.prompt({ sessionID: a, delivery, prompt: { text: "must reject", route: { agent: "missing-owned-agent" } } }).pipe(Effect.flip)
    expect(failure).toMatchObject({ _tag: "SessionExecution.OperationError", operation: "prompt", reason: "invalid" })
    expect(failure.message).toContain("missing-owned-agent")
    expect(yield* snapshot(a)).toEqual(before)
    expect(wakes).toEqual([])
    expect(lookups).toEqual([sourceA])
  }))

it.effect("disabling a valid Agent rejects new work while leaving the original running reply alone", () => Effect.gen(function* () {
  const { a, session } = yield* setup
  const first = yield* session.prompt({ sessionID: a, prompt: { text: "valid positive", route: { agent: name } } })
  expect(first.prompt.route?.agent).toBe(name)
  expect(wakes).toEqual([a])
  running.add(a)
  const catalog = catalogs.get(sourceA)!, activeInfo = yield* catalog.get(name)
  const originalInfo = JSON.stringify(activeInfo)
  enabled.delete(sourceA)
  expect(yield* catalog.get(name)).toBe(activeInfo)
  const before = yield* snapshot(a)
  const failure = yield* session.prompt({ sessionID: a, prompt: { text: "disabled new input", route: { agent: name } } }).pipe(Effect.flip)
  expect(failure).toMatchObject({ reason: "invalid" })
  expect(failure.message).toContain(name)
  expect(yield* snapshot(a)).toEqual(before)
  expect(wakes).toEqual([a])
  expect(interrupts).toEqual([])
  expect(running.has(a)).toBe(true)
  expect(yield* catalog.get(name)).toBeUndefined()
  expect(JSON.stringify(activeInfo)).toBe(originalInfo)
}))

it.effect("existing-ID replay survives disable and conflicting input keeps its conflict semantics", () => Effect.gen(function* () {
  const { a, session } = yield* setup
  const id = SessionMessage.ID.create(), prompt = { text: "original", route: { agent: name } }
  const first = yield* session.prompt({ sessionID: a, id, prompt, resume: false })
  enabled.delete(sourceA)
  const before = yield* snapshot(a), reads = lookups.length
  expect(yield* session.prompt({ sessionID: a, id, prompt, resume: false })).toEqual(first)
  expect(lookups).toHaveLength(reads)
  const conflict = yield* session.prompt({ sessionID: a, id, prompt: { ...prompt, text: "conflicting" }, resume: false }).pipe(Effect.flip)
  expect(conflict._tag).toBe("Session.PromptConflictError")
  expect(yield* snapshot(a)).toEqual(before)
  expect(wakes).toEqual([])
}))

it.effect("an omitted Agent retains existing default behavior without consulting or replacing its route", () => Effect.gen(function* () {
  const { a, session } = yield* setup
  catalogs.clear()
  const result = yield* session.prompt({ sessionID: a, prompt: { text: "unspecified default" }, resume: false })
  expect(result.prompt.route?.agent).toBeUndefined()
  expect(lookups).toEqual([])
  expect((yield* snapshot(a)).inputs).toHaveLength(1)
}))

it.effect("validation uses the authorized Session source rather than another source containing the same Agent", () => Effect.gen(function* () {
  const { b, session } = yield* setup
  const before = yield* snapshot(b)
  const failure = yield* session.prompt({ sessionID: b, prompt: { text: "source B must reject", route: { agent: name } } }).pipe(Effect.flip)
  expect(failure).toMatchObject({ reason: "invalid" })
  expect(lookups).toEqual([sourceB])
  expect(yield* snapshot(b)).toEqual(before)
  expect(wakes).toEqual([])
}))

it.effect("a source change during Agent lookup is still rejected before admission", () => Effect.gen(function* () {
  const { a, db, session } = yield* setup
  onLookup = db.update(SessionTable).set({ directory: sourceB }).where(eq(SessionTable.id, a)).run().pipe(Effect.orDie, Effect.asVoid)
  const before = yield* snapshot(a)
  const failure = yield* session.prompt({ sessionID: a, prompt: { text: "source race", route: { agent: name } } }).pipe(Effect.flip)
  expect(failure).toMatchObject({ reason: "conflict" })
  expect(yield* snapshot(a)).toEqual(before)
  expect(wakes).toEqual([])
}))
