export const SESSION_SETTINGS_TABS = [
  { value: "session-goal-task", icon: "task", label: "goalTask" },
  { value: "session-prompt-queue", icon: "prompt", label: "promptQueue" },
  { value: "session-automation", icon: "status", label: "scheduleTriggerWait" },
  { value: "session-team", icon: "subagent", label: "teamSubagent" },
  { value: "session-checkpoint", icon: "archive", label: "checkpointRewind" },
  { value: "session-feedback", icon: "speech-bubble", label: "feedback" },
] as const satisfies ReadonlyArray<{
  value: `session-${string}`
  icon: string
  label: "goalTask" | "promptQueue" | "scheduleTriggerWait" | "teamSubagent" | "checkpointRewind" | "feedback"
}>

export type SessionSettingsTab = (typeof SESSION_SETTINGS_TABS)[number]
export type SessionSettingsValue = SessionSettingsTab["value"]

export function isSessionSettingsValue(value: string): value is SessionSettingsValue {
  return SESSION_SETTINGS_TABS.some((item) => item.value === value)
}

export function sessionSettingsTab(value: string) {
  return SESSION_SETTINGS_TABS.find((item) => item.value === value)
}
