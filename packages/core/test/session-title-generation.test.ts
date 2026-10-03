import { expect } from "bun:test"
import { LLMClient, LLMEvent, Message, Model, Usage } from "@arforge-ai/llm"
import * as OpenAIChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import { Auth } from "@arforge-ai/llm/route"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"
import type { AgentV2 } from "../src/agent"
import { generate, prepare } from "../src/session/title-generation"
import {
  assertRequestEnvelope,
  assertPreparedRequestEnvelope,
  createRequestEnvelope,
  rebuildRequest,
} from "../src/session/request-envelope"

const it = testEffect(Layer.empty)
const model = Model.make({
  id: "title-model",
  provider: "test",
  route: OpenAIChat.route.with({ endpoint: { baseURL: "https://title.test/v1/" }, auth: Auth.bearer("fixture") }),
})
const envelope = () =>
  prepare({ text: "Investigate cache invalidation", model, execution: { run_id: "title-run", attempt: 1 } })
const response = [LLMEvent.textDelta({ id: "title", text: "Cache investigation" }), LLMEvent.finish({ reason: "stop" })]

const preparedEnvelope = () =>
  Effect.gen(function* () {
    const common = envelope()
    const request = rebuildRequest(common, model)
    const prepared = yield* LLMClient.prepare(request)
    return {
      prepared,
      envelope: createRequestEnvelope({ request, execution: common.execution, transmission: prepared.transmission }),
    }
  })

it.effect("title consumes the exact prepared object after admission without recompiling", () =>
  Effect.gen(function* () {
    const bound = yield* preparedEnvelope()
    let sent = false
    const result = yield* generate({
      ...bound,
      model,
      authorizeAndRecord: () => Effect.void,
      streamPrepared: (actual) => {
        expect(actual).toBe(bound.prepared)
        expect(assertPreparedRequestEnvelope(bound.envelope, actual)).toBe(true)
        sent = true
        return Stream.fromIterable(response)
      },
    })
    expect(sent).toBe(true)
    expect(result.title).toBe("Cache investigation")
  }),
)

it.effect("title refuses preparation mutation during admission before any send", () =>
  Effect.gen(function* () {
    const bound = yield* preparedEnvelope()
    let calls = 0
    const result = yield* generate({
      ...bound,
      model,
      authorizeAndRecord: () =>
        Effect.sync(() => {
          const body = bound.prepared.transmission?.body
          if (!body || typeof body !== "object") throw new Error("Missing fixture transmission")
          Object.assign(body, { changed: true })
        }),
      streamPrepared: () => {
        calls++
        return Stream.fromIterable(response)
      },
    }).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect(calls).toBe(0)
  }),
)

it.effect("title freezes media-only user content through the shared request envelope", () =>
  Effect.gen(function* () {
    const uri = "data:image/png;base64,aGVsbG8="
    const content = Message.user([{ type: "media", mediaType: "image/png", data: uri }]).content
    const frozen = prepare({ content, model, execution: {} })
    const request = rebuildRequest(frozen, model)
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.role).toBe("user")
    expect(request.messages[0]?.content).toEqual(content)
    expect(assertRequestEnvelope(frozen, request)).toBe(true)
    const prepared = yield* LLMClient.prepare(request)
    expect(JSON.stringify(prepared.body)).toContain(uri)
    expect(request.tools).toEqual([])
  }),
)

