import { describe, expect, test } from "bun:test"
import { DateTime } from "luxon"
import { Agent as RuntimeAgent } from "@arforge-ai/schema/agent"
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

    expect(normalizeAgentList([agent])).toEqual([{
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
    }])
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
  const catalog = (released: number) => normalizeProviderList(
    [{ id: "test", name: "Custom provider", package: "@ai-sdk/openai-compatible" }] as ProviderListOutput["data"],
    [{
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
    }] as ModelListOutput["data"],
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
