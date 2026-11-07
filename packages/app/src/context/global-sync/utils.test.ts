import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import { Agent as RuntimeAgent } from "@arforge-ai/schema/agent"
import { Model as RuntimeModel } from "@arforge-ai/schema/model"
import { Provider as RuntimeProvider } from "@arforge-ai/schema/provider"
import { chooserCapabilityBadges, chooserVariantGroups } from "@/components/dialog-select-model-presentation"
import { deprecatedReasoningVariant, reasoningControlOptions } from "@/components/prompt-input/reasoning-options"
import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  ProviderListOutput,
} from "@arforge-ai/client/promise"
import { directoryKey, normalizeAgentList, normalizePermissionRequest, normalizeProviderList } from "./utils"

describe("normalizeAgentList", () => {
  test("adapts vendored agent settings to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { settings: { temperature: 0.2, topP: 0.9 }, headers: {}, body: {} },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] as AgentListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: 0.2,
        topP: 0.9,
        color: "primary",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { temperature: 0.2, topP: 0.9 },
        steps: undefined,
      },
    ])
  })

  test("accepts the canonical empty agent request without settings", () => {
    const agent = RuntimeAgent.Info.empty(RuntimeAgent.ID.make("build"))

    expect(normalizeAgentList([agent])).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "all",
        hidden: false,
        temperature: undefined,
        topP: undefined,
        color: undefined,
        permission: [],
        model: undefined,
        variant: undefined,
        prompt: undefined,
        options: {},
        steps: undefined,
      },
    ])
  })

  for (const topPKey of ["topP", "top_p"] as const) {
    test("adapts canonical body parameters including " + topPKey, () => {
      const body = { temperature: 0.25, [topPKey]: 0.85, max_tokens: 512 }
      const agent = RuntimeAgent.Info.make({
        ...RuntimeAgent.Info.empty(RuntimeAgent.ID.make("build")),
        request: { headers: { "x-fixture-header": "not-a-model-option" }, body },
        permissions: [{ action: "edit", resource: "*", effect: "ask" }],
      })

      const [result] = normalizeAgentList([agent])
      expect(result).toMatchObject({
        temperature: 0.25,
        topP: 0.85,
        options: body,
        permission: [{ permission: "edit", pattern: "*", action: "ask" }],
      })
      expect(result!.options).not.toHaveProperty("x-fixture-header")
      expect(agent.request.body).toEqual(body)
    })
  }

  test("does not turn nonnumeric body parameters into sampling controls", () => {
    const agent = RuntimeAgent.Info.make({
      ...RuntimeAgent.Info.empty(RuntimeAgent.ID.make("build")),
      request: { headers: {}, body: { temperature: "0.25", topP: false } },
    })

    const [result] = normalizeAgentList([agent])
    expect(result!.temperature).toBeUndefined()
    expect(result!.topP).toBeUndefined()
    expect(result!.options).toEqual({ temperature: "0.25", topP: false })
  })

  test("preserves legacy agents in legacy-only and mixed lists", () => {
    const legacy = { name: "legacy", mode: "primary" as const, hidden: false, permission: [], options: {} }
    const input = [legacy]
    expect(normalizeAgentList(input)).toBe(input)

    const current = RuntimeAgent.Info.empty(RuntimeAgent.ID.make("build"))
    const result = normalizeAgentList([legacy, current])
    expect(result[0]).toBe(legacy)
    expect(result[1]!.name).toBe("build")
    expect(result[1]!.options).toEqual({})
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    const normalized = normalizePermissionRequest({
      id: "permission-1",
      sessionID: "session-1",
      action: "read",
      resources: ["README.md"],
      save: ["*.md"],
      metadata: { path: "README.md" },
      source: { type: "tool", messageID: "message-1", callID: "call-1" },
      requiresHumanConfirmation: true,
    } as Parameters<typeof normalizePermissionRequest>[0]) as ReturnType<typeof normalizePermissionRequest> & {
      requiresHumanConfirmation?: boolean
    }
    expect(normalized).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      requiresHumanConfirmation: true,
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] as ProviderListOutput["data"],
      [
        {
          id: "gpt-5",
          modelID: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          modelID: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelListOutput["data"],
      { id: "gpt-5", providerID: "openai" } as ModelDefaultOutput["data"],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })
})

