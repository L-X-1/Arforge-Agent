import { expect } from "bun:test"
import path from "node:path"
import fsNode from "node:fs/promises"
import { Cause, Effect, Exit } from "effect"
import { Config } from "@arforge-ai/core/config"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, EffectFlock.node])))
const withDirectory = <A, E, R>(run: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => run(tmp.path),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
const price = {
  revision: "saved",
  currency: "USD",
  minorUnit: 6,
  unit: "token",
  effectiveFrom: 0,
  source: "fixture",
  rates: { unknownInput: { amountMinor: 2 }, textOutput: { amountMinor: 3 } },
}

it.live("saves a whole price revision while preserving JSONC comments and unrelated provider data", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const file = path.join(directory, "arforge.jsonc")
      const initial = `// authored comment\n${JSON.stringify({ username: "kept", providers: { local: { name: "Preserved", models: { model: { priceCatalog: { ...price, revision: "old", rates: { ...price.rates, cacheRead: { amountMinor: 99 } } } } } } } })}`
      yield* fs.writeWithDirs(file, initial)
      const result = yield* Config.updateDocument(directory, {
        providers: { local: { models: { model: { priceCatalog: price } } } },
      })
      expect(result.path).toBe(file)
      expect(result.changed).toBe(true)
      expect(result.text).toContain("// authored comment")
      const info = Config.decodeDocument(result.text, file)[0]?.info
      expect(info?.username).toBe("kept")
      expect(info?.providers?.local?.name).toBe("Preserved")
      expect(info?.providers?.local?.models?.model?.priceCatalog?.rates).toEqual(price.rates)
      expect((yield* Config.updateDocument(directory, {})).changed).toBe(false)
      expect(yield* fs.exists(path.join(directory, "config.json"))).toBe(false)
    }),
  ),
)

it.live("selects the highest local canonical document without changing lower-priority files", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const root = path.join(directory, "arforge.json")
      const local = path.join(directory, ".arforge", "arforge.jsonc")
      yield* fs.writeWithDirs(root, '{"username":"root"}')
      yield* fs.writeWithDirs(local, '// local\n{"username":"local"}')
      const result = yield* Config.updateDocument(directory, { username: "saved" }, { local: true })
      expect(result.path).toBe(local)
      expect(result.text).toContain("// local")
      expect(Config.decodeDocument(result.text)[0]?.info.username).toBe("saved")
      expect(yield* fs.readFileString(root)).toBe('{"username":"root"}')
    }),
  ),
)

it.live("serializes concurrent partial saves through the existing filesystem lock", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      yield* Effect.all(
        [
          Config.updateDocument(directory, { username: "user" }),
          Config.updateDocument(directory, { model: "local/model" }),
        ],
        { concurrency: "unbounded" },
      )
      const text = yield* (yield* FSUtil.Service).readFileString(path.join(directory, "arforge.jsonc"))
      expect(Config.decodeDocument(text)[0]?.info).toMatchObject({ username: "user", model: "local/model" })
    }),
  ),
)

it.live("does not overwrite malformed existing configuration or accept a malformed new price", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const file = path.join(directory, "arforge.jsonc")
      yield* fs.writeWithDirs(file, "{ invalid")
      expect(Exit.isFailure(yield* Config.updateDocument(directory, { username: "user" }).pipe(Effect.exit))).toBe(true)
      expect(yield* fs.readFileString(file)).toBe("{ invalid")
      yield* fs.writeWithDirs(file, '{"username":"original"}')
      expect(
        Exit.isFailure(
          yield* Config.updateDocument(directory, {
            providers: { local: { models: { model: { priceCatalog: { ...price, currency: "" } } } } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* fs.readFileString(file)).toBe('{"username":"original"}')
    }),
  ),
)

it.live("rejects an external change between reading and committing instead of losing that edit", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const conditionalWrite = fs.writeIfUnchanged
      if (!conditionalWrite) throw new Error("Production CAS must be available")
      const file = path.join(directory, "arforge.jsonc")
      yield* fs.writeWithDirs(file, '{"username":"original"}')
      const changed: FSUtil.Interface = {
        ...fs,
        writeIfUnchanged: (target, expected, content, mode) =>
          fs
            .writeFileString(target, '{"username":"external"}')
            .pipe(Effect.andThen(conditionalWrite(target, expected, content, mode))),
      }
      const result = yield* Config.updateDocument(directory, { username: "ours" }).pipe(
        Effect.provideService(FSUtil.Service, changed),
        Effect.exit,
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("ConditionalWriteConflictError")
      expect(yield* fs.readFileString(file)).toBe('{"username":"external"}')
    }),
  ),
)

it.live("publishes a new file exclusively if another writer creates the target after the absence check", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const file = path.join(directory, "arforge.jsonc")
      const raced: FSUtil.Interface = {
        ...fs,
        readFileString: (target, options) =>
          target !== file
            ? fs.readFileString(target, options)
            : fs.readFileString(target, options).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  (error) =>
                    fs.writeFileString(target, '{"username":"external"}').pipe(Effect.andThen(Effect.fail(error))),
                ),
              ),
      }
      const result = yield* Config.updateDocument(directory, { username: "ours" }).pipe(
        Effect.provideService(FSUtil.Service, raced),
        Effect.exit,
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("ConditionalWriteConflictError")
      expect(yield* fs.readFileString(file)).toBe('{"username":"external"}')
    }),
  ),
)

it.live("refuses a linked configuration directory without changing its target", () =>
  withDirectory((directory) =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const real = path.join(directory, "real")
      const link = path.join(directory, "linked")
      const file = path.join(real, "arforge.jsonc")
      yield* fs.writeWithDirs(file, '{"username":"protected"}')
      yield* Effect.promise(() => fsNode.symlink(real, link, process.platform === "win32" ? "junction" : "dir"))
      const result = yield* Config.updateDocument(link, { username: "ours" }).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* fs.readFileString(file)).toBe('{"username":"protected"}')
    }),
  ),
)
