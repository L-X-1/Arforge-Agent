import { expect, test } from "bun:test"
import path from "path"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Schema, Scope, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { Definition, Payload } from "@arforge-ai/schema/event"
import { FileSystemWatcher } from "@arforge-ai/schema/filesystem-watcher"
import { FileSystemSearch } from "@arforge-ai/core/filesystem/search"
import { EventV2 } from "@arforge-ai/core/event"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { Location } from "@arforge-ai/core/location"
import { Ripgrep } from "@arforge-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@arforge-ai/core/schema"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { location } from "../fixture/location"

const root = AbsolutePath.make(path.resolve("owned-search-cache"))
const run = <A, E>(effect: Effect.Effect<A, E, FSUtil.Service | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(LayerNode.compile(FSUtil.node))))

const fixture = Effect.gen(function* () {
  const actualFS = yield* FSUtil.Service
  const directoryInfo = yield* actualFS.stat(import.meta.dir)
  const messages = yield* PubSub.unbounded<Payload>()
  const revisions = new Map<string, number>([[root, 1], [path.join(root, "src"), 1]])
  const state = {
    files: ["src/first.txt"], scans: 0, stats: 0, failed: false, metadataFailed: false, interrupted: 0,
    blocked: undefined as undefined | { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> },
  }
  const events = EventV2.Service.of({
    publish: () => Effect.die("The test publishes only controlled transient filesystem events"),
    subscribe: <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
      Stream.fromPubSub(messages).pipe(
        Stream.filter((event) => event.type === definition.type),
        // The controlled producer already validates id/location; decode the
        // actual definition's data before restoring its generic payload type.
        Stream.map((event) => ({ ...event, type: definition.type,
          data: Schema.decodeUnknownSync(definition.data)(event.data) }) as Payload<D>),
      ),
    all: () => Stream.fromPubSub(messages), durable: () => Stream.empty,
    listen: () => Effect.die("Unexpected legacy listener"), project: () => Effect.void,
    replay: () => Effect.void, replayAll: () => Effect.succeed(undefined), remove: () => Effect.void, claim: () => Effect.void,
  })
  const filesystem = FSUtil.Service.of({
    ...actualFS,
    stat: (directory) => Effect.suspend(() => {
      state.stats++
      if (state.metadataFailed) return Effect.die(new Error("controlled stat failure"))
      return Effect.succeed({ ...directoryInfo, mtime: Option.some(new Date(revisions.get(directory) ?? 1)) })
    }),
  })
  const ripgrep = Ripgrep.Service.of({
    find: () => Effect.gen(function* () {
      state.scans++
      const files = state.files.slice(), blocked = state.blocked
      state.blocked = undefined
      if (blocked) {
        yield* Deferred.succeed(blocked.started, undefined)
        yield* Deferred.await(blocked.release)
      }
      if (state.failed) return yield* new Ripgrep.Error({ message: "controlled scan failure" })
      return files.map((file) => ({ path: RelativePath.make(file), type: "file" as const }))
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => { state.interrupted++ }))),
    glob: () => Effect.succeed([]), grep: () => Effect.succeed([]),
  })
  const layer = FileSystemSearch.ripgrepLayer.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(FSUtil.Service, filesystem), Layer.succeed(Ripgrep.Service, ripgrep),
    Layer.succeed(Location.Service, location({ directory: root })), Layer.succeed(EventV2.Service, events),
  )))
  const build = Effect.map(Layer.build(layer), (context) => Context.get(context, FileSystemSearch.Service))
  const bump = (directory: string = root) => revisions.set(directory, (revisions.get(directory) ?? 0) + 1)
  const emit = (file: string, directory = root) => PubSub.publish(messages, FileSystemWatcher.Event.Updated.make({
    id: EventV2.ID.create(), location: { directory }, data: { file, event: "add" }, type: FileSystemWatcher.Event.Updated.type,
  })).pipe(Effect.andThen(Effect.yieldNow))
  const block = Effect.gen(function* () {
    const started = yield* Deferred.make<void>(), release = yield* Deferred.make<void>()
    const value = { started, release }; state.blocked = value; return value
  })
  return { state, build, bump, emit, block }
})

test("actual ripgrep search discovers later create/remove/rename via directory metadata and reuses stable scans", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build
  expect((yield* search.find({ query: "first", type: "file" })).map((item) => item.path)).toEqual([RelativePath.make("src/first.txt")])
  f.state.files.push("src/created.txt"); f.bump(path.join(root, "src"))
  expect((yield* search.find({ query: "created" })).map((item) => item.path)).toEqual([RelativePath.make("src/created.txt")])
  f.state.files = ["src/renamed.txt"]; f.bump(path.join(root, "src"))
  expect(yield* search.find({ query: "first", type: "file" })).toEqual([])
  expect((yield* search.find({ query: "renamed", type: "file" })).length).toBe(1)
  expect((yield* search.find({ query: "src", type: "directory", limit: 1 })).map((item) => item.path)).toEqual([RelativePath.make("src" + path.sep)])
  const scans = f.state.scans
  yield* Effect.all(["r", "re", "ren", "rename"].map((query) => search.find({ query, limit: 1 })), { concurrency: "unbounded" })
  expect(f.state.scans).toBe(scans)
})))