it.effect("title preserves configured agent prompt and request in the actual provider preparation", () =>
  Effect.gen(function* () {
    let transportBody = ""
    let profile: string | undefined
    const configuredModel = Model.make({
      id: "title-model",
      provider: "test",
      route: OpenAIChat.route.with({
        endpoint: { baseURL: "https://title.test/v1/" },
        auth: Auth.custom((input) => {
          transportBody = input.body
          profile = input.headers["x-title-profile"]
          return Effect.succeed(input.headers)
        }),
      }),
    })
    const configured = {
      text: "Investigate cache invalidation",
      model: configuredModel,
      execution: {},
      agent: {
        system: "Generate a short Chinese conversation title.",
        request: { headers: { "x-title-profile": "short" }, body: { custom_routing: "maintenance" } },
      },
    }
    const frozen = prepare(configured)
    configured.agent.system = "Changed after preparation"
    configured.agent.request.body.custom_routing = "changed"
    const request = rebuildRequest(frozen, configuredModel)
    expect(request.system).toEqual([{ type: "text", text: "Generate a short Chinese conversation title." }])
    expect(request.http?.headers).toEqual({ "x-title-profile": "short" })
    expect(request.http?.body).toEqual({ custom_routing: "maintenance" })
    expect(request.generation?.maxTokens).toBe(256)
    expect(request.tools).toEqual([])
    expect(assertRequestEnvelope(frozen, request)).toBe(true)
    const prepared = yield* LLMClient.prepare(request)
    expect(JSON.parse(transportBody)).toMatchObject({ custom_routing: "maintenance", max_tokens: 256 })
    expect(profile).toBe("short")
    expect(prepared.body).toMatchObject({
      max_tokens: 256,
      messages: [
        { role: "system", content: "Generate a short Chinese conversation title." },
        { role: "user", content: "Investigate cache invalidation" },
      ],
    })
  }),
)

const forbiddenBodies: AgentV2.Info["request"]["body"][] = [{ tools: [] }, { messages: [] }, { max_tokens: 10000 }]
for (const body of forbiddenBodies)
  it.effect(`title configured body cannot override ${Object.keys(body)[0]}`, () =>
    Effect.gen(function* () {
      const configured = { text: "A title", model, execution: {}, agent: { request: { headers: {}, body } } }
      const request = rebuildRequest(prepare(configured), model)
      const result = yield* LLMClient.prepare(request).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("protocol-owned")
    }),
  )

it.effect("title reports usage before rejecting an empty generated title", () =>
  Effect.gen(function* () {
    const usage = Usage.from({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
    const observed: Usage[] = []
    const result = yield* generate({
      ...(yield* preparedEnvelope()),
      model,
      authorizeAndRecord: () => Effect.void,
      onUsage: (value) => {
        observed.push(value)
      },
      streamPrepared: () => Stream.fromIterable([LLMEvent.finish({ reason: "stop", usage })]),
    }).pipe(Effect.exit)
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ reason: "empty-output" })
    expect(observed).toEqual([usage])
  }),
)

it.effect("title preserves step usage when final finish omits usage", () =>
  Effect.gen(function* () {
    const usage = Usage.from({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
    const result = yield* generate({
      ...(yield* preparedEnvelope()),
      model,
      authorizeAndRecord: () => Effect.void,
      streamPrepared: () =>
        Stream.fromIterable([
          response[0],
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
          LLMEvent.finish({ reason: "stop" }),
        ]),
    })
    expect(result.usage).toEqual(usage)
  }),
)

for (const ending of ["cancel", "timeout", "defect"] as const)
  it.effect(`title retains a received usage receipt through ${ending}`, () =>
    Effect.gen(function* () {
      const usage = Usage.from({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
      const ready = yield* Deferred.make<void>()
      let reported: Usage | undefined
      const fiber = yield* generate({
        ...(yield* preparedEnvelope()),
        model,
        authorizeAndRecord: () => Effect.void,
        onUsage: (value) => {
          reported = value
        },
        streamPrepared: () =>
          Stream.fromIterable([LLMEvent.stepFinish({ index: 0, reason: "stop", usage })]).pipe(
            Stream.concat(
              Stream.fromEffect(
                Deferred.succeed(ready, undefined).pipe(
                  Effect.andThen(ending === "defect" ? Effect.die(new Error("fixture stream defect")) : Effect.never),
                ),
              ),
            ),
          ),
      }).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      if (ending === "cancel") yield* Fiber.interrupt(fiber)
      if (ending === "timeout") yield* TestClock.adjust("30 seconds")
      const result = yield* Fiber.await(fiber)
      expect(reported).toEqual(usage)
      expect(Exit.isFailure(result)).toBe(true)
      if (ending === "cancel") expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
      if (ending === "timeout")
        expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ _tag: "TimeoutError" })
      if (ending === "defect")
        expect(Exit.isFailure(result) && Cause.pretty(result.cause)).toContain("fixture stream defect")
    }),
  )

for (const phase of ["admission", "provider"] as const)
  it.effect(`title timeout interrupts stalled ${phase} and runs cleanup`, () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      let cleaned = false
      let calls = 0
      const stalled = Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            cleaned = true
          }),
        ),
      )
      const fiber = yield* generate({
        ...(yield* preparedEnvelope()),
        model,
        authorizeAndRecord: () => (phase === "admission" ? stalled : Effect.void),
        streamPrepared: () => {
          calls++
          return Stream.fromEffect(stalled)
        },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* TestClock.adjust("30 seconds")
      const result = yield* Fiber.await(fiber)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ _tag: "TimeoutError" })
      expect(cleaned).toBe(true)
      expect(calls).toBe(phase === "admission" ? 0 : 1)
    }),
  )

