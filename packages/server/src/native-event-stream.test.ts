import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { EventV2 } from "@arforge-ai/core/event"
import { Database } from "@arforge-ai/core/database/database"
import { Project } from "@arforge-ai/schema/project"
import { AbsolutePath } from "@arforge-ai/schema/schema"
import { nativeEventStream } from "./native-event-stream"

test("native stream survives compatibility lifecycle events and delivers the later scoped error", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    let listener: Parameters<EventV2.Interface["listen"]>[0] | undefined
    let released = false
    const events = { listen: (next: NonNullable<typeof listener>) => Effect.gen(function* () {
      listener = next
      yield* Deferred.succeed(ready, undefined)
      return Effect.sync(() => { released = true; listener = undefined })
    }) }
    const collected = yield* nativeEventStream(events, undefined, 1).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    yield* Deferred.await(ready)
    for (let index = 0; index < 300; index++) {
      yield* listener!({ id: EventV2.ID.create(), type: index % 2 ? "session.idle" : "session.status", data: { sessionID: "ses_native_fixture" } })
    }
    const error = { id: EventV2.ID.create(), type: "session.error", location: { directory: AbsolutePath.make("C:/formal/native") },
      data: { sessionID: "ses_native_fixture", error: { name: "UnknownError", data: { message: "Formal compile failure" } } } }
    yield* listener!(error)
    const wire = Array.from(yield* Fiber.join(collected)).map((event) => JSON.parse(event.data))
    expect(wire.map((event) => event.type)).toEqual(["server.connected", "session.error"])
    expect(wire[1]).toEqual(error)
    expect(released).toBe(true)
  })))
})

test("declared native events still reject malformed payloads", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    let listener: Parameters<EventV2.Interface["listen"]>[0] | undefined
    const events = { listen: (next: NonNullable<typeof listener>) => Effect.gen(function* () {
      listener = next; yield* Deferred.succeed(ready, undefined)
      return Effect.void
    }) }
    const collected = yield* nativeEventStream(events).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    yield* Deferred.await(ready)
    yield* listener!({ id: EventV2.ID.create(), type: "session.error", data: { sessionID: 42 } })
    const exit = yield* Fiber.await(collected)
    expect(Exit.isFailure(exit)).toBe(true)
  })))
})

test("project updates require a matching tenant and user before entering the queue", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    let listener: Parameters<EventV2.Interface["listen"]>[0] | undefined
    const events = { listen: (next: NonNullable<typeof listener>) => Effect.gen(function* () {
      listener = next
      yield* Deferred.succeed(ready, undefined)
      return Effect.void
    }) }
    const owner = { tenantID: "ten_owner", userID: "usr_owner" }
    const collected = yield* nativeEventStream(events, owner, 1).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    yield* Deferred.await(ready)
    const update = {
      id: EventV2.ID.create(),
      type: Project.Event.Updated.type,
      data: { id: Project.ID.make("project-id"), worktree: "C:/project", sandboxes: [], time: { created: 1, updated: 2 } },
    }
    yield* listener!(update)
    yield* Database.principalContext({ ...owner, userID: "usr_foreign" }, listener!(update))
    yield* Database.principalContext({ ...owner, tenantID: "ten_foreign" }, listener!(update))
    const matching = { ...update, id: EventV2.ID.create() }
    yield* Database.principalContext(owner, listener!(matching))
    const wire = Array.from(yield* Fiber.join(collected)).map((event) => JSON.parse(event.data))
    expect(wire[1]).toEqual(matching)
  })))
})
