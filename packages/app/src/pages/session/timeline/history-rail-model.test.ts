import { describe, expect, test } from "bun:test"
import { historyDestination, historyEntries, historyExcerpt, historyWindow } from "./history-rail-model"

describe("history prompt navigation", () => {
  test("indexes human prompts without assistant messages or injected context", () => {
    const entries = historyEntries([
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "synthetic", role: "user" },
      { id: "u2", role: "user" },
      { id: "u1", role: "user" },
    ], (id) => ({
      u1: [{ type: "text", text: "My question" }, { type: "text", text: "private context", synthetic: true }],
      a1: [{ type: "text", text: "The answer" }],
      synthetic: [{ type: "text", text: "continue", synthetic: true }],
      u2: [{ type: "text", text: "hidden", ignored: true }, { type: "file", filename: "design.png" }],
    }[id] ?? []))
    expect(entries.map((entry) => [entry.id, entry.text])).toEqual([["u1", "My question"], ["u2", "design.png"]])
  })

  test("preserves Chinese prompts, timestamps and split text parts", () => {
    expect(historyEntries([{ id: "u", role: "user", time: { created: 42 } }],
      () => [{ type: "text", text: "定位这次提问" }, { type: "text", text: "保留后续回复" }]))
      .toEqual([{ id: "u", text: "定位这次提问\n保留后续回复", created: 42 }])
  })

  test("does not mutate input and supports unnamed attachments", () => {
    const messages = Object.freeze([{ id: "u", role: "user" }])
    expect(historyEntries(messages, () => [{ type: "file" }])[0]?.text).toBe("[attachment]")
    expect(messages).toHaveLength(1)
  })

  test("bounds visible markers for a thousand prompts, including endpoints", () => {
    for (let current = 0; current < 1000; current++) {
      const range = historyWindow(1000, current)
      expect(range.start).toBeLessThanOrEqual(current)
      expect(range.end).toBeGreaterThan(current)
      expect(range.end - range.start).toBeLessThanOrEqual(28)
    }
    expect(historyWindow(0, 0)).toEqual({ start: 0, end: 0 })
    expect(historyWindow(3, 99)).toEqual({ start: 0, end: 3 })
    expect(historyWindow(1000, -1)).toEqual({ start: 0, end: 28 })
    expect(historyWindow(1000, 999)).toEqual({ start: 972, end: 1000 })
  })

  test("keyboard navigation stays in the current conversation", () => {
    expect(historyDestination("ArrowUp", 0, 100)).toBe(0)
    expect(historyDestination("ArrowDown", 99, 100)).toBe(99)
    expect(historyDestination("Home", 80, 100)).toBe(0)
    expect(historyDestination("End", 20, 100)).toBe(99)
    expect(historyDestination("PageUp", 50, 100)).toBe(22)
    expect(historyDestination("PageDown", 50, 100)).toBe(78)
    expect(historyDestination("Enter", 0, 100)).toBeUndefined()
    expect(historyDestination("ArrowDown", 0, 0)).toBeUndefined()
  })

  test("tooltip excerpts are bounded plain text", () => {
    expect(historyExcerpt("  question\n with   spaces ", 100)).toBe("question with spaces")
    expect(historyExcerpt("abcdefgh", 5)).toBe("abcd\u2026")
    expect(historyExcerpt("<script>content</script>")).toBe("<script>content</script>")
  })
})
