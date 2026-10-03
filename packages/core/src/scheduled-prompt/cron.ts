export * as CronSchedule from "./cron"

import { Schema } from "effect"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"

export class InvalidCronError extends Schema.TaggedErrorClass<InvalidCronError>()("ScheduledPrompt.InvalidCronError", {
  expression: ScheduledPrompt.Cron,
  message: Schema.String,
}) {}

interface Field {
  readonly values: ReadonlySet<number>
  readonly wildcard: boolean
}

export interface Parsed {
  readonly minute: Field
  readonly hour: Field
  readonly dayOfMonth: Field
  readonly month: Field
  readonly dayOfWeek: Field
}

const definitions = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
] as const

export function parse(expression: ScheduledPrompt.Cron): Parsed {
  const fields = expression.split(/\s+/)
  if (fields.length !== 5) throw invalid(expression, "Cron must contain exactly five fields.")
  const parsed = fields.map((field, index) => {
    const definition = definitions[index]
    if (!definition) throw invalid(expression, "Cron contains an unexpected field.")
    return parseField(expression, field!, definition[0], definition[1], definition[2])
  })
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: normalizeDayOfWeek(parsed[4]!),
  }
}

export function next(
  expression: ScheduledPrompt.Cron,
  after: number,
  horizon: number = after + 8 * 24 * 60 * 60 * 1_000,
) {
  const parsed = parse(expression)
  const cursor = new Date(after)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  while (cursor.getTime() <= horizon) {
    if (matches(parsed, cursor)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw invalid(expression, "Cron has no occurrence inside the seven-day schedule lifetime.")
}

/**
 * Find the next occurrence in an explicit IANA timezone.
 *
 * Cron expressions are wall-clock schedules. The legacy `next` helper keeps
 * its process-local behavior for existing ScheduledPrompt callers, while
 * Personal Jobs use this function because their persisted timezone must not
 * depend on the machine running the scheduler.
 */
export function nextInTimeZone(
  expression: ScheduledPrompt.Cron,
  after: number,
  timeZone: string,
  horizon: number = after + 8 * 24 * 60 * 60 * 1_000,
) {
  const parsed = parse(expression)
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
  } catch {
    throw invalid(expression, "Cron timezone must be a valid IANA timezone.")
  }

  const minute = 60 * 1_000
  let cursor = Math.floor(after / minute) * minute + minute
  while (cursor <= horizon) {
    const parts = formatter.formatToParts(new Date(cursor))
    const values = new Map(parts.map((part) => [part.type, Number(part.value)]))
    const year = values.get("year")
    const month = values.get("month")
    const day = values.get("day")
    const hour = values.get("hour")
    const localMinute = values.get("minute")
    if (
      year !== undefined &&
      month !== undefined &&
      day !== undefined &&
      hour !== undefined &&
      localMinute !== undefined
    ) {
      // Use UTC getters for the projected wall-clock date so the matching
      // result remains independent of the process's own local timezone.
      const wallClock = new Date(Date.UTC(year, month - 1, day, hour, localMinute))
      if (matchesUtc(parsed, wallClock)) return cursor
    }
    cursor += minute
  }
  throw invalid(expression, "Cron has no occurrence inside the seven-day schedule lifetime.")
}

export function matches(parsed: Parsed, date: Date) {
  return matchesValues(parsed, date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay())
}

function matchesUtc(parsed: Parsed, date: Date) {
  return matchesValues(
    parsed,
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  )
}

function matchesValues(
  parsed: Parsed,
  minute: number,
  hour: number,
  dayOfMonthValue: number,
  month: number,
  dayOfWeekValue: number,
) {
  if (!parsed.minute.values.has(minute)) return false
  if (!parsed.hour.values.has(hour)) return false
  if (!parsed.month.values.has(month)) return false
  const dayOfMonth = parsed.dayOfMonth.values.has(dayOfMonthValue)
  const dayOfWeek = parsed.dayOfWeek.values.has(dayOfWeekValue)
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true
  if (parsed.dayOfMonth.wildcard) return dayOfWeek
  if (parsed.dayOfWeek.wildcard) return dayOfMonth
  return dayOfMonth || dayOfWeek
}

function parseField(
  expression: ScheduledPrompt.Cron,
  source: string,
  name: string,
  minimum: number,
  maximum: number,
): Field {
  const values = new Set<number>()
  for (const segment of source.split(",")) {
    if (!segment) throw invalid(expression, `${name} contains an empty list item.`)
    const [rangeSource, stepSource, extra] = segment.split("/")
    if (extra !== undefined || rangeSource === undefined)
      throw invalid(expression, `${name} contains an invalid step.`)
    const step = stepSource === undefined ? 1 : integer(expression, stepSource, `${name} step`)
    if (step < 1 || step > maximum - minimum + 1)
      throw invalid(expression, `${name} step is outside its valid range.`)

    const [start, end] =
      rangeSource === "*"
        ? [minimum, maximum]
        : rangeSource.includes("-")
          ? parseRange(expression, rangeSource, name, minimum, maximum)
          : [value(expression, rangeSource, name, minimum, maximum), undefined]
    const last = end ?? start
    for (let current = start; current <= last; current += step) values.add(current)
  }
  if (!values.size) throw invalid(expression, `${name} selects no values.`)
  const wildcard = values.size === maximum - minimum + 1
  return { values, wildcard }
}

function parseRange(
  expression: ScheduledPrompt.Cron,
  source: string,
  name: string,
  minimum: number,
  maximum: number,
): readonly [number, number] {
  const parts = source.split("-")
  if (parts.length !== 2) throw invalid(expression, `${name} contains an invalid range.`)
  const start = value(expression, parts[0]!, name, minimum, maximum)
  const end = value(expression, parts[1]!, name, minimum, maximum)
  if (start > end) throw invalid(expression, `${name} range must be ascending.`)
  return [start, end]
}

function value(expression: ScheduledPrompt.Cron, source: string, name: string, minimum: number, maximum: number) {
  const result = integer(expression, source, name)
  if (result < minimum || result > maximum)
    throw invalid(expression, `${name} must be between ${minimum} and ${maximum}.`)
  return result
}

function integer(expression: ScheduledPrompt.Cron, source: string, name: string) {
  if (!/^\d+$/.test(source)) throw invalid(expression, `${name} must be an integer.`)
  return Number(source)
}

function normalizeDayOfWeek(field: Field): Field {
  const values = new Set(field.values)
  values.delete(7)
  if (field.values.has(7)) values.add(0)
  return { values, wildcard: values.size === 7 }
}

function invalid(expression: ScheduledPrompt.Cron, message: string) {
  return new InvalidCronError({ expression, message })
}
