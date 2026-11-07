import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
    }),
  ),
)

it.instance(
  "MCP tool details validates the canonical query and reports unavailable metadata with a safe typed 400",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const handler = HttpApiApp.webHandler()
      const base = new URLSearchParams({
        "location[directory]": instance.directory,
        server: "inspection-disabled",
        capabilityID: "inspection-disabled_read",
        generation: "0",
      })
      const request = (query: URLSearchParams) =>
        Effect.promise(() =>
          handler.handler(
            new Request(`http://localhost/api/mcp/tool?${query}`),
            Context.empty() as Context.Context<unknown>,
          ),
        )
      const response = yield* request(base)
      expect(response.status).toBe(400)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "InvalidRequestError",
        kind: "mcp-tool-details-unavailable",
        field: "query",
        message:
          "The advertised MCP tool definition is unavailable for the current connection and capability generation.",
      })
      for (const [key, value] of [
        ["server", ""],
        ["capabilityID", ""],
        ["generation", "-1"],
        ["generation", "1.5"],
        ["generation", "invalid"],
      ]) {
        const query = new URLSearchParams(base)
        query.set(key!, value!)
        expect((yield* request(query)).status).toBe(400)
      }
      for (const key of ["server", "capabilityID", "generation"]) {
        const query = new URLSearchParams(base)
        query.delete(key)
        expect((yield* request(query)).status).toBe(400)
      }
    }),
  {
    config: { mcp: { "inspection-disabled": { type: "local", command: ["fixture-not-launched"], enabled: false } } },
  },
)
