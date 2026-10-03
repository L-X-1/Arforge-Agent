import { describe, expect, test } from "bun:test"
import { setTimeout } from "node:timers/promises"
import { TimelineDeadlineError, withTimelineDeadline } from "../timeline/session-timeline-deadline"

describe("timeline host deadline", () => {
  test("returns the original operation result", async () => {
    const result = { completed: true }
    expect(await withTimelineDeadline(Promise.resolve(result), "Stream completion", 1000)).toBe(result)
  })

  test("preserves the original operation error", async () => {
    const error = new Error("Browser disconnected")
    await expect(withTimelineDeadline(Promise.reject(error), "Stream completion", 1000)).rejects.toBe(error)
  })

  test("expires even when the browser operation never settles", async () => {
    const never = new Promise<never>(() => {})
    await expect(withTimelineDeadline(never, "Stream completion", 10)).rejects.toMatchObject({
      name: "TimelineDeadlineError",
      message: "Stream completion exceeded 10ms (host deadline)",
    })
  })

  test("does not turn a late browser completion into a passing result", async () => {
    let complete!: (value: string) => void
    const operation = new Promise<string>((resolve) => { complete = resolve })
    const guarded = withTimelineDeadline(operation, "Stream completion", 10)
    await expect(guarded).rejects.toBeInstanceOf(TimelineDeadlineError)
    complete("late completion")
    await expect(guarded).rejects.toBeInstanceOf(TimelineDeadlineError)
  })

  test("handles a browser rejection after the host deadline", async () => {
    let fail!: (error: Error) => void
    const operation = new Promise<never>((_, reject) => { fail = reject })
    await expect(withTimelineDeadline(operation, "Stream completion", 10)).rejects.toBeInstanceOf(TimelineDeadlineError)
    fail(new Error("Page closed during teardown"))
    await setTimeout(0)
  })
})
