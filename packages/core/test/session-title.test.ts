import { describe, expect, test } from "bun:test"
import { canReplace, isDefaultTitle, normalizeGenerated } from "../src/session/title"

const initial = "新会话 - 2026-09-08T00:00:00.000Z"

describe("canonical session title policy", () => {
  test("recognizes only the complete default title shape", () => {
    expect(isDefaultTitle(initial)).toBe(true)
    expect(isDefaultTitle(initial.replace("新会话", "子会话"))).toBe(true)
    for (const title of ["新会话", `prefix ${initial}`, `${initial} edited`, "My task"])
      expect(isDefaultTitle(title)).toBe(false)
  })

  test("requires the unchanged default and a root session", () => {
    expect(canReplace({ expected: initial, current: initial })).toBe(true)
    expect(canReplace({ expected: initial, current: "My task" })).toBe(false)
    expect(canReplace({ expected: "My task", current: "My task" })).toBe(false)
    expect(canReplace({ expected: initial, current: initial, parentID: "parent" })).toBe(false)
    expect(canReplace({ expected: initial, current: initial.replace("00.000Z", "01.000Z") })).toBe(false)
  })

  test("strips complete reasoning and selects the first nonempty line", () => {
    expect(normalizeGenerated("<think>private\nreasoning</think>\n  Cache investigation \nMore text")).toBe(
      "Cache investigation",
    )
    expect(normalizeGenerated("<THINK>reasoning</THINK>Useful title")).toBe("Useful title")
  })

  test("rejects empty, unfinished reasoning and default-title output", () => {
    for (const output of ["", " \n\t", "<think>private</think>", "<think>unfinished", initial])
      expect(normalizeGenerated(output)).toBeUndefined()
  })

  test("bounds Unicode titles without splitting emoji", () => {
    expect(normalizeGenerated("🙂".repeat(100))).toBe("🙂".repeat(100))
    expect(normalizeGenerated("🙂".repeat(101))).toBe(`${"🙂".repeat(97)}...`)
    expect(Array.from(normalizeGenerated("a".repeat(101)) ?? "")).toHaveLength(100)
  })
})
