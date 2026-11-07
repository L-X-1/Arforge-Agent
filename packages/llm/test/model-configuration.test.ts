import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, ReasoningOptions } from "../src"
import { LLMClient, Route } from "../src/route"
import * as Chat from "../src/protocols/openai-compatible-chat"
import * as Responses from "../src/protocols/openai-responses"
import * as Anthropic from "../src/protocols/anthropic-messages"

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

test("compatible Chat serializes distinct low/high/max and caps the final output", () => {
  for (const effort of ["low", "high", "max"] as const) {
    const model = Chat.route
      .with({ provider: "owned-test", endpoint: { baseURL: "https://owned.invalid/v1" }, limits: { output: 384 } })
      .model({ id: "deepseek-flash" })
    const prepared = Effect.runSync(
      LLMClient.prepare(
        LLM.request({
          model,
          prompt: "Offline only",
          generation: { maxTokens: 1000000, reasoning: new ReasoningOptions({ mode: "enabled", effort }) },
          http: { body: { custom_mode: "retained" } },
        }),
      ),
    )
    const body = object(prepared.transmission!.body)
    expect(body.reasoning_effort).toBe(effort)
    expect(body.thinking).toEqual({ type: "enabled" })
    expect(body.max_tokens).toBe(384)
    expect(body.model).toBe("deepseek-flash")
    expect(body.custom_mode).toBe("retained")
    expect(prepared.transmission!.endpoint!.url).toBe("https://owned.invalid/v1/chat/completions")
  }
})

test("off suppresses effort while default omits reasoning controls and retains the output cap", () => {
  const model = Chat.route
    .with({ provider: "owned-test", endpoint: { baseURL: "https://owned.invalid/v1" }, limits: { output: 384 } })
    .model({ id: "deepseek-flash" })
  const off = Effect.runSync(
    LLMClient.prepare(
      LLM.request({
        model,
        prompt: "Offline",
        generation: { reasoning: new ReasoningOptions({ mode: "disabled", effort: "high" }) },
      }),
    ),
  )
  const automatic = Effect.runSync(LLMClient.prepare(LLM.request({ model, prompt: "Offline" })))
  expect(object(off.transmission!.body).thinking).toEqual({ type: "disabled" })
  expect(object(off.transmission!.body).reasoning_effort).toBeUndefined()
  expect(object(automatic.transmission!.body).thinking).toBeUndefined()
  expect(object(automatic.transmission!.body).reasoning_effort).toBeUndefined()
  expect(object(automatic.transmission!.body).max_tokens).toBe(384)
})

test("Responses and Anthropic native serializers keep the canonical model budget authoritative", () => {
  const responses = Responses.route.with({ limits: { output: 384 } }).model({ id: "verified-response-model" })
  const first = Effect.runSync(
    LLMClient.prepare(
      LLM.request({
        model: responses,
        prompt: "Offline",
        generation: { maxTokens: 1000000, reasoning: new ReasoningOptions({ effort: "max" }) },
      }),
    ),
  )
  expect(object(first.transmission!.body).max_output_tokens).toBe(384)
  expect(object(first.transmission!.body).reasoning).toEqual({ effort: "max" })
  const anthropic = Anthropic.route.with({ limits: { output: 384 } }).model({ id: "verified-adaptive-model" })
  const second = Effect.runSync(
    LLMClient.prepare(
      LLM.request({
        model: anthropic,
        prompt: "Offline",
        generation: { maxTokens: 1000000, reasoning: new ReasoningOptions({ mode: "adaptive", effort: "high" }) },
      }),
    ),
  )
  expect(object(second.transmission!.body).max_tokens).toBe(384)
  expect(object(second.transmission!.body).thinking).toEqual({ type: "adaptive" })
  expect(object(second.transmission!.body).output_config).toEqual({ effort: "high" })
})

test("final transport clamps a compiler-supplied Responses budget after protocol body construction", () => {
  const original = Responses.protocol
  const route = Route.make({
    id: "compiled-budget-proof",
    protocol: {
      ...original,
      body: {
        ...original.body,
        from: (request) =>
          original.body.from(request).pipe(Effect.map((body) => ({ ...body, max_output_tokens: 1000000 }))),
      },
    },
    endpoint: Responses.route.endpoint,
    transport: Responses.route.transport,
  })
  // Use the real Responses HTTP transport; no HTTP executor is invoked by prepare.
  const model = route
    .with({ provider: "owned-test", limits: { output: 384 }, transport: Responses.route.transport })
    .model({ id: "compiled-wire-id" })
  const prepared = Effect.runSync(
    LLMClient.prepare(LLM.request({ model, prompt: "Offline", generation: { maxTokens: 384 } })),
  )
  expect(object(prepared.body).max_output_tokens).toBe(1000000)
  expect(object(prepared.transmission!.body).max_output_tokens).toBe(384)
})

test("raw protocol-owned HTTP writes remain rejected, including every output alias", () => {
  for (const body of [
    { thinking: { type: "enabled" } },
    { max_output_tokens: 1000000 },
    { max_tokens: 1000000 },
    { max_completion_tokens: 1000000 },
    { maxOutputTokens: 1000000 },
    { generation_config: { max_output_tokens: 1000000 } },
  ]) {
    const model = Responses.route.with({ limits: { output: 384 } }).model({ id: "wire-unchanged" })
    const result = Effect.runSync(
      Effect.result(LLMClient.prepare(LLM.request({ model, prompt: "Offline", http: { body } }))),
    )
    expect(result._tag).toBe("Failure")
  }
})