test("actual search coalesces concurrent first queries into one controlled scan", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build, blocked = yield* f.block
  const pending = yield* Effect.all(Array.from({ length: 6 }, () => search.find({ query: "first" })), { concurrency: "unbounded" }).pipe(Effect.forkScoped)
  yield* Deferred.await(blocked.started)
  expect(f.state.scans).toBe(1)
  yield* Deferred.succeed(blocked.release, undefined)
  expect((yield* Fiber.join(pending)).every((items) => items.length === 1)).toBe(true)
  expect(f.state.scans).toBe(1)
})))

test("an event invalidating an in-flight scan cannot publish stale paths or force overlapping scans", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build, blocked = yield* f.block
  const old = yield* search.find({ query: "renamed" }).pipe(Effect.forkScoped)
  yield* Deferred.await(blocked.started)
  f.state.files = ["renamed.txt"]
  yield* f.emit(path.join(root, "renamed.txt"))
  const concurrent = yield* search.find({ query: "renamed" }).pipe(Effect.forkScoped)
  expect(f.state.scans).toBe(1)
  yield* Deferred.succeed(blocked.release, undefined)
  expect((yield* Fiber.join(old)).map((item) => item.path)).toEqual([RelativePath.make("renamed.txt")])
  expect((yield* Fiber.join(concurrent)).map((item) => item.path)).toEqual([RelativePath.make("renamed.txt")])
  expect(f.state.scans).toBe(2)
})))

test("directory metadata changing during a scan also rejects its obsolete candidate without watcher events", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build, blocked = yield* f.block
  const pending = yield* search.find({ query: "metadata-created" }).pipe(Effect.forkScoped)
  yield* Deferred.await(blocked.started)
  f.state.files.push("metadata-created.txt"); f.bump()
  yield* Deferred.succeed(blocked.release, undefined)
  expect((yield* Fiber.join(pending)).map((item) => item.path)).toEqual([RelativePath.make("metadata-created.txt")])
  expect(f.state.scans).toBe(2)
})))

test("cancelling one reader does not interrupt the shared scan needed by another reader", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build, blocked = yield* f.block
  const first = yield* search.find({ query: "first" }).pipe(Effect.forkScoped)
  yield* Deferred.await(blocked.started)
  const second = yield* search.find({ query: "first" }).pipe(Effect.forkScoped)
  yield* Fiber.interrupt(first)
  expect(f.state.interrupted).toBe(0)
  yield* Deferred.succeed(blocked.release, undefined)
  expect((yield* Fiber.join(second)).length).toBe(1)
  expect(f.state.scans).toBe(1)
})))

test("filesystem events are location bound and idle locations do not scan", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build
  yield* search.find({ query: "first" })
  f.state.files.push("event-created.txt")
  yield* f.emit(path.join(root, "event-created.txt"), AbsolutePath.make(path.resolve("foreign-search-cache")))
  yield* f.emit(path.resolve("outside-search-cache", "foreign.txt"))
  yield* search.find({ query: "event-created" })
  expect(f.state.scans).toBe(1)
  yield* f.emit(path.join(root, "event-created.txt"))
  expect(f.state.scans).toBe(1)
  expect((yield* search.find({ query: "event-created" })).length).toBe(1)
  expect(f.state.scans).toBe(2)
})))

test("bounded age finds unwatched additions even when directory metadata is unchanged", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build
  yield* search.find({ query: "first" })
  f.state.files.push("previously-empty/new.txt")
  yield* TestClock.adjust("5 seconds")
  expect((yield* search.find({ query: "new.txt", type: "file" })).length).toBe(1)
  expect(f.state.scans).toBe(2)
}).pipe(Effect.provide(TestClock.layer()))))

test("failed scans and metadata reads are not permanently cached and cannot publish partial state", () => run(Effect.gen(function* () {
  const f = yield* fixture, search = yield* f.build
  f.state.failed = true
  expect(Exit.isFailure(yield* Effect.exit(search.find({ query: "first" })))).toBe(true)
  f.state.failed = false
  expect((yield* search.find({ query: "first" })).length).toBe(1)
  f.state.metadataFailed = true
  expect(Exit.isFailure(yield* Effect.exit(search.find({ query: "first" })))).toBe(true)
  f.state.metadataFailed = false
  expect((yield* search.find({ query: "first" })).length).toBe(1)
})))

test("location disposal cancels its in-flight scan and releases waiting readers", () => run(Effect.gen(function* () {
  const f = yield* fixture, scope = yield* Scope.make(), search = yield* f.build.pipe(Effect.provideService(Scope.Scope, scope))
  const blocked = yield* f.block
  const pending = yield* search.find({ query: "first" }).pipe(Effect.forkScoped)
  yield* Deferred.await(blocked.started)
  yield* Scope.close(scope, Exit.void)
  expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true)
  expect(f.state.interrupted).toBe(1)
  expect(Exit.isFailure(yield* Effect.exit(search.find({ query: "first" })))).toBe(true)
})))
