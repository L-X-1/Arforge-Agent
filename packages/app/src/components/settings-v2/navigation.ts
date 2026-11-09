import { isArforgeSettingsValue } from "../control-center/navigation"
import { isSessionSettingsValue } from "../session/session-settings-navigation"

const BASIC_SETTINGS = new Set(["general", "shortcuts", "servers", "providers", "models"])

/** The single visible model/provider entry; legacy routes share its page. */
export const SETTINGS_INTEGRATIONS_TAB = "arforge-integrations"

/** Sections of the unified model/provider page, keyed by their historical tabs. */
export type SettingsIntegrationsSection = "arforge-integrations" | "providers" | "models"

/** A query string can select an existing panel; it cannot create a new one. */
export function settingsTabValue(value: string | undefined): string {
  return value && (BASIC_SETTINGS.has(value) || isArforgeSettingsValue(value) || isSessionSettingsValue(value))
    ? value : "general"
}

/** Legacy provider/model routes project onto the single visible outer tab. */
export function settingsPageTab(value: string | undefined): string {
  const tab = settingsTabValue(value)
  return tab === "providers" || tab === "models" ? SETTINGS_INTEGRATIONS_TAB : tab
}

/** Each historical key stays an addressable section of the unified page. */
export function settingsIntegrationsSection(value: string | undefined): SettingsIntegrationsSection {
  const tab = settingsTabValue(value)
  return tab === "providers" || tab === "models" ? tab : SETTINGS_INTEGRATIONS_TAB
}

export function isSettingsIntegrationsSection(value: string): value is SettingsIntegrationsSection {
  return value === SETTINGS_INTEGRATIONS_TAB || value === "providers" || value === "models"
}

/** The existing personal-jobs panel is a section of Session automation. */
export function settingsSectionTarget(tab: string | undefined, hash: string) {
  return settingsTabValue(tab) === "session-automation" && hash === "#operations-personal-jobs-title"
    ? "operations-personal-jobs-title" : undefined
}