describe("normalizeProviderList release dates", () => {
  const catalog = (released: number) =>
    normalizeProviderList(
      [{ id: "test", name: "Custom provider", package: "@ai-sdk/openai-compatible" }] as ProviderListOutput["data"],
      [
        {
          id: "custom-model",
          modelID: "custom-model",
          providerID: "test",
          name: "Custom model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 100_000, output: 10_000 },
        },
      ] as ModelListOutput["data"],
      { id: "custom-model", providerID: "test" } as ModelDefaultOutput["data"],
    )

  test.each([0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE])(
    "keeps unknown or invalid release timestamp %s out of the old-model filter",
    (released) => {
      const result = catalog(released)
      const model = result.all.get("test")?.models["custom-model"]
      expect(model?.release_date).toBe("")
      // ModelsProvider already shows unknown dates unless the user hides them.
      expect(DateTime.fromISO(model!.release_date).isValid).toBe(false)
      expect(result.connected).toEqual(["test"])
      expect(result.default).toEqual({ test: "custom-model" })
    },
  )

  test.each([
    [1, "1970-01-01"],
    [Date.UTC(2026, 0, 15, 23, 59), "2026-01-15"],
    [Date.UTC(2026, 8, 15), "2026-09-15"],
  ] as const)("preserves known release timestamp %s as %s", (released, expected) => {
    const model = catalog(released).all.get("test")?.models["custom-model"]
    expect(model?.release_date).toBe(expected)
    expect(DateTime.fromISO(model!.release_date).isValid).toBe(true)
  })

  test("leaves the legacy provider catalog release date unchanged", () => {
    const current = catalog(Date.UTC(2026, 8, 15))
    const provider = current.all.get("test")!
    provider.models["custom-model"].release_date = ""
    const result = normalizeProviderList({
      all: [provider],
      connected: ["test"],
      default: { test: "custom-model" },
    })
    expect(result.all.get("test")?.models["custom-model"].release_date).toBe("")
    expect(result.default).toEqual({ test: "custom-model" })
  })
})

