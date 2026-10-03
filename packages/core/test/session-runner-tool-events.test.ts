import { expect, test } from "bun:test"
import { DateTime, Effect, Schema, Stream } from "effect"
import { LLMEvent, Usage } from "@arforge-ai/llm"
import { EventV2 } from "@arforge-ai/core/event"
import { OpaqueArtifact } from "@arforge-ai/core/runtime/artifact-ref"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionV2 } from "@arforge-ai/core/session"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { createLLMEventPublisher } from "@arforge-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_tool_event_test")
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

const capture = (textSuppressed?: () => boolean) => {
  const published: Array<{ readonly type: string; readonly data: unknown }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
      },
      textSuppressed,
    }),
  }
}

const call = LLMEvent.toolCall({ id: "call-image", name: "read", input: { path: "pixel.png" } })

test("interrupted tool publishes bounded output and opaque receipts once without success", async () => {
  const { published, publisher } = capture()
  const reference = OpaqueArtifact.make({
    version: 1,
    kind: "tool_output",
    digest: "d".repeat(64),
    mime: "text/plain",
    sizeBytes: 7,
    owner: { scope: "session", id: String(sessionID) },
    retention: { mode: "session" },
    retrievalHint: { kind: "managed", handle: "interrupted_receipt" },
    createdAt: DateTime.makeUnsafe(1000),
  })
  await Effect.runPromise(publisher.publish(call))
  publisher.retainInterruptedOutput(call.id, {
    output: { structured: { interrupted: true }, content: [{ type: "text", text: "partial" }] },
    outputPaths: ["private-host-path"],
    artifactRefs: [reference],
  })
  await Effect.runPromise(publisher.failUnsettledTools("Tool execution interrupted"))
  await Effect.runPromise(publisher.failUnsettledTools("Tool execution interrupted"))
  const failed = published.filter((event) => event.type === "session.next.tool.failed.1")
  expect(failed).toHaveLength(1)
  expect(failed[0].data).toMatchObject({ content: [{ type: "text", text: "partial" }], artifactRefs: [reference] })
  expect(failed[0].data).not.toHaveProperty("outputPaths")
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  const wire = Schema.encodeSync(SessionEvent.Tool.Failed.data)(
    failed[0].data as typeof SessionEvent.Tool.Failed.data.Type,
  )
  expect(Schema.decodeUnknownSync(SessionEvent.Tool.Failed.data)(wire)).toMatchObject({ artifactRefs: [reference] })
})

test("old failed tool events omit newly optional output fields", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Failed.data)({
    sessionID,
    timestamp: 1000,
    assistantMessageID: SessionMessage.ID.create(),
    callID: "old-failure",
    error: { type: "unknown", message: "interrupted" },
    provider: { executed: false },
  })
  const wire = Schema.encodeSync(SessionEvent.Tool.Failed.data)(decoded)
  for (const key of ["content", "structured", "artifactRefs", "outputPaths"]) expect(wire).not.toHaveProperty(key)
})
const result = LLMEvent.toolResult({
  id: "call-image",
  name: "read",
  result: {
    type: "content",
    value: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
  output: {
    structured: { type: "media", mime: "image/png" },
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png", name: "pixel.png" },
    ],
  },
})

test("local tool success serializes media base64 once and reconstructs from structured content", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success).toBeDefined()
  const serialized = JSON.stringify(success)
  expect(serialized.split(base64)).toHaveLength(2)
  expect(success?.data).not.toHaveProperty("result")

  expect(success?.data).toMatchObject({
    content: [
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" },
    ],
  })
})

test("provider-executed success retains its compatibility result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolCall({ ...call, providerExecuted: true })))
  await Effect.runPromise(publisher.publish(LLMEvent.toolResult({ ...result, providerExecuted: true })))
  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toHaveProperty("result")
})

test("local tool success publishes opaque artifact receipts without requiring a path", async () => {
  const { published, publisher } = capture()
  const reference = OpaqueArtifact.make({
    version: 1,
    kind: "tool_output",
    digest: "c".repeat(64),
    mime: "text/plain",
    sizeBytes: 4,
    owner: { scope: "session", id: String(sessionID) },
    retention: { mode: "session" },
    retrievalHint: { kind: "managed", handle: "tool_receipt" },
    createdAt: DateTime.makeUnsafe(1_000),
  })
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result, [], [reference]))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toMatchObject({ artifactRefs: [reference] })
  expect(success?.data).not.toHaveProperty("outputPaths")
})

test("opaque artifact receipts suppress legacy paths even from mixed producers", async () => {
  const { published, publisher } = capture()
  const reference = OpaqueArtifact.make({
    version: 1,
    kind: "tool_output",
    digest: "d".repeat(64),
    mime: "text/plain",
    sizeBytes: 4,
    owner: { scope: "session", id: String(sessionID) },
    retention: { mode: "session" },
    retrievalHint: { kind: "managed", handle: "tool_mixed_receipt" },
    createdAt: DateTime.makeUnsafe(1_000),
  })
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(publisher.publish(result, ["C:\\private\\tool-output"], [reference]))

  const success = published.find((event) => event.type === "session.next.tool.success.1")
  expect(success?.data).toMatchObject({ artifactRefs: [reference] })
  expect(success?.data).not.toHaveProperty("outputPaths")
})

test("binary failure emits no success event", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(call))
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: call.id,
        name: call.name,
        result: { type: "error", value: "Cannot read binary file" },
      }),
    ),
  )
  expect(published.some((event) => event.type === "session.next.tool.success.1")).toBe(false)
  expect(published.some((event) => event.type === "session.next.tool.failed.1")).toBe(true)
})

test("old success event data containing result still decodes", () => {
  const decoded = Schema.decodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID,
    timestamp: Date.now(),
    assistantMessageID: SessionMessage.ID.create(),
    callID: "call-old",
    structured: { type: "media", mime: "image/png" },
    content: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }],
    result: { type: "content", value: [{ type: "file", uri: `data:image/png;base64,${base64}`, mime: "image/png" }] },
    provider: { executed: false },
  })
  expect(decoded.result).toMatchObject({ type: "content" })
})

test("step finish records settlement without publishing step ended", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.stepStart({ index: 0 })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  expect(published.some((event) => event.type === "session.next.step.ended.2")).toBe(false)
  expect(publisher.stepSettlement()).toMatchObject({ finish: "stop" })
  expect(publisher.stepSettlement()?.usage).toBeUndefined()
})

test("explicit zero step usage stays reported and is not replaced by final usage", async () => {
  const { publisher } = capture()
  const zero = Usage.from({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: zero })))
  await Effect.runPromise(
    publisher.publish(LLMEvent.finish({ reason: "stop", usage: Usage.from({ inputTokens: 9, outputTokens: 1 }) })),
  )
  expect(publisher.stepSettlement()?.usage).toEqual(zero)
  expect(publisher.stepSettlement()?.tokens.input).toBe(0)
})

test("primary delivery discards provisional and later model text", async () => {
  let suppressed = false
  const { published, publisher } = capture(() => suppressed)
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "provisional" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "provisional", text: "temporary" })))
  suppressed = true
  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "provisional" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textStart({ id: "duplicate" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textDelta({ id: "duplicate", text: "hidden tail" })))
  await Effect.runPromise(publisher.publish(LLMEvent.textEnd({ id: "duplicate" })))
  await Effect.runPromise(publisher.flush())

  expect(published.filter((event) => event.type === "session.next.text.ended.1")).toEqual([])
  expect(JSON.stringify(published)).not.toContain("hidden tail")
})
