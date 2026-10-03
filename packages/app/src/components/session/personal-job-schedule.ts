export type SchedulePreset = "once" | "daily" | "weekdays" | "weekly" | "custom"
export type RetentionPreset = "none" | "7d" | "30d" | "90d" | "365d"

export const cronForSchedulePreset = (preset: Exclude<SchedulePreset, "once" | "custom">) =>
  ({ daily: "0 9 * * *", weekdays: "0 9 * * 1-5", weekly: "0 9 * * 1" })[preset]

export const oneTimeValueFromEpoch = (epochMs: number) => {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) return ""
  const target = new Date(epochMs)
  const local = new Date(epochMs - target.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export const defaultOneTimeValue = (now = Date.now()) =>
  oneTimeValueFromEpoch(Math.floor((now + 60 * 60_000) / 60_000) * 60_000)

export const epochFromOneTimeValue = (value: string) => {
  if (!value.trim()) return undefined
  const timestamp = new Date(value).getTime()
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined
}

export const schedulePresetFromCron = (cron: string): SchedulePreset => {
  if (cron === "0 9 * * *") return "daily"
  if (cron === "0 9 * * 1-5") return "weekdays"
  if (cron === "0 9 * * 1") return "weekly"
  return "custom"
}

export const retentionDays = (preset: RetentionPreset) => {
  if (preset === "none") return undefined
  return { "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[preset]
}

export const retainUntilFromPreset = (preset: RetentionPreset, now = Date.now()) => {
  const days = retentionDays(preset)
  if (days === undefined) return undefined
  const retainUntil = now + days * 24 * 60 * 60 * 1_000
  return Number.isSafeInteger(retainUntil) ? retainUntil : undefined
}

export const budgetPercent = (used: number, limit: number) => {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used <= 0 || limit <= 0) return "0%"
  const percent = (used / limit) * 100
  if (percent < 1) return "<1%"
  return `${Math.min(100, Math.round(percent))}%`
}

export const durationParts = (milliseconds: number) => {
  const value = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0)
  if (value < 60_000) return { value: Math.round(value / 1_000), unit: "seconds" as const }
  if (value < 3_600_000) return { value: Math.round(value / 60_000), unit: "minutes" as const }
  return { value: Math.round((value / 3_600_000) * 10) / 10, unit: "hours" as const }
}

export const millisecondsFromMinutes = (value: string) => {
  const minutes = Number(value)
  const milliseconds = minutes * 60_000
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(milliseconds)) return undefined
  return milliseconds
}

export const microsFromCurrencyUnits = (value: string) => {
  const units = Number(value)
  const micros = Math.round(units * 1_000_000)
  if (!Number.isFinite(units) || units < 0 || !Number.isSafeInteger(micros)) return undefined
  return micros
}
