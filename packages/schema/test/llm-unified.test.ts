import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import * as LLM from "../src/llm"

const digest = "a".repeat(64)

const exchange: LLM.Unified.Exchange = {
  request: {
    version: "v1",
    providerID: "openai",
    modelID: "model-v1",
    messagesDigest: digest,
    contextPackageDigest: digest,
    toolSchemaDigest: digest,
    modelProfileRevision: "profile-v1",
    budget: {},
  },
  response: {
    version: "v1",
    streamFragments: [{ sequence: 0, kind: "text", id: "text-0", text: "OK" }],
    finishReason: "stop",
    toolCalls: [],
    retry: { attempts: 1, retried: false, fallbacks: [] },
  },
}

describe("LLM.Unified", () => {
  test("round-trips the provider-neutral exchange and omits absent optional fields", () => {
    const encoded = Schema.encodeSync(LLM.Unified.Exchange)(exchange)
    const decoded = Schema.decodeUnknownSync(LLM.Unified.Exchange)(encoded)

    expect(decoded).toEqual(exchange)
    expect(encoded.request).not.toHaveProperty("deadlineAt")
    expect(encoded.response).not.toHaveProperty("usage")
    expect(encoded.response).not.toHaveProperty("providerRequestID")
    expect(encoded.response).not.toHaveProperty("error")
  })

  test("rejects malformed digests and unsupported finish reasons", () => {
    const encoded = Schema.encodeSync(LLM.Unified.Exchange)(exchange)

    expect(() =>
      Schema.decodeUnknownSync(LLM.Unified.Exchange)({
        ...encoded,
        request: { ...encoded.request, messagesDigest: "not-a-digest" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(LLM.Unified.Exchange)({
        ...encoded,
        response: { ...encoded.response, finishReason: "provider-specific" },
      }),
    ).toThrow()
  })
})
