import { describe, expect, test } from "bun:test"
import {
  budgetPercent,
  cronForSchedulePreset,
  defaultOneTimeValue,
  durationParts,
  epochFromOneTimeValue,
  microsFromCurrencyUnits,
  millisecondsFromMinutes,
  retainUntilFromPreset,
  retentionDays,
  schedulePresetFromCron,
} from "./personal-job-schedule"

describe("personal job schedule presets", () => {
  test("maps beginner-friendly choices to durable cron schedules", () => {
    expect(cronForSchedulePreset("daily")).toBe("0 9 * * *")
    expect(cronForSchedulePreset("weekdays")).toBe("0 9 * * 1-5")
    expect(cronForSchedulePreset("weekly")).toBe("0 9 * * 1")
  })

  test("round-trips the safe one-time default through the local datetime control", () => {
    const now = Date.now()
    const value = defaultOneTimeValue(now)
    const timestamp = epochFromOneTimeValue(value)

    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(timestamp).toBeDefined()
    expect(timestamp!).toBeGreaterThanOrEqual(now + 59 * 60_000)
    expect(timestamp!).toBeLessThanOrEqual(now + 61 * 60_000)
    expect(epochFromOneTimeValue("")).toBeUndefined()
    expect(epochFromOneTimeValue("not-a-date")).toBeUndefined()
  })

  test("keeps unfamiliar schedules available through advanced settings", () => {
    expect(schedulePresetFromCron("0 9 * * *")).toBe("daily")
    expect(schedulePresetFromCron("30 14 * * 2")).toBe("custom")
  })

  test("presents runtime limits without leaking storage units", () => {
    expect(durationParts(600_000)).toEqual({ value: 10, unit: "minutes" })
    expect(durationParts(3_600_000)).toEqual({ value: 1, unit: "hours" })
    expect(budgetPercent(80, 500_000)).toBe("<1%")
    expect(budgetPercent(250_000, 500_000)).toBe("50%")
    expect(millisecondsFromMinutes("10")).toBe(600_000)
    expect(millisecondsFromMinutes("0.5")).toBe(30_000)
    expect(millisecondsFromMinutes("0")).toBeUndefined()
    expect(microsFromCurrencyUnits("0.5")).toBe(500_000)
    expect(microsFromCurrencyUnits("-1")).toBeUndefined()
  })

  test("maps deletion-protection choices to deterministic deadlines", () => {
    const now = Date.UTC(2026, 7, 15, 12, 0, 0)
    expect(retentionDays("none")).toBeUndefined()
    expect(retentionDays("30d")).toBe(30)
    expect(retainUntilFromPreset("none", now)).toBeUndefined()
    expect(retainUntilFromPreset("7d", now)).toBe(now + 7 * 24 * 60 * 60 * 1_000)
    expect(retainUntilFromPreset("365d", now)).toBe(now + 365 * 24 * 60 * 60 * 1_000)
  })
})
