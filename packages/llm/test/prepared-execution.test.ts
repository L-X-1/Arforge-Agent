import { expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, PreparedRequest } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor, WebSocketExecutor } from "../src/route"
import * as OpenAI from "../src/providers/openai"
import { it } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

it.live(
  "matches the prepared transmission against a real loopback HTTP request",
  () =>
    Effect.gen(function* () {
      const observed: unknown[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: async (request) => {
              observed.push(decode(await request.text()))
              return new Response(sseEvents(deltaChunk({ content: "done" }, "stop")), {
                headers: { "content-type": "text/event-stream" },
              })
            },
          }),
        ),
        (server) =>
          Effect.sync(() => {
            server.stop(true)
          }),
      )
      const model = OpenAIChat.route
        .with({
          endpoint: { baseURL: `http://127.0.0.1:${server.port}/v1` },
          auth: Auth.bearer("loopback-fixture"),
        })
        .model({ id: "fake-model" })
      const request = LLM.request({ model, prompt: "fixture", http: { body: { custom: "original" } } })
      const prepared = yield* LLMClient.prepare(request)
      expect(prepared.transmission?.endpoint).toEqual({
        url: `http://127.0.0.1:${server.port}/v1/chat/completions`,
        exact: true,
      })
      Object.assign(request.http!.body!, { custom: "changed" })
      const runtime = LLMClient.layer.pipe(
        Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))),
      )
      yield* LLMClient.streamPrepared(prepared).pipe(Stream.runDrain, Effect.provide(runtime))
      expect(observed).toEqual([prepared.transmission?.body])
      expect(observed[0]).toMatchObject({ custom: "original" })
    }),
  10000,
)

it.effect("describes the actual HTTP body after overlays without exposing transport authentication", () =>
  Effect.gen(function* () {
    const request = LLM.request({
      model: OpenAIChat.route
        .with({
          endpoint: { baseURL: "https://fixture.invalid/v1" },
          auth: Auth.bearer("transport-auth-fixture"),
        })
        .model({ id: "fake-model" }),
      prompt: "fixture",
      http: { body: { custom: { version: "before" } } },
    })
    const prepared = yield* LLMClient.prepare(request)
    expect(prepared.transmission).toMatchObject({
      transport: "http-json",
      body: { custom: { version: "before" } },
    })
    expect(JSON.stringify(prepared.transmission)).not.toContain("transport-auth-fixture")
    expect(prepared.body).not.toHaveProperty("custom")
    Object.assign(request.http!.body!, { custom: { version: "after" } })
    let observed: unknown
    const runtime = dynamicResponse(({ text, respond }) =>
      Effect.sync(() => {
        observed = decode(text)
        return respond(sseEvents(deltaChunk({ content: "done" }, "stop")), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    )
    yield* LLMClient.streamPrepared(prepared).pipe(Stream.runDrain, Effect.provide(runtime))
    expect(observed).toEqual(prepared.transmission?.body)
  }),
)

it.effect("sends the original preparation despite later route defaults and endpoint changes", () =>
  Effect.gen(function* () {
    const temperatures = { temperature: 0.1 }
    const route = OpenAIChat.route.with({
      endpoint: { baseURL: "https://before.invalid/v1" },
      auth: Auth.bearer("fixture-only"),
      generation: temperatures,
    })
    const request = LLM.request({ model: route.model({ id: "fake-model" }), prompt: "fixture" })
    const seen: Array<{ url: string; body: unknown }> = []
    const runtime = dynamicResponse(({ request, text, respond }) =>
      Effect.sync(() => {
        seen.push({ url: request.url, body: decode(text) })
        return respond(sseEvents(deltaChunk({ content: "done" }, "stop")), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    )
    const prepared = yield* LLMClient.prepare(request)
    // Simulate JavaScript callers changing defaults after admission.
    Object.assign(route.defaults.generation!, { temperature: 0.9 })
    Object.assign(route.endpoint, { baseURL: "https://after.invalid/v1" })
    yield* LLMClient.streamPrepared(prepared).pipe(Stream.runDrain, Effect.provide(runtime))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe("https://before.invalid/v1/chat/completions")
    expect(seen[0]?.body).toEqual(prepared.body)
    expect(seen[0]?.body).toMatchObject({ temperature: 0.1 })
    const repeated = yield* LLMClient.streamPrepared(prepared).pipe(
      Stream.runDrain,
      Effect.flip,
      Effect.provide(runtime),
    )
    expect(repeated.reason._tag).toBe("InvalidRequest")
    expect(seen).toHaveLength(1)
  }),
)

it.effect("describes and sends the encoded WebSocket frame, not the protocol preview", () =>
  Effect.gen(function* () {
    let sent: unknown
    const model = OpenAI.configure({
      apiKey: "websocket-auth-fixture",
      baseURL: "https://fixture.invalid/v1",
    }).responsesWebSocket("fake-model")
    const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "fixture" }))
    expect(prepared.transmission).toMatchObject({ transport: "websocket-json", body: { type: "response.create" } })
    expect(prepared.body).not.toHaveProperty("type", "response.create")
    expect(JSON.stringify(prepared.transmission)).not.toContain("websocket-auth-fixture")
    const runtime = LLMClient.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(RequestExecutor.Service, { execute: () => Effect.die("HTTP must not execute") }),
          Layer.succeed(
            WebSocketExecutor.Service,
            WebSocketExecutor.Service.of({
              open: () =>
                Effect.succeed({
                  sendText: (text) =>
                    Effect.sync(() => {
                      sent = decode(text)
                    }),
                  close: Effect.void,
                  messages: Stream.make(
                    JSON.stringify({
                      type: "response.completed",
                      response: { id: "resp_fixture", status: "completed", output: [] },
                    }),
                  ),
                }),
            }),
          ),
        ),
      ),
    )
    yield* LLMClient.streamPrepared(prepared).pipe(Stream.runDrain, Effect.provide(runtime))
    expect(sent).toEqual(prepared.transmission?.body)
  }),
)

