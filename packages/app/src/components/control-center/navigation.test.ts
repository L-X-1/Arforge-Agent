import { describe, expect, test } from "bun:test"
import { ARFORGE_SETTINGS_TABS, arforgeSettingsTab, isArforgeSettingsValue } from "./navigation"

describe("Arforge settings navigation", () => {
  test("uses unique namespaced values for every integrated page", () => {
    const values = ARFORGE_SETTINGS_TABS.map((item) => item.value)

    expect(values).toHaveLength(11)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((value) => value.startsWith("arforge-"))).toBe(true)
  })

  test("resolves valid pages without accepting unrelated settings tabs", () => {
    expect(isArforgeSettingsValue("arforge-overview")).toBe(true)
    expect(isArforgeSettingsValue("providers")).toBe(false)
    expect(arforgeSettingsTab("arforge-diagnostics")?.icon).toBe("checklist")
    expect(arforgeSettingsTab("arforge-evolution")?.label).toBe("受控自主进化")
    expect(arforgeSettingsTab("arforge-runtime")?.label).toBe("运行时透视")
    expect(arforgeSettingsTab("missing")).toBeUndefined()
  })
})
