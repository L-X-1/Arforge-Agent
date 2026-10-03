import { describe, expect, test } from "bun:test"
import { createHistoryPreviewTimers } from "./history-rail-preview"

function clock() {
  let now = 0
  const tasks = new Set<{ at: number; callback: () => void }>()
  return {
    schedule(callback: () => void, delay: number) {
      const task = { at: now + delay, callback }
      tasks.add(task)
      return () => { tasks.delete(task) }
    },
    advance(duration: number) {
      now += duration
      for (const task of [...tasks].sort((a, b) => a.at - b.at)) {
        if (task.at > now || !tasks.delete(task)) continue
        task.callback()
      }
    },
  }
}

describe("history preview timing", () => {
  test("opens at 150ms, closes at 200ms, and crossing into the card cancels close", () => {
    const time = clock()
    let open = false
    const preview = createHistoryPreviewTimers(() => { open = false }, time.schedule)
    preview.hover(() => { open = true })
    time.advance(149)
    expect(open).toBe(false)
    time.advance(1)
    expect(open).toBe(true)
    preview.leave()
    time.advance(199)
    expect(open).toBe(true)
    preview.keepOpen()
    time.advance(200)
    expect(open).toBe(true)
    preview.leave()
    time.advance(200)
    expect(open).toBe(false)
  })

  test("touch remains open without a dismissal timer until explicitly closed", () => {
    const time = clock()
    let open = false
    const preview = createHistoryPreviewTimers(() => { open = false }, time.schedule)
    preview.open(() => { open = true }, true)
    preview.leave()
    time.advance(60_000)
    expect(open).toBe(true)
    preview.close()
    expect(open).toBe(false)
  })

  test("leaving before preview or disposing on scope change cancels delayed work", () => {
    const time = clock()
    let count = 0
    const preview = createHistoryPreviewTimers(() => { count-- }, time.schedule)
    preview.hover(() => { count++ })
    preview.leave()
    time.advance(150)
    expect(count).toBe(0)
    preview.dispose()
    time.advance(1000)
    expect(count).toBe(0)
    preview.hover(() => { count++ })
    preview.dispose()
    time.advance(1000)
    expect(count).toBe(0)
  })

  test("moving to another marker replaces the previous reveal", () => {
    const time = clock()
    let current = ""
    const preview = createHistoryPreviewTimers(() => { current = "" }, time.schedule)
    preview.hover(() => { current = "old" })
    time.advance(100)
    preview.hover(() => { current = "new" })
    time.advance(149)
    expect(current).toBe("")
    time.advance(1)
    expect(current).toBe("new")
  })
})
