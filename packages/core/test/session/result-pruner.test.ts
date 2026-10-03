import { expect, test } from "bun:test"

import { LLM, Message, Model as LLMModel } from "@arforge-ai/llm"
import { ResultPruner } from "@arforge-ai/core/session/result-pruner"
import {
  assertRequestEnvelope,
  createRequestEnvelope,
  parseRequestEnvelopeJson,
  rebuildRequest,
  requestEnvelopeJson,
} from "@arforge-ai/core/session/request-envelope"

const smallConfig = {
  thresholdChars: ResultPruner.codePointLength(ResultPruner.PRUNE_MARKER) + 7,
  headChars: 4,
  tailChars: 3,
}

const model = LLMModel.make({
  id: "result-pruner-model",
  provider: "test-provider",
  route: {
    id: "result-pruner-route",
    protocol: "openai-chat",
    endpoint: { baseURL: "https://provider.example/v1" },
  } as never,
})

test("retains Unicode-safe head and tail while preserving rich-block order", () => {
  const original = Message.tool({
    id: "call-rich",
    name: "inspect",
    resultType: "content",
    result: [
      { type: "text", text: "😀".repeat(40) },
      { type: "file", uri: "artifact:first", mime: "image/png", name: "first.png" },
      { type: "text", text: "B".repeat(30) },
      { type: "file", uri: "artifact:second", mime: "application/pdf", name: "second.pdf" },
      { type: "text", text: "C".repeat(30) },
    ],
  })
  const before = JSON.stringify(original)
  const result = ResultPruner.pruneMessages([original], smallConfig)
  const part = result.messages[0]?.content[0]
  expect(result.changed).toBe(true)
  expect(result.pruned).toEqual([
    expect.objectContaining({ toolCallID: "call-rich", charsBefore: 100, charsAfter: smallConfig.thresholdChars }),
  ])
  expect(part?.type === "tool-result" && part.result.type === "content" ? part.result.value : []).toEqual([
    { type: "text", text: `${"😀".repeat(4)}${ResultPruner.PRUNE_MARKER}` },
    { type: "file", uri: "artifact:first", mime: "image/png", name: "first.png" },
    { type: "file", uri: "artifact:second", mime: "application/pdf", name: "second.pdf" },
    { type: "text", text: "CCC" },
  ])
  expect(JSON.stringify(original)).toBe(before)
  expect(JSON.stringify(result.messages)).not.toContain("\uFFFD")
})

test("preserves the call/result pair and converges after one deterministic pass", () => {
  const call = Message.assistant({ type: "tool-call", id: "call-1", name: "bash", input: { command: "test" } })
  const tool = Message.tool({ id: "call-1", name: "bash", result: "x".repeat(100), resultType: "text" })
  const first = ResultPruner.pruneMessages([call, tool], smallConfig)
  const second = ResultPruner.pruneMessages(first.messages, smallConfig)
  expect(first.messages[0]).toBe(call)
  expect(first.messages[1]?.content[0]).toMatchObject({ type: "tool-result", id: "call-1", name: "bash" })
  expect(first.charsRemoved).toBeGreaterThan(0)
  expect(second.changed).toBe(false)
  expect(second.messages).toEqual(first.messages)
})

test("rejects stale policy keys and impossible output budgets", () => {
  expect(Object.isFrozen(ResultPruner.DEFAULT_CONFIG)).toBe(true)
  expect(() => ResultPruner.resolveConfig({ thresholdChars: 0 })).toThrow("positive safe integer")
  expect(() => ResultPruner.resolveConfig({ thresholdChars: 50, headChars: 40, tailChars: 20 })).toThrow(
    "exceeds thresholdChars",
  )
  expect(() => ResultPruner.resolveConfig({ threshold: 5 } as never)).toThrow("Unknown ResultPruner config key")
})

test("persists and rebuilds the exact pruned provider request while the source message stays intact", () => {
  const source = Message.tool({ id: "call-envelope", name: "read", result: "z".repeat(100), resultType: "text" })
  const projected = ResultPruner.pruneMessages([source], smallConfig)
  const request = LLM.request({ model, messages: projected.messages })
  const envelope = createRequestEnvelope({
    request,
    execution: { run_id: "run-pruner", turn_step: 1, context_digest: "context-pruner-v1" },
  })
  const serialized = requestEnvelopeJson(envelope)
  const persisted = parseRequestEnvelopeJson(serialized)
  const rebuilt = rebuildRequest(persisted, model)
  expect(assertRequestEnvelope(persisted, rebuilt)).toBe(true)
  expect(rebuilt.messages).toEqual(projected.messages)
  expect(serialized).not.toContain("z".repeat(100))
  expect(source.content[0]).toMatchObject({ result: { value: "z".repeat(100) } })
})
