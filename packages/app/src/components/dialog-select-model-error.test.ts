import { describe, expect, test } from "bun:test"
import { Arforge } from "@arforge-ai/client/promise"
import { classifyModelCatalogError } from "./dialog-select-model-error"

describe("safe model catalog failure classification", () => {
  test.each([
    [401, { _tag: "UnauthorizedError", message: "Authentication required" }, "auth"],
    [429, { _tag: "RateLimitedError", message: "Rate limited", retryAfterSeconds: 60 }, "limit"],
    [503, { _tag: "ServiceUnavailableError", message: "Service temporarily unavailable" }, "temporary"],
  ] as const)("classifies catalog HTTP %i through the application client", async (status, body, kind) => {
    const client = Arforge.make({
      baseUrl: "http://127.0.0.1",
      fetch: Object.assign(
        async (input: RequestInfo | URL) => {
          const url = new URL(input instanceof Request ? input.url : input)
          expect(url.pathname).toBe("/api/provider")
          return Response.json(body, { status })
        },
        { preconnect() {} },
      ),
    })
    const failure = await client.provider.list().then(
      () => {
        throw new Error("Catalog request should have failed")
      },
      (error: unknown) => error,
    )
    expect(classifyModelCatalogError(failure)).toBe(kind)
  })

  test("distinguishes real authorization, limits, unavailable catalog and transient status", () => {
    for (const status of [401, 403]) expect(classifyModelCatalogError({ cause: { status } })).toBe("auth")
    for (const status of [402, 429]) expect(classifyModelCatalogError({ response: { status } })).toBe("limit")
    expect(classifyModelCatalogError({ statusCode: "404" })).toBe("unavailable")
    expect(classifyModelCatalogError(new Error("Transport error", { cause: { status: 503 } }))).toBe("temporary")
    expect(classifyModelCatalogError(new TypeError("Failed to fetch"))).toBe("temporary")
  })
  test("does not infer an HTTP status from a body/message or return any sensitive value", () => {
    const error = {
      message: "Unknown model429",
      headers: { authorization: "Bearer synthetic-secret" },
      body: { status: 401, apiKey: "synthetic-secret" },
    }
    expect(classifyModelCatalogError(error)).toBe("unknown")
    const cyclic = { cause: undefined as object | undefined }
    cyclic.cause = cyclic
    expect(classifyModelCatalogError(cyclic)).toBe("unknown")
  })
})
