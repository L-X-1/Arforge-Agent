import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Model } from "../src/model"
import { Provider } from "../src/provider"

const profile = (): Model.Profile => ({
  version: "v1",
  providerID: Provider.ID.make("openai"),
  modelID: Model.ID.make("gpt-test"),
  modality: {
    input: ["text", "image"],
    output: ["text"],
  },
  limits: {
    context: 128_000,
    input: 120_000,
    output: 8_000,
  },
  capabilities: {
    tools: "supported",
    structured: "synthetic_tool",
    reasoning: "effort",
    cache: "implicit",
  },
  tokenizer: "provider:gpt",
  estimator: "provider:usage-v1",
  priceCatalogRevision: "catalog-2026-08-12",
  observations: [
    {
      kind: "capability",
      status: "pass",
      source: "recorded",
      sourceID: "fixture:openai-responses",
      observedAt: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
      value: { capability: "tools" },
    },
  ],
  policy: {
    region: { mode: "provider_default", regions: [] },
    egress: { mode: "provider", origins: [] },
    data: { retention: "provider_defined", training: "provider_defined" },
  },
})

describe("Model.Profile", () => {
  test("encodes the V1 profile and optional expiry without losing evidence", () => {
    const input = profile()
    const encoded = Schema.encodeSync(Model.Profile)(input)
    const decoded = Schema.decodeSync(Model.Profile)(encoded)

    expect(encoded.version).toBe("v1")
    expect(encoded.observations[0]?.observedAt).toBe(DateTime.toEpochMillis(input.observations[0]!.observedAt))
    expect(decoded).toEqual(input)
    expect(encoded.observations[0]).not.toHaveProperty("expiresAt")
  })

  test("keeps the legacy Model.Info shape valid when profile is absent", () => {
    const info = Model.Info.empty(Provider.ID.make("openai"), Model.ID.make("gpt-test"))
    const encoded = Schema.encodeSync(Model.Info)(info)

    expect(encoded).not.toHaveProperty("profile")
    expect(Schema.decodeSync(Model.Info)(encoded)).toEqual(info)
  })

  test("rejects negative profile limits and unknown capability states", () => {
    const encoded = Schema.encodeSync(Model.Profile)(profile())
    expect(() =>
      Schema.decodeSync(Model.Profile)({
        ...encoded,
        limits: { context: -1, output: 1 },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(Model.Profile)({
        ...encoded,
        capabilities: { ...encoded.capabilities, tools: "maybe" as never },
      }),
    ).toThrow()
  })
})