it.effect("title preserves reported usage for owner settlement", () =>
  Effect.gen(function* () {
    const usage = Usage.from({ inputTokens: 50, outputTokens: 8, totalTokens: 58, cacheReadInputTokens: 20 })
    const result = yield* generate({
      ...(yield* preparedEnvelope()),
      model,
      authorizeAndRecord: () => Effect.void,
      streamPrepared: () => Stream.fromIterable([response[0], LLMEvent.finish({ reason: "stop", usage })]),
    })
    expect(result.title).toBe("Cache investigation")
    expect(result.usage).toEqual(usage)
  }),
)

it.effect("title request is recorded before sending and preserves its exact envelope", () =>
  Effect.gen(function* () {
    const bound = yield* preparedEnvelope()
    const recorded = bound.envelope
    const order: string[] = []
    const title = yield* generate({
      envelope: recorded,
      prepared: bound.prepared,
      model,
      authorizeAndRecord: (value) =>
        Effect.sync(() => {
          expect(value).toBe(recorded)
          order.push("record")
        }),
      streamPrepared: (actual) => {
        expect(actual).toBe(bound.prepared)
        expect(assertPreparedRequestEnvelope(recorded, actual)).toBe(true)
        expect(recorded.request.tools).toEqual([])
        order.push("send")
        return Stream.fromIterable(response)
      },
    })
    expect(title).toEqual({ title: "Cache investigation" })
    expect(order).toEqual(["record", "send"])
  }),
)

it.effect("title admission failure sends no request", () =>
  Effect.gen(function* () {
    let calls = 0
    const result = yield* generate({
      ...(yield* preparedEnvelope()),
      model,
      authorizeAndRecord: () => Effect.fail("denied"),
      streamPrepared: () => {
        calls++
        return Stream.fromIterable(response)
      },
    }).pipe(Effect.exit)
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe("denied")
    expect(calls).toBe(0)
  }),
)

for (const [name, chunks] of [
  ["incomplete", response.slice(0, 1)],
  ["empty-output", [LLMEvent.finish({ reason: "stop" })]],
  ["output-limit", [LLMEvent.textDelta({ id: "title", text: "x".repeat(8193) })]],
] as const)
  it.effect(`title rejects ${name}`, () =>
    Effect.gen(function* () {
      const result = yield* generate({
        ...(yield* preparedEnvelope()),
        model,
        authorizeAndRecord: () => Effect.void,
        streamPrepared: () => Stream.fromIterable(chunks),
      }).pipe(Effect.exit)
      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({ reason: name })
    }),
  )

it.effect("title interruption stays interrupted", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const fiber = yield* generate({
      ...(yield* preparedEnvelope()),
      model,
      authorizeAndRecord: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      streamPrepared: () => Stream.fromEffect(Effect.never),
    }).pipe(Effect.forkChild)
    yield* Deferred.await(ready)
    yield* Fiber.interrupt(fiber)
    const result = yield* Fiber.await(fiber)
    expect(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)).toBe(true)
  }),
)
