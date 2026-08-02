import { describe, expect, test } from "bun:test"
import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { CronSchedule } from "@arforge-ai/core/scheduled-prompt/cron"

const cron = ScheduledPromptV2.Cron.make

describe("ScheduledPrompt cron", () => {
  test("supports lists, ranges, steps, and Sunday aliases", () => {
    const parsed = CronSchedule.parse(cron("0,30 9-17/2 * * 0,7"))

    expect([...parsed.minute.values]).toEqual([0, 30])
    expect([...parsed.hour.values]).toEqual([9, 11, 13, 15, 17])
    expect([...parsed.dayOfWeek.values]).toEqual([0])
  })

  test("uses cron day-of-month/day-of-week OR semantics", () => {
    const parsed = CronSchedule.parse(cron("0 12 15 * 1"))

    expect(CronSchedule.matches(parsed, new Date(2026, 5, 15, 12, 0))).toBe(true)
    expect(CronSchedule.matches(parsed, new Date(2026, 6, 15, 12, 0))).toBe(true)
    expect(CronSchedule.matches(parsed, new Date(2026, 5, 16, 12, 0))).toBe(false)
  })

  test("does not treat a stepped wildcard as unrestricted", () => {
    const parsed = CronSchedule.parse(cron("0 12 */2 * 1"))

    expect(parsed.dayOfMonth.wildcard).toBe(false)
    expect(CronSchedule.matches(parsed, new Date(2026, 5, 9, 12, 0))).toBe(true)
    expect(CronSchedule.matches(parsed, new Date(2026, 5, 11, 12, 0))).toBe(true)
    expect(CronSchedule.matches(parsed, new Date(2026, 5, 10, 12, 0))).toBe(false)
  })

  test("finds the next local-time occurrence and rejects malformed fields", () => {
    const after = new Date(2026, 5, 1, 8, 59, 45).getTime()
    expect(CronSchedule.next(cron("0 9 * * *"), after)).toBe(new Date(2026, 5, 1, 9, 0, 0).getTime())

    expect(() => CronSchedule.parse(cron("60 * * * *"))).toThrow("minute must be between 0 and 59")
    expect(() => CronSchedule.parse(cron("* * *"))).toThrow("exactly five fields")
    expect(() => CronSchedule.parse(cron("* * * * */0"))).toThrow("step is outside")
  })
})
