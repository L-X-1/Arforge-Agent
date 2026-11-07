import { describe, expect, test } from "bun:test"
import {
  cycleModelVariant,
  getConfiguredAgentVariant,
  queuedVariantRestore,
  resolveModelVariant,
} from "./model-variant"

describe("queued model preset restoration", () => {
  const queued = { providerID: "owned", modelID: "model-a", variant: "pinned" }
  const base = {
    queued,
    current: { providerID: "owned", modelID: "model-a" },
    currentVariant: undefined,
    supported: ["pinned", "max"],
    explicit: false,
  }

  test("restores a supported original preset for the same otherwise unselected model", () => {
    expect(queuedVariantRestore(base)).toEqual({ status: "restore", variant: "pinned" })
  })
  test("keeps a deliberately selected different model without copying its old preset", () => {
    expect(queuedVariantRestore({ ...base, current: { providerID: "owned", modelID: "model-b" } })).toEqual({
      status: "unchanged",
    })
  })
  test("keeps the current model preset choice", () => {
    expect(queuedVariantRestore({ ...base, currentVariant: "max" })).toEqual({ status: "unchanged" })
  })
  test("honors an explicit Default choice", () => {
    expect(queuedVariantRestore({ ...base, explicit: true })).toEqual({ status: "unchanged" })
  })
  test("does not silently drop an unavailable queued preset", () => {
    expect(queuedVariantRestore({ ...base, supported: [] })).toEqual({ status: "retain", variant: "pinned" })
  })
  test("does not invent a preset for an original request without one", () => {
    expect(queuedVariantRestore({ ...base, queued: { providerID: "owned", modelID: "model-a" } })).toEqual({
      status: "unchanged",
    })
  })
  test("does not substitute a different provider or an unavailable current model", () => {
    expect(queuedVariantRestore({ ...base, current: { providerID: "other", modelID: "model-a" } })).toEqual({
      status: "unchanged",
    })
    expect(queuedVariantRestore({ ...base, current: undefined })).toEqual({ status: "unchanged" })
  })
})

describe("model variant", () => {
  test("resolves configured agent variant when model matches", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "openai",
        modelID: "gpt-5.2",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBe("xhigh")
  })

  test("ignores configured variant when model does not match", () => {
    const value = getConfiguredAgentVariant({
      agent: {
        model: { providerID: "openai", modelID: "gpt-5.2" },
        variant: "xhigh",
      },
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4",
        variants: { low: {}, high: {}, xhigh: {} },
      },
    })

    expect(value).toBeUndefined()
  })

  test("prefers selected variant over configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: "high",
      configured: "xhigh",
    })

    expect(value).toBe("high")
  })

  test("lets an explicit default override the configured variant", () => {
    const value = resolveModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBeUndefined()
  })

  test("cycles from configured variant to next", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "high",
    })

    expect(value).toBe("xhigh")
  })

  test("wraps from configured last variant to first", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: undefined,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })

  test("cycles from an explicit default to the first variant", () => {
    const value = cycleModelVariant({
      variants: ["low", "high", "xhigh"],
      selected: null,
      configured: "xhigh",
    })

    expect(value).toBe("low")
  })
})
