import { describe, expect, test } from "bun:test"
import { ARFORGE_SETTINGS_GROUPS, ARFORGE_SETTINGS_TABS } from "../control-center/navigation"
import { SESSION_SETTINGS_TABS } from "../session/session-settings-navigation"
import { settingsSectionTarget, settingsTabValue } from "./navigation"

describe("settings deep links", () => {
  test("accepts every existing control and session tab and rejects unknown panels", () => {
    for (const tab of [...ARFORGE_SETTINGS_TABS, ...SESSION_SETTINGS_TABS])
      expect(settingsTabValue(tab.value)).toBe(tab.value)
    for (const value of [undefined, "", "session-personal-jobs", "__proto__", "providers?token=private"])
      expect(settingsTabValue(value)).toBe("general")
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
