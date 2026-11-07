import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ConfigProvider } from "../src/config/provider"
import { ModelV2 } from "../src/model"
import { Catalog } from "../src/catalog"
import { Credential } from "../src/credential"
import { Integration } from "../src/integration"
import { ModelPresets } from "../src/model-presets"
import { ProviderModelConfiguration } from "../src/provider-model-configuration"
import { SessionRunnerModel } from "../src/session/runner/model"
import { runSavedModelTest, TEST_TIMEOUT_MS } from "../src/provider-model-test"
import { LLM } from "../../llm/src"
import { LLMClient } from "../../llm/src/route"
import snapshot from "../assets/models.json"

const api = {
  type: "aisdk" as const,
  package: "@ai-sdk/openai-compatible",
  url: "https://owned.invalid/v1",
  settings: {},
}
const catalog = ModelPresets.project(snapshot)
const preset = { origin: { vendorID: "deepseek", modelID: "deepseek-flash" }, revision: catalog.revision }
const input = { providerID: "owned", modelID: "logical", revision: "r1" }
test("public reasoning variants cannot add sampling controls accepted from existing local configuration", () => {
  expect(() =>
    ProviderModelConfiguration.merge(
      [{ id: "wire", name: "Wire", variants: [{ id: "sampling", body: { temperature: 0.3 } }] }],
      {},
      api,
    ),
  ).toThrow("Variant body cannot own sampling controls.")
})
const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", model: "wire-original", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const responseText = (content = "OK.", finish = "stop") =>
  frame({ reasoning_content: "owned reasoning" }) + frame({ content }) + frame({}, finish) + "data: [DONE]\n\n"

function fixture(
  options: {
    status?: number
    body?: string
    disabled?: boolean
    modelDisabled?: boolean
    active?: boolean
    mismatch?: boolean
    pending?: boolean
    staleAfter?: boolean
  } = {},
) {
  let revision = "r1",
    calls = 0,
    interrupted = 0
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  const selected = structuredClone(
    ModelV2.Info.empty(
      ModelV2.Ref.make({ id: ModelV2.ID.make("logical"), providerID: "owned" as never }).providerID,
      ModelV2.ID.make("logical"),
    ),
  ) as ModelV2.MutableInfo
  selected.api = { ...api, id: ModelV2.ID.make("wire-original") }
  selected.limit = { context: 91000, output: 2048 }
  selected.request.variant = "max"
  selected.variants = [
    {
      id: ModelV2.VariantID.make("max"),
      headers: {},
      body: { thinking: { type: "enabled" }, reasoning_effort: "max" },
    },
  ]
  const provider = Schema.decodeUnknownSync(ConfigProvider.Info)({
    api,
    authentication: "optional",
    disabled: options.disabled ?? false,
    models: { logical: { name: "Owned", disabled: options.modelDisabled ?? false } },
  })
  const snapshotValue = {
    value: Credential.Key.make({
      type: "key",
      key: "owned-synthetic-in-memory",
      metadata: options.mismatch ? { "arforge.provider.target.v1": "wrong-target" } : {},
    }),
  }
  const started = Deferred.makeUnsafe<void>()
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
      requests.push({ url: request.url, body: JSON.parse(yield* Effect.promise(() => web.text())) })
      yield* Deferred.succeed(started, undefined)
      if (options.pending) return yield* Effect.never
      if (options.staleAfter) revision = "r2"
      return HttpClientResponse.fromWeb(
        request,
        new Response(options.body ?? responseText(), {
          status: options.status ?? 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted++
        }),
      ),
    ),
  )
  const run = runSavedModelTest(input, {
    read: Effect.succeed(provider),
    revision: () => revision,
    conflict: () => new Error("owned-revision-conflict"),
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(Catalog.Service, {
      provider: { get: () => Effect.succeed(undefined) },
      model: { get: () => Effect.succeed(selected) },
    } as never),
    Effect.provideService(Integration.Service, {
      connection: {
        active: () => Effect.succeed(options.active ? { type: "env", name: "OWNED_FAKE_ENV_NOT_READ" } : undefined),
        resolveSnapshot: () => Effect.succeed(snapshotValue),
      },
    } as never),
    Effect.provideService(Credential.Service, {
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
    } as never),
  )
  return { run, started, requests, calls: () => calls, interrupted: () => interrupted }
}