describe("canonical available model to chooser controls", () => {
  const provider = RuntimeProvider.Info.make({
    ...RuntimeProvider.Info.empty(RuntimeProvider.ID.make("relay-original")),
    name: "Configured relay",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", settings: { fixture: true } },
  })
  const base = () =>
    RuntimeModel.Info.make({
      ...RuntimeModel.Info.empty(provider.id, RuntimeModel.ID.make("opaque/local-wire")),
      name: "Local fixture",
      api: {
        id: RuntimeModel.ID.make("relay/unchanged-wire"),
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "http://fixture.invalid",
      },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      limit: { context: 12_345, output: 678 },
    })
  const normalize = (model: RuntimeModel.Info) => {
    const catalog = normalizeProviderList([provider], [model], model)
    return { catalog, model: catalog.all.get(provider.id)!.models[model.id] }
  }

  test("preserves canonical request parameters and lowerer-shaped variants through the real normalizer", () => {
    const input = RuntimeModel.Info.make({
      ...base(),
      request: { headers: { "x-fixture": "kept-as-header" }, body: { temperature: 0.3 } },
      variants: [
        { id: RuntimeModel.VariantID.make("off"), headers: {}, body: { thinking: { type: "disabled" } } },
        { id: RuntimeModel.VariantID.make("auto"), headers: {}, body: { reasoning_effort: "auto" } },
        { id: RuntimeModel.VariantID.make("relay-effort"), headers: {}, body: { reasoning: { effort: "high" } } },
        { id: RuntimeModel.VariantID.make("high"), headers: {}, body: { temperature: 0.1 } },
      ],
    })
    const { catalog, model } = normalize(input)
    expect(catalog.connected).toEqual([provider.id])
    expect(catalog.default).toEqual({ [provider.id]: input.id })
    expect(model.api).toEqual({ id: input.api.id, url: "http://fixture.invalid", npm: "@ai-sdk/openai-compatible" })
    expect(model.options).toEqual(input.request.body)
    expect(model.headers).toEqual(input.request.headers)
    expect(model.limit).toEqual(input.limit)
    expect(chooserCapabilityBadges(model)).toEqual(["vision", "reasoning"])
    const groups = chooserVariantGroups(Object.keys(model.variants!), model.variants)
    expect(groups.reasoning.map((item) => item.value)).toEqual(["off", "auto", "relay-effort"])
    expect(groups.other.map((item) => item.value)).toEqual(["high"])
    expect(model.variants?.high).toEqual({ temperature: 0.1 })
    const compact = reasoningControlOptions(Object.keys(model.variants!), model.variants)
    expect(compact.map((item) => item.value)).toEqual([undefined, "off", "auto", "relay-effort", "high"])
    expect(deprecatedReasoningVariant("off", Object.keys(model.variants!))).toBe(false)
    expect(input.variants[0].body).toEqual({ thinking: { type: "disabled" } })
  })

  test("a high temperature preset and reasoning-looking headers do not fabricate a reasoning capability", () => {
    const input = RuntimeModel.Info.make({
      ...base(),
      variants: [
        { id: RuntimeModel.VariantID.make("high"), headers: { reasoning_effort: "high" }, body: { temperature: 0.1 } },
      ],
    })
    const { model } = normalize(input)
    expect(model.capabilities.reasoning).toBe(false)
    expect(chooserCapabilityBadges(model)).toEqual(["vision"])
    expect(chooserVariantGroups(Object.keys(model.variants!), model.variants).reasoning).toEqual([])
    expect(model.variants?.high).toEqual({ temperature: 0.1 })
  })

  test("base request reasoning is evidence for a badge, not permission to invent selectable variants", () => {
    const { model } = normalize(
      RuntimeModel.Info.make({ ...base(), request: { headers: {}, body: { reasoning_effort: "high" } } }),
    )
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.variants).toEqual({})
    expect(chooserVariantGroups(Object.keys(model.variants!), model.variants).reasoning).toEqual([])
  })

  test("uses a supplied complete profile without fabricating one or inferring controls from its support kind", () => {
    const input = base()
    const profile = RuntimeModel.Profile.make({
      version: "v1",
      providerID: input.providerID,
      modelID: input.id,
      modality: { input: ["text"], output: ["text"] },
      limits: input.limit,
      capabilities: { tools: "unknown", structured: "unknown", reasoning: "effort", cache: "unknown" },
      tokenizer: "fixture",
      estimator: "fixture",
      priceCatalogRevision: "fixture-not-billing",
      observations: [],
      policy: {
        region: { mode: "unknown", regions: [] },
        egress: { mode: "unknown", origins: [] },
        data: { retention: "unknown", training: "unknown" },
      },
    })
    const { model } = normalize(RuntimeModel.Info.make({ ...input, profile }))
    expect(model.capabilities.reasoning).toBe(true)
    expect(chooserVariantGroups(Object.keys(model.variants!), model.variants).reasoning).toEqual([])
    expect(input.profile).toBeUndefined()
    expect(normalize(input).model.capabilities.reasoning).toBe(false)
  })

  test("keeps vendored settings compatibility while preserving an actual body and excluding variant headers", () => {
    const legacy: ModelListOutput["data"][number] = {
      id: "fixture",
      modelID: "wire",
      providerID: provider.id,
      name: "Fixture",
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      settings: { temperature: 0.7 },
      body: { temperature: 0.2 },
      variants: [
        {
          id: "low",
          settings: { reasoningEffort: "low" },
          body: { temperature: 0.4 },
          headers: { "x-fixture": "excluded" },
        },
      ],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 0, output: 0 },
    }
    const model = normalizeProviderList([provider], [legacy]).all.get(provider.id)!.models.fixture
    expect(model.options).toEqual({ temperature: 0.2 })
    expect(model.variants?.low).toEqual({ reasoningEffort: "low", temperature: 0.4 })
    expect(model.capabilities.reasoning).toBe(true)
    expect(chooserVariantGroups(["low"], model.variants).reasoning.map((item) => item.value)).toEqual(["low"])
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\arforge"))).toBe("C:/Repos/sst/arforge")
    expect(String(directoryKey("C:/Repos/sst/arforge"))).toBe("C:/Repos/sst/arforge")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/arforge/"))).toBe("C:/Repos/sst/arforge")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
