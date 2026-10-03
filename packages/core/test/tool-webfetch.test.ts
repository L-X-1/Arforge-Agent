import { describe, expect, test } from "bun:test"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@arforge-ai/core/effect/app-node-platform"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { ToolRegistry } from "@arforge-ai/core/tool/registry"
import { ToolOutputStore } from "@arforge-ai/core/tool-output-store"
import { WebFetchTool } from "@arforge-ai/core/tool/webfetch"
import { ContextFirewall } from "@arforge-ai/core/context-firewall"
import { Egress } from "@arforge-ai/core/egress"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_webfetch_test")
const requests: Array<{ readonly url: string; readonly headers: Record<string, string> }> = []
const assertions: PermissionV2.AssertInput[] = []
let respond = (_request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => requests.push({ url: request.url, headers: request.headers })).pipe(
      Effect.andThen(respond(request)),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  ),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
// Read-only preflight resolution needs a real existing directory; the test
// file's own directory is deterministic on every platform.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const toolLayer = (replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WebFetchTool.node]), [
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Location.node, current],
    ...replacements,
  ])
const it = testEffect(toolLayer([[LayerNodePlatform.httpClient, http]]))
const live = testEffect(toolLayer())

const reset = () => {
  requests.length = 0
  assertions.length = 0
  respond = () => Effect.succeed(new Response("hello", { headers: { "content-type": "text/plain" } }))
}

const call = (input: typeof WebFetchTool.Input.Type, id = "call-webfetch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "webfetch", input },
})
describe("WebFetchTool helpers", () => {
  test("defaults format and rejects invalid timeout controls", () => {
    const decode = Schema.decodeUnknownSync(WebFetchTool.Input)
    expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com", format: "markdown" })
    expect(() => decode({ url: "https://example.com", timeout: 0 })).toThrow()
    expect(() => decode({ url: "https://example.com", timeout: WebFetchTool.MAX_TIMEOUT_SECONDS + 1 })).toThrow()
  })

  test("ports HTML text and markdown conversions without active content", () => {
    const html = "<h1>Hello</h1><script>bad()</script><p>world <strong>wide</strong></p><style>.bad {}</style>"
    expect(WebFetchTool.extractTextFromHTML(html)).toBe("Helloworld wide")
    expect(WebFetchTool.convertHTMLToMarkdown(html)).toBe("# Hello\n\nworld **wide**")
  })

  test("fetches a bounded raw asset through the canonical egress trace", async () => {
    const requested: string[] = []
    const assertions: Array<{ url: string; method: string; redirectFrom?: string }> = []
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requested.push(request.url)
        const response =
          request.url === "https://cdn.example.test/app.js"
            ? new Response("", { status: 302, headers: { location: "/v2/app.js" } })
            : new Response("console.log('asset')", { headers: { "content-type": "text/javascript" } })
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
    const egress: Egress.Authorizer = {
      assert: (input) => Effect.sync(() => assertions.push(input)),
    }
    const result = await Effect.runPromise(
      WebFetchTool.fetchRawAsset(client, egress, "https://cdn.example.test/app.js"),
    )
    expect(requested).toEqual(["https://cdn.example.test/app.js", "https://cdn.example.test/v2/app.js"])
    expect(assertions).toEqual([
      { url: "https://cdn.example.test/app.js", method: "GET" },
      { url: "https://cdn.example.test/v2/app.js", method: "GET", redirectFrom: "https://cdn.example.test/app.js" },
    ])
    expect(result).toMatchObject({
      url: "https://cdn.example.test/app.js",
      redirects: ["https://cdn.example.test/v2/app.js"],
      finalURL: "https://cdn.example.test/v2/app.js",
      contentType: "text/javascript",
    })
    expect(new TextDecoder().decode(result.bytes)).toBe("console.log('asset')")
  })
})