test("official preset fields never acquire raw-cache gaps, regional copies or subtraction-derived input", () => {
  expect(ModelPresets.manifest.entries.length).toBe(64)
  expect(
    ModelPresets.manifest.entries.every(
      (entry) => entry.provenance.length > 0 && entry.provenance.every((source) => source.source === "official"),
    ),
  ).toBe(true)
  const source = ModelPresets.manifest.entries.find((entry) => entry.source)?.source!
  const changed = structuredClone(snapshot)
  const row = changed[source.providerID as keyof typeof changed].models as Record<string, unknown>
  row[source.modelID] = {
    ...(row[source.modelID] as object),
    limit: { context: 987654321, output: 987654320, input: 987654319 },
    tool_call: true,
    modalities: { input: ["unverified"], output: ["unverified"] },
    reasoning_options: [{ type: "effort", values: ["unverified"] }],
  }
  const before = ModelPresets.project(snapshot).items
  expect(ModelPresets.project(changed).items).toEqual(before)
  expect(catalog.items.find((item) => item.origin.modelID === "gpt-6-astra")?.limit?.input).toBe(922000)
  expect(catalog.items.find((item) => item.origin.modelID === "gpt-5.5")?.limit?.input).toBeUndefined()
  expect(catalog.items.find((item) => item.origin.modelID === "gemini-4-argon")?.limit?.output).toBe(65536)
  expect(catalog.items.find((item) => item.origin.modelID === "mimo-v2.6-pro")?.limit).toEqual({
    context: 1048576,
    output: 131072,
  })
  expect(catalog.items.find((item) => item.origin.modelID === "claude-fable-5-1")?.limit).toBeUndefined()
})

test("new recognized model gets highest verified limits/tier; explicit limits, off, null and old fields win", async () => {
  const automatic = ProviderModelConfiguration.merge(
    [{ id: "deepseek-flash", name: "Flash", preset }],
    {},
    api,
    catalog,
  )["deepseek-flash"]
  expect(automatic.limit?.context).toBe(1048576)
  expect(automatic.limit?.output).toBe(393216)
  expect(automatic.request?.variant).toBe("max")
  const off = ProviderModelConfiguration.merge(
    [{ id: "deepseek-flash", name: "Flash", preset, limit: { output: 7 }, defaultVariant: "none" }],
    {},
    api,
    catalog,
  )["deepseek-flash"]
  expect(off.limit?.output).toBe(7)
  expect(off.request?.variant).toBe("none")
  const explicit = ProviderModelConfiguration.merge(
    [{ id: "deepseek-flash", name: "Flash", preset, defaultVariant: null }],
    {},
    api,
    catalog,
  )["deepseek-flash"]
  expect(explicit.request?.variant).toBeUndefined()
  const old = ProviderModelConfiguration.merge(
    [{ id: "deepseek-flash", name: "Flash", preset, defaultVariant: null }],
    { "deepseek-flash": automatic },
    api,
    catalog,
  )["deepseek-flash"]
  expect(old.request?.variant).toBeUndefined()
  const generic = ProviderModelConfiguration.merge(
    [{ id: "custom", name: "Custom", variants: [{ id: "max", body: { custom_mode: true } }] }],
    {},
    api,
    catalog,
  ).custom
  expect(generic.request?.variant).toBeUndefined()
  for (const [configured, thinking] of [
    [automatic, "enabled"],
    [off, "disabled"],
    [explicit, undefined],
    [old, undefined],
  ] as const) {
    const model = structuredClone(
      ModelV2.Info.empty("owned" as never, ModelV2.ID.make("deepseek-flash")),
    ) as ModelV2.MutableInfo
    model.api = { ...api, id: ModelV2.ID.make("deepseek-flash") }
    model.limit = { context: configured.limit!.context!, output: configured.limit!.output! }
    model.request.variant = configured.request?.variant
    model.variants = (configured.variants ?? []).map((variant) => ({
      id: variant.id,
      body: variant.body ?? {},
      headers: {},
    })) as typeof model.variants
    const runtime = yieldValue(SessionRunnerModel.fromConfiguredModel(model))
    const prepared = yieldValue(
      LLMClient.prepare(
        LLM.request({ model: runtime, prompt: "Owned pure prepare", generation: { maxTokens: 999999 } }),
      ),
    )
    const body = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(prepared.transmission!.body)
    expect(body.max_tokens).toBe(configured.limit!.output)
    expect((body.thinking as { type?: string } | undefined)?.type).toBe(thinking)
  }
})
const yieldValue = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(effect)

