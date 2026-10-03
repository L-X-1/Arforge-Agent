import { describe, expect, test } from "bun:test"
import { LLM, LLMError, LLMResponse, Message, RateLimitReason, ToolDefinition, Usage } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-chat"
import * as LLMSchema from "@arforge-ai/schema/llm"
import { Schema } from "effect"
import { LLMUnified } from "../src/llm-unified"

const model = OpenAIChat.route.model({ id: "unified-model" })
const request = LLM.request({
  model,
  system: "Be concise.",
  messages: [Message.user("First"), Message.assistant("Second")],
  tools: [
    ToolDefinition.make({
      name: "lookup",
      description: "Lookup a value.",
      inputSchema: { type: "object", properties: { key: { type: "string" } } },
    }),
  ],
})

const response = LLMResponse.fromEvents([
  { type: "text-start", id: "text-0" },
  { type: "text-delta", id: "text-0", text: "Hello" },
  { type: "text-end", id: "text-0" },
  { type: "tool-input-start", id: "call-0", name: "lookup" },
  { type: "tool-input-delta", id: "call-0", name: "lookup", text: '{"key":"value"}' },
  { type: "tool-input-end", id: "call-0", name: "lookup" },
  { type: "tool-call", id: "call-0", name: "lookup", input: { key: "value" } },
  {
    type: "finish",
    reason: "tool-calls",
    usage: new Usage({
      inputTokens: 10,
      outputTokens: 5,
      nonCachedInputTokens: 8,
      cacheReadInputTokens: 2,
      totalTokens: 15,
    }),
  },
])

if (!response) throw new Error("expected complete fixture response")

describe("LLMUnified", () => {
  test("builds stable request digests without retaining message or tool bodies", () => {
    const unified = LLMUnified.makeRequest({
      request,
      contextPackageDigest: LLMUnified.sha256("context-package-v1"),
      modelProfileRevision: "profile-v1-revision-1",
      budget: { maxInputTokens: 1_000, maxOutputTokens: 200, maxCostCents: 25 },
    })

    expect(unified).toMatchObject({
      version: "v1",
      providerID: "openai",
      modelID: "unified-model",
      modelProfileRevision: "profile-v1-revision-1",
      budget: { maxInputTokens: 1_000, maxOutputTokens: 200, maxCostCents: 25 },
    })
    expect(unified.messagesDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(unified.toolSchemaDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(unified)).not.toContain("First")
    expect(JSON.stringify(unified)).not.toContain("Lookup a value")
  })

  test("normalizes stream fragments, finish, usage, tool calls, retry evidence, and provider id", () => {
    const unified = LLMUnified.makeResponse({
      response,
      providerRequestID: "req_provider_1",
      retry: {
        attempts: 2,
        retried: true,
        fallbacks: [{ fromRoute: "openai-chat", toRoute: "openai-responses", reason: "provider-internal" }],
      },
    })

    expect(unified).toMatchObject({
      version: "v1",
      finishReason: "tool-calls",
      providerRequestID: "req_provider_1",
      retry: { attempts: 2, retried: true },
      usage: { inputTokens: 10, cacheReadInputTokens: 2, totalTokens: 15 },
      toolCalls: [{ id: "call-0", name: "lookup", input: { key: "value" } }],
    })
    expect(unified.streamFragments.map((fragment) => fragment.kind)).toEqual(["text", "tool-input"])
  })

  test("keeps error evidence category-only and round-trips the unified exchange schema", () => {
    const error = new LLMError({
      module: "test",
      method: "request",
      reason: new RateLimitReason({ message: "secret provider body", retryAfterMs: 0 }),
    })
    const exchange = LLMUnified.makeExchange({
      request,
      contextPackageDigest: LLMUnified.sha256("context-package-v1"),
      modelProfileRevision: "profile-v1-revision-1",
      budget: {},
      response,
      error: LLMUnified.redactedError(error),
    })
    const encoded = Schema.encodeSync(LLMSchema.Unified.Exchange)(exchange)
    const decoded = Schema.decodeUnknownSync(LLMSchema.Unified.Exchange)(encoded)

    expect(decoded.response.error).toMatchObject({ category: "rate-limit", retryable: true })
    expect(JSON.stringify(encoded)).not.toContain("secret provider body")
  })
})
