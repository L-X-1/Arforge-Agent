import { describe, expect, test } from "bun:test"
import { Model as SchemaModel } from "@arforge-ai/schema/model"
import { Provider } from "@arforge-ai/schema/provider"
import { routeByPolicy, type PolicyModel, type RoutingPolicy } from "../src/runtime/router"

const base: PolicyModel = {
  providerID: "deepseek",
  modelID: "deepseek-v4-flash",
  inputCost: 1,
  outputCost: 2,
  toolcall: true,
  vision: true,
  reasoning: true,
  structured: true,
  region: "cn",
  egress: "provider",
  credential: { available: true, scopes: ["models:invoke"] },
  estimatedCharge: { currency: "CNY", estimatedMinor: 200 },
  circuitBreaker: "closed",
}

const policy: RoutingPolicy = {
  preference: {
    vision: true,
    toolcall: true,
    reasoning: true,
    structured: true,
    quality: "balanced",
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
  },
  providerAllowlist: ["deepseek"],
  regionAllowlist: ["cn"],
  egressAllowlist: ["provider"],
  requiredCredentialScope: "models:invoke",
  budget: { currency: "CNY", limitMinor: 500, spentMinor: 100, reservedMinor: 100 },
}

const profile: SchemaModel.Profile = {
  version: "v1",
  providerID: Provider.ID.make("deepseek"),
  modelID: SchemaModel.ID.make("deepseek-v4-flash"),
  modality: { input: ["text", "image"], output: ["text"] },
  limits: { context: 128_000, output: 4_096 },
  capabilities: { tools: "supported", structured: "native", reasoning: "provider_defined", cache: "implicit" },
  tokenizer: "deepseek-tokenizer-v1",
  estimator: "character-v1",
  priceCatalogRevision: "deepseek-prices-v1",
  observations: [],
  policy: {
    region: { mode: "allowlist", regions: ["cn"] },
    egress: { mode: "provider", origins: ["api.deepseek.com"] },
    data: { retention: "provider_defined", training: "provider_defined" },
  },
}

describe("Policy-aware Router", () => {
  test("filters hard policy gates before ranking and preserves rejection evidence", () => {
    const result = routeByPolicy(
      [
        base,
        { ...base, modelID: "wrong-provider", providerID: "openai" },
        { ...base, modelID: "wrong-region", region: "us" },
        { ...base, modelID: "missing-scope", credential: { available: true, scopes: [] } },
        { ...base, modelID: "open-breaker", circuitBreaker: "open" },
        { ...base, modelID: "too-expensive", estimatedCharge: { currency: "CNY", estimatedMinor: 400 } },
      ],
      policy,
    )

    expect(result.ranked.map((model) => model.modelID)).toEqual(["deepseek-v4-flash"])
    expect(result.rejected).toHaveLength(5)
    expect(result.rejected.flatMap((item) => item.reasons)).toEqual(
      expect.arrayContaining([
        "provider is outside the allowlist",
        "region is outside the allowlist or unknown",
        "required credential scope is missing",
        "circuit breaker is open",
        "budget cannot cover the estimated call",
      ]),
    )
    expect(result.evidence).toEqual(expect.arrayContaining(["budget: CNY/500", "required credential scope: models:invoke"]))
    expect(result.ranked[0]?.evidence).toEqual(expect.arrayContaining(["passed all hard policy gates", "region=cn"]))
  })

  test("puts an eligible explicit model before score ranking", () => {
    const result = routeByPolicy(
      [
        base,
        {
          ...base,
          modelID: "explicit-model",
          inputCost: 100,
          outputCost: 100,
        },
      ],
      { ...policy, explicitModel: { providerID: "deepseek", modelID: "explicit-model" } },
    )

    expect(result.ranked[0]?.modelID).toBe("explicit-model")
    expect(result.reason).toContain("显式选择 deepseek/explicit-model")
  })

  test("does not silently fall back when an explicit model fails policy", () => {
    const result = routeByPolicy(
      [base, { ...base, modelID: "blocked-explicit", circuitBreaker: "open" }],
      { ...policy, explicitModel: { providerID: "deepseek", modelID: "blocked-explicit" } },
    )

    expect(result.ranked).toEqual([])
    expect(result.reason).toContain("显式选择 deepseek/blocked-explicit 未通过硬策略过滤")
    expect(result.evidence).toEqual(expect.arrayContaining(["explicit selection: deepseek/blocked-explicit"]))
  })

  test("uses Model.Profile v1 as authoritative capability and policy evidence", () => {
    const result = routeByPolicy(
      [{ ...base, toolcall: false, vision: false, reasoning: false, structured: false, profile }],
      policy,
    )

    expect(result.ranked).toHaveLength(1)
    expect(result.ranked[0]?.evidence).toEqual(
      expect.arrayContaining([
        "model profile=v1:deepseek/deepseek-v4-flash",
        "profile revision=deepseek-prices-v1; tokenizer=deepseek-tokenizer-v1; estimator=character-v1",
        "profile capabilities=tools:supported,structured:native,reasoning:provider_defined",
        "profile policy=region:allowlist;egress:provider",
      ]),
    )
  })

  test("fails closed when Model.Profile identity or capability evidence is inconsistent", () => {
    const result = routeByPolicy(
      [
        {
          ...base,
          profile: {
            ...profile,
            modelID: SchemaModel.ID.make("different-model"),
            capabilities: { ...profile.capabilities, tools: "unknown" },
          },
        },
      ],
      policy,
    )

    expect(result.ranked).toEqual([])
    expect(result.rejected[0]?.reasons).toEqual(
      expect.arrayContaining(["model profile identity does not match candidate", "capability tool-calling is not supported"]),
    )
  })
})
