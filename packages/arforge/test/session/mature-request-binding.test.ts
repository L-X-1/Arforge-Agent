import { LLM, type LLMClientShape } from "@arforge-ai/llm"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@arforge-ai/llm/route"
import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"

import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { MatureRequestBinding } from "@/session/llm/mature-binding"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { ProviderTest } from "../fake/provider"

const endpoint = "https://api.openai.com/v1"
const formalModel = OpenAICompatibleChat.route
  .with({ endpoint: { baseURL: endpoint }, auth: Auth.bearer("fixture-api-key") })
  .model({ id: "gpt-4o-mini", provider: "openai" })

const matureModel = ProviderTest.model({
  id: ModelV2.ID.make("gpt-4o-mini"),
  providerID: ProviderV2.ID.openai,
  api: { id: "gpt-4o-mini", url: endpoint, npm: "@ai-sdk/openai-compatible" },
  options: { apiKey: "fixture-api-key", baseURL: endpoint },
})

const binding = { runID: "run_mature_binding", turnStep: 2, attempt: 1 } as const

describe("mature request binding", () => {
  test("uses the exact native envelope digest without returning request payloads", () => {
    const request = LLM.request({
      model: formalModel,
      prompt: "Do not persist this prompt",
      generation: { maxTokens: 20, temperature: 0 },
    })
    const result = MatureRequestBinding.fromRequest({ request, binding })

    expect(result).toMatchObject({
      schemaVersion: 1,
      runtime: "mature",
      mode: "native-envelope",
      ...binding,
    })
    expect(MatureRequestBinding.isBinding(result)).toBe(true)
    expect(Object.keys(result)).not.toContain("messages")
    expect(JSON.stringify(result)).not.toContain("Do not persist this prompt")

    const otherAttempt = MatureRequestBinding.fromRequest({
      request,
      binding: { ...binding, attempt: 2 },
    })
    expect(otherAttempt.requestDigest).not.toBe(result.requestDigest)
  })

  test("keeps the AI SDK fallback projection deterministic and tool metadata-only", () => {
    const lookup = tool({
      description: "Look up a value",
      inputSchema: jsonSchema({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      }),
      execute: async () => "secret tool output",
    })
    const result = MatureRequestBinding.fromPrepared({
      model: matureModel,
      system: ["You are concise."],
      messages: [{ role: "user", content: "Use the lookup tool." }],
      tools: { lookup },
      toolChoice: "auto",
      maxOutputTokens: 128,
      providerOptions: { openai: { store: false } },
      binding,
    })

    expect(result.mode).toBe("prepared-projection")
    expect(MatureRequestBinding.isBinding(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("Use the lookup tool")
    expect(JSON.stringify(result)).not.toContain("secret tool output")

    const reordered = MatureRequestBinding.fromPrepared({
      model: matureModel,
      system: ["You are concise."],
      messages: [{ role: "user", content: "Use the lookup tool." }],
      tools: { lookup },
      toolChoice: "auto",
      maxOutputTokens: 128,
      providerOptions: { openai: { store: false } },
      binding: { ...binding },
    })
    expect(reordered).toEqual(result)
  })

  test("binds the immutable Skill snapshot digest without exposing Skill content", () => {
    const first = MatureRequestBinding.fromRequest({
      request: LLM.request({ model: formalModel, prompt: "skill-aware request" }),
      binding: { ...binding, skillSnapshotDigest: "a".repeat(64) },
    })
    const second = MatureRequestBinding.fromRequest({
      request: LLM.request({ model: formalModel, prompt: "skill-aware request" }),
      binding: { ...binding, skillSnapshotDigest: "b".repeat(64) },
    })
    expect(first.skillSnapshotDigest).toBe("a".repeat(64))
    expect(first.requestDigest).not.toBe(second.requestDigest)
    expect(MatureRequestBinding.isBinding(first)).toBe(true)
    expect(JSON.stringify(first)).not.toContain("skill-aware request")
    expect(() =>
      MatureRequestBinding.fromRequest({
        request: LLM.request({ model: formalModel, prompt: "skill-aware request" }),
        binding: { ...binding, skillSnapshotDigest: "not-a-digest" },
      }),
    ).toThrow("skill snapshot digest")
  })

  test("fails closed when a durable attempt binding is incomplete", () => {
    expect(() =>
      MatureRequestBinding.fromRequest({
        request: LLM.request({ model: formalModel, prompt: "hello" }),
        binding: { ...binding, attempt: 0 },
      }),
    ).toThrow("attempt must be positive")
  })

  test("carries the binding through the native runtime without changing stream ownership", () => {
    const client: LLMClientShape = {
      streamPrepared: () => {
        throw new Error("streamPrepared is not used by this construction test")
      },
      prepare: () => {
        throw new Error("prepare is not used by this construction test")
      },
      stream: () => {
        throw new Error("stream is not consumed by this construction test")
      },
      generate: () => {
        throw new Error("generate is not used by this construction test")
      },
    }
    const result = LLMNativeRuntime.stream({
      model: matureModel,
      provider: { ...ProviderTest.info({}, matureModel), options: { apiKey: "fixture-api-key" } },
      auth: undefined,
      llmClient: client,
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      headers: {},
      abort: new AbortController().signal,
      requestBinding: binding,
    })
    expect(result.type).toBe("supported")
    if (result.type === "unsupported") throw new Error(result.reason)
    expect(result.binding).toMatchObject({ mode: "native-envelope", ...binding })
    expect(MatureRequestBinding.isBinding(result.binding)).toBe(true)
  })
})
