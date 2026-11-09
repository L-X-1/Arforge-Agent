import { describe, expect, test } from "bun:test"
import { ARFORGE_SETTINGS_GROUPS, ARFORGE_SETTINGS_TABS } from "../control-center/navigation"
import { SESSION_SETTINGS_TABS } from "../session/session-settings-navigation"
import {
  SETTINGS_INTEGRATIONS_TAB,
  settingsIntegrationsSection,
  settingsPageTab,
  settingsSectionTarget,
  settingsTabValue,
} from "./navigation"

describe("settings deep links", () => {
  test("accepts every existing control and session tab and rejects unknown panels", () => {
    for (const tab of [...ARFORGE_SETTINGS_TABS, ...SESSION_SETTINGS_TABS])
      expect(settingsTabValue(tab.value)).toBe(tab.value)
    expect(settingsTabValue("providers")).toBe("providers")
    expect(settingsTabValue("models")).toBe("models")
    for (const value of [undefined, "", "session-personal-jobs", "__proto__", "providers?token=private"])
      expect(settingsTabValue(value)).toBe("general")
  })

  test("projects legacy routes onto one visible tab and keeps their sections", () => {
    for (const value of ["providers", "models"] as const) {
      expect(settingsPageTab(value)).toBe(SETTINGS_INTEGRATIONS_TAB)
      expect(settingsIntegrationsSection(value)).toBe(value)
    }
    expect(settingsPageTab(SETTINGS_INTEGRATIONS_TAB)).toBe(SETTINGS_INTEGRATIONS_TAB)
    expect(settingsPageTab("general")).toBe("general")
    expect(settingsIntegrationsSection(SETTINGS_INTEGRATIONS_TAB)).toBe(SETTINGS_INTEGRATIONS_TAB)
    expect(settingsIntegrationsSection("general")).toBe(SETTINGS_INTEGRATIONS_TAB)
    expect(settingsIntegrationsSection(undefined)).toBe(SETTINGS_INTEGRATIONS_TAB)
  })

  test("exposes only the unified entry in the connections group", () => {
    expect(ARFORGE_SETTINGS_GROUPS.find(group => group.id === "connections")?.values)
      .toEqual([SETTINGS_INTEGRATIONS_TAB])
  })

  test("keeps personal jobs on their real automation owner", () => {
    expect(settingsSectionTarget("session-automation", "#operations-personal-jobs-title")).toBe("operations-personal-jobs-title")
    expect(settingsSectionTarget("session-goal-task", "#operations-personal-jobs-title")).toBeUndefined()
    expect(settingsSectionTarget("session-personal-jobs", "#operations-personal-jobs-title")).toBeUndefined()
    expect(settingsSectionTarget("session-automation", "#untrusted-selector")).toBeUndefined()
  })

  test("groups all eleven management entries exactly once without changing their values", () => {
    const values = ARFORGE_SETTINGS_GROUPS.flatMap(group => [...group.values])
    expect(values).toHaveLength(11)
    expect(new Set(values).size).toBe(11)
    expect([...values].sort()).toEqual(ARFORGE_SETTINGS_TABS.map(tab => tab.value).sort())
  })
})
