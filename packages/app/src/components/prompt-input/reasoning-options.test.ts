import { describe, expect, test } from "bun:test"
import { deprecatedReasoningVariant, reasoningControlOptions } from "./reasoning-options"

describe("reasoning control options", () => {
  test("exposes only Default, High and Max for a three-tier reasoning model", () => {
    expect(reasoningControlOptions(["none", "high", "max"])).toEqual([
      { id: "default", level: "default", label: "Default" },
      { id: "high", level: "high", label: "High" },
      { id: "max", level: "max", label: "Max" },
    ])
  })

  test("maps provider max aliases while hiding retired shallow modes", () => {
    expect(reasoningControlOptions(["low", "medium", "high", "xhigh"]).map((item) => item.id)).toEqual([
      "default",
      "high",
      "xhigh",
    ])
    expect(deprecatedReasoningVariant("none")).toBe(true)
    expect(deprecatedReasoningVariant("medium")).toBe(true)
    expect(deprecatedReasoningVariant("provider-specific")).toBe(false)
  })
})