it.effect("marks a redacted prepared endpoint as non-exact without exposing URL credentials", () =>
  Effect.gen(function* () {
    const model = OpenAIChat.route
      .with({
        endpoint: {
          baseURL: "https://fixture-user:fixture-password@fixture.invalid/v1",
          query: { api_key: "query-fixture", debug: "1" },
        },
        auth: Auth.none,
      })
      .model({ id: "fake-model" })
    const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "fixture" }))
    expect(prepared.transmission?.endpoint?.exact).toBe(false)
    const description = JSON.stringify(prepared.transmission)
    for (const secret of ["fixture-user", "fixture-password", "query-fixture"])
      expect(description).not.toContain(secret)
    expect(description).toContain("debug=1")
  }),
)

for (const scenario of ["copy", "mutated", "mutated-transmission", "mutated-endpoint"] as const) {
  it.effect(`rejects a ${scenario} preparation without sending or recompiling`, () =>
    Effect.gen(function* () {
      let calls = 0
      const runtime = dynamicResponse(({ respond }) =>
        Effect.sync(() => {
          calls++
          return respond("")
        }),
      )
      const route = OpenAIChat.route.with({
        endpoint: { baseURL: "https://fixture.invalid/v1" },
        auth: Auth.bearer("fixture-only"),
      })
      const prepared = yield* LLMClient.prepare(
        LLM.request({ model: route.model({ id: "fake-model" }), prompt: "fixture" }),
      )
      const candidate = scenario === "copy" ? new PreparedRequest({ ...prepared }) : prepared
      if (scenario === "mutated-endpoint") {
        if (!candidate.transmission?.endpoint) throw new Error("Expected a prepared endpoint")
        Object.assign(candidate.transmission.endpoint, { url: "https://changed.invalid" })
      } else if (scenario !== "copy") {
        const body = scenario === "mutated-transmission" ? candidate.transmission?.body : candidate.body
        if (typeof body !== "object" || body === null) throw new Error("Expected a request body")
        Object.assign(body, { model: "changed" })
      }
      const error = yield* LLMClient.streamPrepared(candidate).pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.provide(runtime),
      )
      expect(error.reason._tag).toBe("InvalidRequest")
      expect(calls).toBe(0)
    }),
  )
}
