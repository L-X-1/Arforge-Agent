export * as FileSystemSearch from "./search"

import { makeLocationNode } from "../effect/app-node"
import path from "path"
import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import { Fff } from "#fff"
import fuzzysort from "fuzzysort"
import type { FileSystem } from "../filesystem"
import { Entry, Match } from "@arforge-ai/schema/filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Flag } from "../flag/flag"
import { EventV2 } from "../event"
import { FileSystemWatcher } from "@arforge-ai/schema/filesystem-watcher"

export interface Interface {
  readonly find: (input: FileSystem.FindInput) => Effect.Effect<FileSystem.Entry[]>
  readonly glob: (input: FileSystem.GlobInput) => Effect.Effect<readonly FileSystem.Entry[]>
  readonly grep: (input: FileSystem.GrepInput) => Effect.Effect<readonly FileSystem.Match[]>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/FileSystem/Search") {}

export const ripgrepLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    type Index = {
      files: string[]
      directories: string[]
      metadata: Map<string, string>
      generation: number
      createdAt: number
    }
    let current: Index | undefined
    type Pending = { result: Deferred.Deferred<Index>; fiber?: Fiber.Fiber<boolean> }
    let pending: Pending | undefined
    let generation = 0
    let disposed = false
    const metadata = (directories: Iterable<string>) =>
      Effect.forEach([...new Set(directories)], (directory) => fs.stat(directory).pipe(
        Effect.map((info) => [directory, JSON.stringify([
          info.type, Option.getOrUndefined(info.mtime)?.getTime(), Option.getOrUndefined(info.birthtime)?.getTime(),
          Option.getOrUndefined(info.ino), String(info.size),
        ])] as const),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([directory, "missing"] as const)),
        Effect.orDie,
      ), { concurrency: 16 }).pipe(Effect.map((entries) => new Map(entries)))
    const same = (before: Map<string, string>, after: Map<string, string>) =>
      [...before].every(([directory, fingerprint]) => after.get(directory) === fingerprint)
    const refresh = Effect.gen(function* () {
      while (true) {
        if (disposed) return yield* Effect.die(new Error("Filesystem search location is disposed"))
        const revision = generation
        const before = yield* metadata(current?.metadata.keys() ?? [location.directory])
        const now = yield* Clock.currentTimeMillis
        if (current && revision === generation && current.generation === revision &&
            now - current.createdAt < 5_000 && same(current.metadata, before)) return current
        const entries = yield* ripgrep.find({
          cwd: location.directory, pattern: "*", limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
        }).pipe(Effect.orDie)
        const files = entries.map((entry) => entry.path), directories = new Set<string>()
        for (const file of files) {
          const parts = file.split("/")
          parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
        }
        const paths = [location.directory, ...Array.from(directories, (directory) => path.resolve(location.directory, directory))]
        const after = yield* metadata([...before.keys(), ...paths])
        // Publish an immutable candidate only after its generation and directory
        // metadata still match. Changes during a scan require a fresh scan.
        if (revision !== generation || !same(before, after)) { yield* Effect.yieldNow; continue }
        if (disposed) return yield* Effect.die(new Error("Filesystem search location is disposed"))
        current = {
          files, directories: Array.from(directories), generation: revision,
          createdAt: yield* Clock.currentTimeMillis,
          metadata: new Map(paths.map((directory) => [directory, after.get(directory)!])),
        }
        return current
      }
    })
    // A shared location-owned worker coalesces metadata checks and scans. A
    // cancelled reader cannot cancel the other readers' refresh.
    const indexed: Effect.Effect<Index> = Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
      if (disposed) return Effect.die(new Error("Filesystem search location is disposed"))
      const existing = pending
      const slot = existing ?? { result: Deferred.makeUnsafe<Index>() }
      const awaitIndex = restore(Deferred.await(slot.result)).pipe(
        Effect.flatMap((index) => index.generation === generation ? Effect.succeed(index) : indexed),
      )
      if (existing) return awaitIndex
      pending = slot
      const work = Effect.uninterruptibleMask(() => refresh.pipe(
        Effect.interruptible,
        Effect.exit,
        Effect.flatMap((exit) => {
          if (pending === slot) pending = undefined
          return Deferred.done(slot.result, exit)
        }),
      ))
      return Effect.forkIn(work, scope).pipe(
        Effect.tap((fiber) => Effect.sync(() => { slot.fiber = fiber })),
        Effect.andThen(awaitIndex),
      )
    }))
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      disposed = true
      generation++
      const active = pending
      if (active) {
        yield* Deferred.interrupt(active.result)
        if (active.fiber) yield* Fiber.interrupt(active.fiber)
      }
    }))
    yield* events.subscribe(FileSystemWatcher.Event.Updated).pipe(
      Stream.runForEach((event) => Effect.sync(() => {
        if (event.location?.directory === location.directory && FSUtil.contains(location.directory, event.data.file)) generation++
      })),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .glob({
              cwd,
              pattern: input.pattern,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((entry) =>
                  Entry.make({
                    ...entry,
                    path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          const target = path.resolve(location.directory, input.path ?? ".")
          const info = yield* fs.stat(target).pipe(Effect.orDie)
          const cwd = info.type === "File" ? path.dirname(target) : target
          return yield* ripgrep
            .grep({
              cwd,
              pattern: input.pattern,
              file: info.type === "File" ? path.basename(target) : undefined,
              include: input.include,
              limit: input.limit ?? Number.MAX_SAFE_INTEGER,
            })
            .pipe(
              Effect.map((result) =>
                result.map((match) =>
                  Match.make({
                    ...match,
                    entry: Entry.make({
                      ...match.entry,
                      path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, match.entry.path))),
                    }),
                  }),
                ),
              ),
              Effect.orDie,
            )
        }),
      find: (input) =>
        Effect.gen(function* () {
          const state = yield* indexed
          const items =
            input.type === "file"
              ? state.files
              : input.type === "directory"
                ? state.directories
                : [...state.files, ...state.directories]
          return fuzzysort.go(input.query, items, { limit: input.limit ?? 50 }).map((item) => {
            const relative = item.target
            const type = relative.endsWith(path.sep) ? ("directory" as const) : ("file" as const)
            return Entry.make({
              path: RelativePath.make(relative),
              type,
            })
          })
        }),
    })
  }),
)

