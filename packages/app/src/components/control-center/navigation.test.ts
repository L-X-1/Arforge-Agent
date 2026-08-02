import { describe, expect, test } from "bun:test"
import { ARFORGE_SETTINGS_TABS, arforgeSettingsTab, isArforgeSettingsValue } from "./navigation"

describe("Arforge settings navigation", () => {
  test("uses unique namespaced values for every integrated page", () => {
    const values = ARFORGE_SETTINGS_TABS.map((item) => item.value)

    expect(values).toHaveLength(8)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((value) => value.startsWith("arforge-"))).toBe(true)
  })

  test("resolves valid pages without accepting unrelated settings tabs", () => {
    expect(isArforgeSettingsValue("arforge-overview")).toBe(true)
    expect(isArforgeSettingsValue("providers")).toBe(false)
    expect(arforgeSettingsTab("arforge-diagnostics")?.icon).toBe("checklist")
    expect(arforgeSettingsTab("missing")).toBeUndefined()
  })
})
