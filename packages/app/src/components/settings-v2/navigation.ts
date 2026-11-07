import { isArforgeSettingsValue } from "../control-center/navigation"
import { isSessionSettingsValue } from "../session/session-settings-navigation"

const BASIC_SETTINGS = new Set(["general", "shortcuts", "servers", "providers", "models"])

/** A query string can select an existing panel; it cannot create a new one. */
export function settingsTabValue(value: string | undefined): string {
  return value && (BASIC_SETTINGS.has(value) || isArforgeSettingsValue(value) || isSessionSettingsValue(value))
    ? value : "general"
}

/** The existing personal-jobs panel is a section of Session automation. */
export function settingsSectionTarget(tab: string | undefined, hash: string) {
  return settingsTabValue(tab) === "session-automation" && hash === "#operations-personal-jobs-title"
    ? "operations-personal-jobs-title" : undefined
}