export const fffLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const result = yield* Effect.try({
      try: () =>
        Fff.create({
          basePath: location.directory,
          aiMode: true,
          disableMmapCache: true,
          disableContentIndexing: true,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) => Effect.logWarning("failed to initialize fff", { error }).pipe(Effect.as(undefined))),
    )
    if (!result?.ok) {
      if (result) yield* Effect.logWarning("failed to initialize fff", { error: result.error })
      return Service.of({
        find: () => Effect.succeed([]),
        glob: () => Effect.succeed([]),
        grep: () => Effect.succeed([]),
      })
    }
    const scanReady = yield* Effect.cached(
      Effect.promise(() => result.value.waitForScan(10_000)).pipe(
        Effect.tap((ready) =>
          ready.ok ? Effect.void : Effect.logWarning("fff initial scan did not complete", { error: ready.error }),
        ),
      ),
    )
    const findWithRipgrep = Effect.fnUntraced(function* (input: FileSystem.FindInput) {
      const entries = yield* ripgrep
        .find({
          cwd: location.directory,
          pattern: "*",
          limit: location.vcs ? Number.MAX_SAFE_INTEGER : 100_000,
        })
        .pipe(Effect.orDie)
      const files = entries.map((entry) => entry.path)
      const directories = new Set<string>()
      for (const file of files) {
        const parts = file.split("/")
        parts.slice(0, -1).forEach((_, index) => directories.add(parts.slice(0, index + 1).join("/") + path.sep))
      }
      const candidates =
        input.type === "file"
          ? files
          : input.type === "directory"
            ? Array.from(directories)
            : [...files, ...directories]
      return fuzzysort.go(input.query, candidates, { limit: input.limit ?? 50 }).map((item) =>
        Entry.make({
          path: RelativePath.make(item.target),
          type: item.target.endsWith(path.sep) ? "directory" : "file",
        }),
      )
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => result.value.destroy()).pipe(Effect.ignore))
    return Service.of({
      glob: (input) =>
        Effect.gen(function* () {
          yield* scanReady
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = result.value.glob(prefix ? `${prefix}/${input.pattern}` : input.pattern, {
            pageIndex: 0,
            pageSize: input.limit,
          })
          if (!found.ok) throw found.error
          return found.value.items.map((item) =>
            Entry.make({
              path: RelativePath.make(item.relativePath.replaceAll("\\", "/")),
              type: "file",
            }),
          )
        }),
      grep: (input) =>
        Effect.gen(function* () {
          yield* scanReady
          const prefix = input.path?.replaceAll("\\", "/").replace(/\/$/, "")
          const found = result.value.grep(
            [prefix ? `${prefix}/**` : undefined, input.include, input.pattern]
              .filter((value) => value !== undefined)
              .join(" "),
            { mode: "regex", pageSize: input.limit, timeBudgetMs: 1_500 },
          )
          if (!found.ok) throw found.error
          return found.value.items.map((match) => {
            const bytes = Buffer.from(match.lineContent)
            return Match.make({
              entry: Entry.make({
                path: RelativePath.make(match.relativePath.replaceAll("\\", "/")),
                type: "file",
              }),
              line: match.lineNumber,
              offset: match.byteOffset,
              text: match.lineContent.length > 2_000 ? match.lineContent.slice(0, 2_000) + "..." : match.lineContent,
              submatches: match.matchRanges.map(([start, end]) => ({
                text: bytes.subarray(start, end).toString("utf8"),
                start,
                end,
              })),
            })
          })
        }),
      find: (input) =>
        Effect.gen(function* () {
          yield* scanReady
          const options = { pageIndex: 0, pageSize: input.limit ?? 50 }
          const items = (() => {
            if (input.type === "file") {
              const found = result.value.fileSearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "file" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            if (input.type === "directory") {
              const found = result.value.directorySearch(input.query.trim(), options)
              if (!found.ok) throw found.error
              return found.value.items.map((item, index) => ({
                path: item.relativePath,
                type: "directory" as const,
                score: found.value.scores[index]?.total ?? 0,
              }))
            }
            const found = result.value.mixedSearch(input.query.trim(), options)
            if (!found.ok) throw found.error
            return found.value.items.map((item, index) => ({
              path: item.item.relativePath,
              type: item.type,
              score: found.value.scores[index]?.total ?? 0,
            }))
          })()
          const output = items
            .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
            .map((item) => {
              const relative = item.path.replaceAll("\\", "/").replace(/\/$/, "")
              return Entry.make({
                path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                type: item.type,
              })
            })
          if (output.length > 0) return output
          return yield* findWithRipgrep(input)
        }),
    })
  }),
)

const layer = Layer.unwrap(Effect.sync(() => (Flag.ARFORGE_DISABLE_FFF || !Fff.available() ? ripgrepLayer : fffLayer)))

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Location.node, Ripgrep.node, EventV2.node] })
