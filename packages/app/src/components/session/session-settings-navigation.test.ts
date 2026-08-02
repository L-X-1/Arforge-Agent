import { describe, expect, test } from "bun:test"
import { SESSION_SETTINGS_TABS, isSessionSettingsValue, sessionSettingsTab } from "./session-settings-navigation"

describe("Session settings navigation", () => {
  test("keeps every session-only page namespaced and unique", () => {
    const values = SESSION_SETTINGS_TABS.map((item) => item.value)

    expect(values).toHaveLength(6)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((value) => value.startsWith("session-"))).toBe(true)
  })

  test("does not accept global settings pages", () => {
    expect(isSessionSettingsValue("session-goal-task")).toBe(true)
    expect(isSessionSettingsValue("arforge-overview")).toBe(false)
    expect(sessionSettingsTab("session-checkpoint")?.label).toBe("checkpointRewind")
    expect(sessionSettingsTab("missing")).toBeUndefined()
  })
})
