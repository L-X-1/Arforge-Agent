import { describe, expect, test } from "bun:test"
import { deprecatedReasoningVariant, reasoningControlKey, reasoningControlOptions } from "./reasoning-options"

describe("actual supported variant controls", () => {
  test("keeps reset, an actual default ID, off, automatic and custom presets distinct", () => {
    const options = reasoningControlOptions(
      ["none", "auto", "default", "high", "json"],
      {
        none: { thinking: { type: "disabled" } },
        auto: { reasoning_effort: "auto" },
        default: { reasoning_effort: "medium" },
        high: { temperature: 0.1 },
        json: { response_format: { type: "json_object" } },
      },
      "zht",
    )
    expect(options.map((item) => item.value)).toEqual([undefined, "none", "auto", "default", "high", "json"])
    expect(options.map((item) => item.label)).toEqual(["預設", "關閉", "自動", "模型預設", "high", "json"])
    expect(new Set(options.map((item) => item.id)).size).toBe(options.length)
    for (const option of options) expect(reasoningControlKey(option.value)).toBe(option.id)
  })

  test("retains supported shallow and off choices; only unsupported deprecated IDs are retired", () => {
    for (const value of ["none", "off", "low", "medium", "minimal"]) {
      expect(deprecatedReasoningVariant(value, [value])).toBe(false)
      expect(deprecatedReasoningVariant(value, [])).toBe(true)
    }
    expect(deprecatedReasoningVariant("provider-specific", [])).toBe(false)
  })

  test("does not infer thinking from high/max IDs and preserves unknown custom labels", () => {
    expect(reasoningControlOptions(["high", "max", "relay-opaque"], {}, "zh").map((item) => item.label)).toEqual([
      "默认",
      "high",
      "max",
      "relay-opaque",
    ])
    expect(reasoningControlOptions([], {}, "de")).toEqual([{ id: "reset", value: undefined, label: "Default" }])
  })
})
