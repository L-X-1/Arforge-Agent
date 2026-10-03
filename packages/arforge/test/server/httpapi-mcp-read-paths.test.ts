import { afterEach, expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live(
  "MCP read grants round-trip through the original HTTP writer and reject invalid edits without changing the file",
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
      (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
    )
    const file = path.join(directory.path, "arforge.json")
    const headers = { "content-type": "application/json", "x-arforge-directory": directory.path }
    const server = {
      type: "local",
      command: ["fixture-not-launched"],
      enabled: false,
      timeout: { startup: 1200, request: 250 },
    }
    const app = Server.Default().app
    for (const paths of [["../依赖 目录", "./vendor"], []]) {
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app.request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              mcp: { library: { ...server, read_only_paths: paths } },
              experimental: { mcp_timeout: { startup: 4500, request: 500 } },
            }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        mcp: { library: { ...server, read_only_paths: paths } },
      })
      expect(yield* Effect.promise(() => Bun.file(file).json())).toMatchObject({
        mcp: {
          timeout: { startup: 4500, request: 500 },
          servers: {
            library: {
              type: "local",
              command: server.command,
              disabled: true,
              read_only_paths: paths,
              timeout: server.timeout,
            },
          },
        },
      })
      const reopened = yield* Effect.promise(() => Promise.resolve(app.request("/config", { headers })))
      expect(reopened.status).toBe(200)
      expect(yield* Effect.promise(() => reopened.json())).toMatchObject({
        mcp: { library: { read_only_paths: paths, timeout: server.timeout } },
        experimental: { mcp_timeout: { startup: 4500, request: 500 } },
      })
    }
    const before = yield* Effect.promise(() => Bun.file(file).text())
    for (const paths of [[""], [" \t"], ["invalid\0path"], [7], "not-an-array"]) {
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app.request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ mcp: { library: { ...server, read_only_paths: paths } } }),
          }),
        ),
      )
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
    }
    for (const timeout of [{ startup: 0 }, { request: -1 }, { request: 1.5 }, { startup: "bad" }]) {
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app.request("/config", {
            method: "PATCH",
            headers,
            body: JSON.stringify({ mcp: { library: { ...server, timeout } } }),
          }),
        ),
      )
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
    }
  }),
)