test("saved-model test uses real default reasoning + parsed text, wire/source and practical cap without leaking data", async () => {
  const f = fixture()
  const result = await Effect.runPromise(f.run)
  expect(result.outcome).toBe("success")
  expect(result.category).toBe("ok")
  expect(f.calls()).toBe(1)
  expect(f.requests[0].body).toMatchObject({
    model: "wire-original",
    thinking: { type: "enabled" },
    reasoning_effort: "max",
    max_tokens: 512,
  })
  expect(f.requests[0].url).toBe("https://owned.invalid/v1/chat/completions")
  expect(JSON.stringify(result)).not.toContain("owned reasoning")
  expect(JSON.stringify(result)).not.toContain("OK.")
})

for (const [status, body, category] of [
  [401, '{"error":{"message":"owned-secret-error"}}', "authentication"],
  [404, '{"error":{"message":"missing"}}', "model-not-found"],
  [200, '{"ok":true}', "invalid-response"],
  [200, responseText(""), "invalid-response"],
  [200, responseText("partial", "length"), "output-limit"],
  [503, '{"error":{"message":"unavailable"}}', "unknown"],
] as const)
  test(`saved model sanitizes ${status}/${category}, parses real protocol and never retries`, async () => {
    const f = fixture({ status, body })
    const result = await Effect.runPromise(f.run)
    expect(result.outcome).toBe("failure")
    expect(result.category).toBe(category)
    expect(f.calls()).toBe(1)
    expect(JSON.stringify(result)).not.toContain("owned-secret-error")
  })

test("disabled and stale target are rejected before transport; changed revision cannot receive an old success", async () => {
  for (const options of [{ disabled: true }, { modelDisabled: true }, { active: true, mismatch: true }]) {
    const f = fixture(options)
    const result = await Effect.runPromise(f.run)
    expect(result.outcome).toBe("failure")
    expect(f.calls()).toBe(0)
    expect(result.category).toBe(options.mismatch ? "reconnect-required" : "unavailable")
  }
  const stale = fixture({ staleAfter: true })
  const result = await Effect.runPromise(Effect.result(stale.run))
  expect(result._tag).toBe("Failure")
  expect(stale.calls()).toBe(1)
})

test("client cancellation interrupts underlying request and never returns a success", async () => {
  const f = fixture({ pending: true })
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(f.run)
      yield* Deferred.await(f.started)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    }),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(f.interrupted()).toBe(1)
  expect(f.calls()).toBe(1)
})

test("the actual bounded timeout interrupts pending transport and returns a sanitized timeout", async () => {
  const f = fixture({ pending: true })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(f.run)
      yield* Deferred.await(f.started)
      yield* TestClock.adjust(TEST_TIMEOUT_MS + 1)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())),
  )
  expect(result.category).toBe("timeout")
  expect(f.interrupted()).toBe(1)
  expect(f.calls()).toBe(1)
})
