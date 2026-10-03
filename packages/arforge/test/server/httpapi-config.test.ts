import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "node:fs/promises"
import { Server } from "../../src/server/server"
import { Effect, Fiber, Schema } from "effect"
import { Billing } from "@arforge-ai/schema/billing"
import { Global } from "@arforge-ai/core/global"
import { ServerEvent } from "@arforge-ai/schema/server-event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "a project config save refreshes an already opened descendant without changing another project",
    Effect.gen(function* () {
      const root = yield* tmpdirEffect({ git: true, config: { username: "before", formatter: false, lsp: false } })
      const unrelated = yield* tmpdirEffect({ config: { username: "unrelated", formatter: false, lsp: false } })
      const nested = path.join(root.path, "nested")
      yield* Effect.promise(() => fs.mkdir(nested))
      const username = (directory: string) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            Promise.resolve(app().request("/config", { headers: { "x-arforge-directory": directory } })),
          )
          expect(response.status).toBe(200)
          return (yield* Effect.promise(() => response.json())).username
        })
      expect(yield* username(nested)).toBe("before")
      expect(yield* username(unrelated.path)).toBe("unrelated")
      const disposed = yield* waitDisposed(root.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-arforge-directory": root.path },
            body: JSON.stringify({ username: "after" }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      yield* Fiber.join(disposed)
      expect(yield* username(nested)).toBe("after")
      expect(yield* username(unrelated.path)).toBe("unrelated")
    }),
  )

  it.live(
    "MCP config PATCH uses the canonical writer and reloads without previous endpoint credentials",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        init: (directory) =>
          Bun.write(
            path.join(directory, "arforge.jsonc"),
            JSON.stringify({
              username: "retained-fixture",
              formatter: false,
              lsp: false,
              mcp: {
                servers: {
                  demo: {
                    type: "remote",
                    url: "https://old.invalid/mcp",
                    headers: { "X-Fixture": "previous-endpoint-header" },
                    disabled: true,
                  },
                },
              },
            }),
          ),
      })
      const headers = { "content-type": "application/json", "x-arforge-directory": tmp.path }
      const initial = yield* Effect.promise(() => Promise.resolve(app().request("/config", { headers })))
      expect(initial.status).toBe(200)
      expect(yield* Effect.promise(() => initial.json())).toMatchObject({
        mcp: { demo: { headers: { "X-Fixture": "previous-endpoint-header" } } },
      })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const server = { type: "remote", url: "https://new.invalid/mcp", enabled: false, oauth: false }
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ mcp: { demo: server } }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ mcp: { demo: server } })
      yield* Fiber.join(disposed)
      const saved = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "arforge.jsonc")).json())
      expect(saved.username).toBe("retained-fixture")
      expect(saved.mcp).toEqual({
        servers: { demo: { type: "remote", url: server.url, disabled: true, oauth: false } },
      })
      const reopened = yield* Effect.promise(() => Promise.resolve(app().request("/config", { headers })))
      expect(reopened.status).toBe(200)
      const actual = yield* Effect.promise(() => reopened.json())
      expect(actual.mcp).toEqual({ demo: server })
      expect(JSON.stringify(actual)).not.toContain("previous-endpoint-header")
    }),
  )

  it.live(
    "a global save refreshes the Core catalogs of two already opened directories",
    Effect.gen(function* () {
      const first = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const second = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      // preload.ts owns this isolated profile. Preserve the one selected file;
      // neither a real profile nor a second configuration store is used.
      const initial = yield* Effect.promise(() => Promise.resolve(app().request("/global/config")))
      expect(initial.status).toBe(200)
      const file = path.join(Global.Path.config, "arforge.jsonc")
      const before = yield* Effect.promise(async () =>
        Bun.file(file)
          .exists()
          .then((exists) => (exists ? Bun.file(file).text() : undefined)),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (before === undefined) await fs.rm(file, { force: true })
          else await Bun.write(file, before)
          await app().request("/global/dispose", { method: "POST" })
        }),
      )
      const price = {
        revision: "global-http-1",
        currency: "USD",
        minorUnit: 6,
        unit: "token",
        effectiveFrom: 0,
        source: "fixture",
        rates: { unknownInput: { amountMinor: 2 }, textOutput: { amountMinor: 3 } },
      }
      const save = (next: typeof price) =>
        Effect.gen(function* () {
          const disposed = yield* waitGlobalBusEvent({
            predicate: (event) => event.directory === "global" && event.payload.type === ServerEvent.Disposed.type,
          }).pipe(Effect.forkScoped({ startImmediately: true }))
          const response = yield* Effect.promise(() =>
            Promise.resolve(
              app().request("/global/config", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  provider: { "saved-global-local": { models: { model: { priceCatalog: next } } } },
                }),
              }),
            ),
          )
          expect(response.status).toBe(200)
          yield* Fiber.join(disposed)
        })
      const listed = Schema.Struct({
        data: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            providerID: Schema.String,
            priceCatalog: Schema.optional(Billing.PriceCatalog),
          }),
        ),
      })
      const read = (directory: string) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            Promise.resolve(app().request(`/api/model?location[directory]=${encodeURIComponent(directory)}`)),
          )
          expect(response.status).toBe(200)
          const payload = Schema.decodeUnknownSync(listed)(yield* Effect.promise(() => response.json()))
          return payload.data.find((model) => model.providerID === "saved-global-local" && model.id === "model")
            ?.priceCatalog
        })
      yield* save(price)
      expect((yield* read(first.path))?.revision).toBe(price.revision)
      expect((yield* read(second.path))?.revision).toBe(price.revision)
      const next = {
        ...price,
        revision: "global-http-2",
        rates: { unknownInput: { amountMinor: 7 }, textOutput: { amountMinor: 8 } },
      }
      yield* save(next)
      expect((yield* read(first.path))?.rates).toEqual(next.rates)
      expect((yield* read(second.path))?.rates).toEqual(next.rates)
    }),
  )

  it.live(
    "a saved config patch refreshes the existing Core model catalog through the default server",
    Effect.gen(function* () {
      const price = {
        revision: "http-price-1",
        currency: "USD",
        minorUnit: 6,
        unit: "token",
        effectiveFrom: 0,
        source: "fixture",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 2 } },
      }
      // An unauthenticated local provider must not declare an empty env login
      // method: that creates an unconnected integration and hides its models.
      const tmp = yield* tmpdirEffect({
        init: (directory) =>
          Bun.write(
            path.join(directory, "arforge.json"),
            JSON.stringify({
              formatter: false,
              lsp: false,
              providers: { local: { models: { model: { priceCatalog: price } } } },
            }),
          ),
      })
      const listed = Schema.Struct({
        location: Schema.Struct({ directory: Schema.String }),
        data: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            providerID: Schema.String,
            priceCatalog: Schema.optional(Billing.PriceCatalog),
          }),
        ),
      })
      const readPrice = Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          Promise.resolve(app().request(`/api/model?location[directory]=${encodeURIComponent(tmp.path)}`)),
        )
        expect(response.status).toBe(200)
        const payload = Schema.decodeUnknownSync(listed)(yield* Effect.promise(() => response.json()))
        expect(payload.location.directory).toBe(tmp.path)
        return payload.data.find((model) => model.providerID === "local" && model.id === "model")?.priceCatalog
      })
      expect((yield* readPrice)?.revision).toBe("http-price-1")
      const next = {
        ...price,
        revision: "http-price-2",
        rates: { unknownInput: { amountMinor: 4 }, textOutput: { amountMinor: 5 } },
      }
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-arforge-directory": tmp.path },
            body: JSON.stringify({ provider: { local: { models: { model: { priceCatalog: next } } } } }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      const current = yield* readPrice
      expect(current?.revision).toBe("http-price-2")
      expect(current?.rates).toEqual(next.rates)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).exists())).toBe(false)
    }),
  )

  it.live(
    "serves canonical saved pricing through the existing config response without rewriting the file",
    Effect.gen(function* () {
      const price = {
        revision: "saved-price-v1",
        currency: "USD",
        minorUnit: 6,
        unit: "token",
        effectiveFrom: 0,
        source: "fixture",
        rates: { unknownInput: { amountMinor: 1 }, textOutput: { amountMinor: 2 } },
      }
      const contents = JSON.stringify({
        formatter: false,
        lsp: false,
        providers: { local: { models: { model: { priceCatalog: price } } } },
      })
      const tmp = yield* tmpdirEffect({
        init: (directory) => Bun.write(path.join(directory, "arforge.json"), contents),
      })
      const response = yield* Effect.promise(() =>
        Promise.resolve(app().request("/config", { headers: { "x-arforge-directory": tmp.path } })),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: { local: { models: { model: { priceCatalog: price } } } },
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "arforge.json")).text())).toBe(contents)
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-arforge-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "arforge.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-arforge-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
