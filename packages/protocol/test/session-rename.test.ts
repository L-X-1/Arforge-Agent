import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { makeDefaultApi } from "../src/api"
import { Authorization } from "../src/middleware/authorization"

class Location extends HttpApiMiddleware.Service<Location>()("rename-test/location") {}
class SessionLocation extends HttpApiMiddleware.Service<SessionLocation>()("rename-test/session-location") {}
const api = makeDefaultApi({ locationMiddleware: Location, sessionLocationMiddleware: SessionLocation })

describe("manual Session rename transport contract", () => {
  test("registers the installed POST URL with canonical Session location and authorization", () => {
    const endpoint = api.groups["server.session"].endpoints["session.rename"]
    expect(endpoint).toBeDefined()
    expect(endpoint.method).toBe("POST")
    expect(endpoint.path).toBe("/api/session/:sessionID/rename")
    const middlewareKeys: string[] = []
    for (const middleware of endpoint.middlewares) middlewareKeys.push(middleware.key)
    expect(middlewareKeys).toContain(SessionLocation.key)
    expect(middlewareKeys).toContain(Authorization.key)
    expect(middlewareKeys).not.toContain(Location.key)
  })

  test("keeps title exactly as supplied without generated-title limits or normalization", () => {
    const endpoint = api.groups["server.session"].endpoints["session.rename"]
    expect(endpoint).toBeDefined()
    const payload = endpoint.payload.get("application/json")?.schemas.values().next().value
    if (!payload) throw new Error("Rename JSON payload schema is absent")
    // Reify the actual reflected, context-free JSON payload AST; no copied schema.
    const decode = Schema.decodeUnknownSync(Schema.make<Schema.Codec<unknown>>(payload.ast))
    for (const title of ["", "  preserved whitespace  ", "manual\r\n" + "🧪".repeat(150) + "  "]) {
      expect(decode({ title })).toEqual({ title })
    }
    for (const value of [{}, { title: null }, { title: 7 }, { title: [] }, null]) {
      expect(() => decode(value)).toThrow()
    }
  })

  test("documents empty 204 plus typed 400/401/404/409 errors", () => {
    const operation = OpenApi.fromApi(api).paths["/api/session/{sessionID}/rename"]?.post
    expect(operation).toBeDefined()
    if (!operation) throw new Error("Rename OpenAPI operation is absent")
    expect(operation.operationId).toBe("v2.session.rename")
    expect(Object.keys(operation.responses).sort()).toEqual(["204", "400", "401", "404", "409"])
    expect(operation.responses["204"]).not.toHaveProperty("content")
    expect(operation.requestBody).toMatchObject({ required: true })
  })
})
