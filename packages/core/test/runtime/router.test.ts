import { describe, expect, it } from "bun:test"
import { estimatedCallCost, rankByCost } from "@arforge-ai/core/runtime/router"

describe("RuntimeRouter", () => {
  it("ranks by cost and capability fit", () => {
    const models = [
      { providerID: "p1", modelID: "expensive-powerful", inputCost: 10, outputCost: 30, toolcall: true, reasoning: true },
      { providerID: "p2", modelID: "cheap-basic", inputCost: 0.1, outputCost: 0.3, toolcall: true },
    ]
    // With a 100x cost gap the cheap model wins in both modes.
    const { ranked, reason } = rankByCost(models, { quality: "balanced", toolcall: true })
    expect(ranked).toHaveLength(2)
    expect(ranked[0].modelID).toBe("cheap-basic")
    expect(reason).toContain("cheap-basic")
    const cheapest = rankByCost(models, { quality: "cheapest", toolcall: true })
    expect(cheapest.ranked[0].modelID).toBe("cheap-basic")
    expect(cheapest.ranked[0].costScore).toBeGreaterThan(cheapest.ranked[1].costScore)
  })

  it("prefers capability when the cheap model misses the requirement", () => {
    const models = [
      { providerID: "p1", modelID: "vision-model", inputCost: 5, outputCost: 15, vision: true },
      { providerID: "p2", modelID: "no-vision", inputCost: 0.1, outputCost: 0.3 },
    ]
    const { ranked } = rankByCost(models, { quality: "balanced", vision: true })
    expect(ranked[0].modelID).toBe("vision-model")
  })

  it("computes estimated call cost in dollars", () => {
    const cost = estimatedCallCost({ inputCost: 1, outputCost: 2 }, 1_000_000, 500_000)
    expect(cost).toBe(2)
  })

  it("returns a reason even with no models", () => {
    const { ranked, reason } = rankByCost([], { quality: "balanced" })
    expect(ranked).toHaveLength(0)
    expect(reason).toBe("无可用模型")
  })
})
