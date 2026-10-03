import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, Probe } from "../src"
import type { Adapter as ProbeAdapter } from "../src/probe"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { RequestExecutor, WebSocketExecutor } from "../src/route"
import { fixedResponse, truncatedStream } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseEvents, sseRaw } from "./lib/sse"

import recordedFixture from "./fixtures/probes/capabilities-v1.json"

const recordedResults = Schema.decodeUnknownSync(Schema.Record(Schema.String, Probe.AdapterResult))(recordedFixture)

const recordedAdapter: ProbeAdapter = {
  id: "recorded-fixture-v1",
  execute: (input) => Effect.succeed(recordedResults[input.id] ?? new Probe.AdapterResult({ outcome: "unsupported" })),
}

describe("capability probe contract", () => {
  test("runs the offline recorded fixture without persisting provider content", async () => {
    const report = await Effect.runPromise(Probe.run(recordedAdapter))

    expect(report.version).toBe("v1")
    expect(report.adapter).toBe("recorded-fixture-v1")
    expect(report.observations.map((observation) => observation.outcome)).toEqual([
      "supported",
      "supported",
      "unsupported",
      "supported",
    ])
    expect(report.observations.every((observation) => observation.probeCase.prompt === Probe.FIXED_PROMPT)).toBe(true)
    expect(JSON.stringify(report)).not.toContain("provider")
  })

  test("does not allow an adapter to replace the fixed prompt", () => {
    expect(
      () =>
        new Probe.ProbeCase({
          id: "unsafe",
          capability: "text-generation",
          prompt: "user session content" as typeof Probe.FIXED_PROMPT,
        }),
    ).toThrow()
  })
})

const model = OpenAIChat.route.with({ endpoint: { baseURL: "https://probe.local" } }).model({ id: "probe-model" })
const request = LLM.request({ model, prompt: Probe.FIXED_PROMPT })

const faultAdapter = (id: string): ProbeAdapter => ({
  id,
  execute: (input) =>
    LLMClient.generate(request).pipe(
      Effect.as(new Probe.AdapterResult({ outcome: "supported" })),
      Effect.mapError((error) => Probe.fromLLMError(input.capability, error)),
    ),
})

const fetchRuntime = (() => {
  const requestExecutor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))
  const dependencies = Layer.mergeAll(requestExecutor, WebSocketExecutor.layer)
  return Layer.mergeAll(dependencies, LLMClient.layer.pipe(Layer.provide(dependencies)))
})()

const faultAdapterFor = (id: string, faultRequest: typeof request): ProbeAdapter => ({
  id,
  execute: (input) =>
    LLMClient.generate(faultRequest).pipe(
      Effect.as(new Probe.AdapterResult({ outcome: "supported" })),
      Effect.mapError((error) => Probe.fromLLMError(input.capability, error)),
    ),
})

describe("capability probe local fault transport", () => {
  test("records HTTP 429 as a retryable rate-limit failure through loopback HTTP", async () => {
    using server = Bun.serve({
      port: 0,
      fetch: () => new Response("rate limited", { status: 429, headers: { "retry-after-ms": "0" } }),
    })
    const loopbackModel = OpenAIChat.route
      .with({ endpoint: { baseURL: `http://127.0.0.1:${server.port}` } })
      .model({ id: "probe-model" })
    const loopbackRequest = LLM.request({ model: loopbackModel, prompt: Probe.FIXED_PROMPT })
    const report = await Effect.runPromise(
      Probe.run(faultAdapterFor("loopback-429", loopbackRequest), [Probe.ProbeCase.fixed("text-generation")]).pipe(
        Effect.provide(fetchRuntime),
      ),
    )

    expect(report.observations[0]?.failure).toMatchObject({
      code: "rate-limit",
      status: 429,
      retryable: true,
    })
  })

  test("records HTTP 503 as a retryable provider-internal failure", async () => {
    const report = await Effect.runPromise(
      Probe.run(faultAdapter("local-503"), [Probe.ProbeCase.fixed("text-generation")]).pipe(
        Effect.provide(
          fixedResponse("temporarily unavailable", {
            status: 503,
            headers: { "retry-after-ms": "0" },
          }),
        ),
      ),
    )

    expect(report.observations[0]?.failure).toMatchObject({
      code: "provider-internal",
      status: 503,
      retryable: true,
    })
  })

  test("records a malformed SSE event as invalid provider output", async () => {
    const report = await Effect.runPromise(
      Probe.run(faultAdapter("local-malformed-stream"), [Probe.ProbeCase.fixed("streaming")]).pipe(
        Effect.provide(fixedResponse(sseRaw(`data: ${JSON.stringify(deltaChunk({ content: 123 }))}`, "data: [DONE]"))),
      ),
    )

    expect(report.observations[0]?.failure).toMatchObject({ code: "invalid-output" })
  })

  test("records a disconnected stream as terminal-loss provider output failure", async () => {
    const report = await Effect.runPromise(
      Probe.run(faultAdapter("local-disconnect"), [Probe.ProbeCase.fixed("streaming")]).pipe(
        Effect.provide(
          truncatedStream([`data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}\n\n`]),
        ),
      ),
    )

    expect(report.observations[0]?.failure).toMatchObject({ code: "invalid-output" })
  })
})

test("response predicates only expose capability booleans", () => {
  const response = {
    text: "OK",
    events: [
      { type: "text-delta", id: "text-0", text: "OK" },
      { type: "tool-call", id: "call-0", name: "probe", input: {} },
    ],
  } as unknown as Parameters<typeof Probe.responseSupports.text>[0]

  expect(Probe.responseSupports.text(response)).toBe(true)
  expect(Probe.responseSupports.streaming(response)).toBe(true)
  expect(Probe.responseSupports.toolCalling(response)).toBe(true)
  expect(sseEvents({ ok: true })).toContain("data:")
})