describe("WebFetchTool registration", () => {
  it.effect("registers and fetches an ordinary hostname HTTP URL without rewriting it", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://example.com/public"

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["webfetch"])
      expect(yield* settleTool(registry, call({ url, format: "text", timeout: 4 }))).toEqual({
        result: { type: "text", value: ContextFirewall.untrusted("web", "hello") },
        output: {
          structured: { url, contentType: "text/plain", format: "text", output: "hello" },
          content: [{ type: "text", text: ContextFirewall.untrusted("web", "hello") }],
        },
      })
      expect(assertions).toMatchObject([
        {
          sessionID,
          agent: "build",
          action: "webfetch",
          resources: ["HTTP origin from url", url],
          metadata: {
            riskTier: "L2",
            authority: "scoped_grant",
            networkScope: [url],
            externalServices: ["HTTP origin from url"],
            filesystemScope: [],
            secretScope: [],
          },
        },
      ])
      expect(assertions[0]?.resources).not.toContain("*")
      expect(requests).toMatchObject([{ url, headers: { accept: expect.stringContaining("text/plain;q=1.0") } }])
    }),
  )

  it.effect("accepts localhost URLs with the same requested-URL permission check", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const url = "http://localhost/private"

      expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
        type: "text",
        value: ContextFirewall.untrusted("web", "hello"),
      })
      expect(assertions).toMatchObject([
        {
          sessionID,
          agent: "build",
          action: "webfetch",
          resources: ["HTTP origin from url", url],
          metadata: {
            riskTier: "L2",
            authority: "scoped_grant",
            networkScope: [url],
            externalServices: ["HTTP origin from url"],
            filesystemScope: [],
            secretScope: [],
          },
        },
      ])
      expect(requests.map((request) => request.url)).toEqual([url])
    }),
  )

  live.effect("follows redirects while approving only the requested URL", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === "/redirect"
              ? new Response("", { status: 302, headers: { location: "/target" } })
              : new Response("redirected", { headers: { "content-type": "text/plain" } }),
        }),
      ),
      (server) =>
        Effect.gen(function* () {
          reset()
          const registry = yield* ToolRegistry.Service
          const url = new URL("/redirect", server.url).toString()

          expect(yield* executeTool(registry, call({ url, format: "text" }))).toEqual({
            type: "text",
            value: ContextFirewall.untrusted("web", "redirected"),
          })
          expect(assertions).toMatchObject([
            {
              sessionID,
              agent: "build",
              action: "webfetch",
              resources: ["HTTP origin from url", url],
              metadata: {
                riskTier: "L2",
                authority: "scoped_grant",
                networkScope: [url],
                externalServices: ["HTTP origin from url"],
                filesystemScope: [],
                secretScope: [],
              },
            },
          ])
        }),
      (server) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("rejects non-HTTP schemes before permission or transport", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "file:///etc/passwd", format: "text" }))).toEqual({
        type: "error",
        value: "Preflight blocked: webfetch only supports http and https URLs",
      })
      expect(assertions).toEqual([])
      expect(requests).toEqual([])
    }),
  )

  it.effect("converts HTML to requested markdown and text", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<h1>Hello</h1><p>world</p><script>bad()</script>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "markdown" }, "call-md"))).toEqual({
        type: "text",
        value: ContextFirewall.untrusted("web", "# Hello\n\nworld"),
      })
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }, "call-text"))).toEqual({
        type: "text",
        value: ContextFirewall.untrusted("web", "Helloworld"),
      })
    }),
  )

  it.effect("returns an error result when HTML-to-Markdown conversion throws", () =>
    Effect.gen(function* () {
      reset()
      respond = () =>
        Effect.succeed(
          new Response("<div>".repeat(10_000) + "content" + "</div>".repeat(10_000), {
            headers: { "content-type": "text/html" },
          }),
        )
      const registry = yield* ToolRegistry.Service
      const url = "https://1.1.1.1/deep-html"

      expect(yield* executeTool(registry, call({ url, format: "markdown" }))).toEqual({
        type: "error",
        value: `Unable to fetch ${url}`,
      })
    }),
  )

  it.effect("rejects declared and streamed oversized bodies", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () =>
        Effect.succeed(
          new Response("small", {
            headers: { "content-type": "text/plain", "content-length": String(WebFetchTool.MAX_RESPONSE_BYTES + 1) },
          }),
        )
      expect(
        yield* executeTool(registry, call({ url: "https://1.1.1.1/declared", format: "text" }, "call-declared")),
      ).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/declared",
      })

      respond = () =>
        Effect.succeed(
          new Response("x".repeat(WebFetchTool.MAX_RESPONSE_BYTES + 1), { headers: { "content-type": "text/plain" } }),
        )
      expect(
        yield* executeTool(registry, call({ url: "https://1.1.1.1/streamed", format: "text" }, "call-streamed")),
      ).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/streamed",
      })
    }),
  )

  it.effect("keeps images and files unsupported until typed settlement can carry attachments", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      respond = () => Effect.succeed(new Response("png", { headers: { "content-type": "image/png" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/image", format: "html" }, "call-image"))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/image",
      })

      respond = () => Effect.succeed(new Response("pdf", { headers: { "content-type": "application/pdf" } }))
      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1/file", format: "html" }, "call-file"))).toEqual({
        type: "error",
        value: "Unable to fetch https://1.1.1.1/file",
      })
    }),
  )

  it.effect("retries Cloudflare challenges with an honest user agent", () =>
    Effect.gen(function* () {
      reset()
      let count = 0
      respond = () =>
        Effect.succeed(
          ++count === 1
            ? new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })
            : new Response("ok", { headers: { "content-type": "text/plain" } }),
        )
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ url: "https://1.1.1.1", format: "text" }))).toEqual({
        type: "text",
        value: ContextFirewall.untrusted("web", "ok"),
      })
      expect(requests).toHaveLength(2)
      expect(requests[0]?.headers["user-agent"]).toContain("Mozilla/5.0")
      expect(requests[1]?.headers["user-agent"]).toBe("arforge")
    }),
  )

  it.effect("times out stalled requests", () =>
    Effect.gen(function* () {
      reset()
      respond = () => Effect.never
      const registry = yield* ToolRegistry.Service
      const fiber = yield* executeTool(
        registry,
        call({ url: "https://1.1.1.1/slow", format: "text", timeout: 1 }),
      ).pipe(Effect.forkChild)
      while (requests.length === 0) yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* Fiber.join(fiber)).toEqual({ type: "error", value: "Unable to fetch https://1.1.1.1/slow" })
    }),
  )
})
