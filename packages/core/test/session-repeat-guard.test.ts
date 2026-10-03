import { describe, expect, it } from "bun:test"
import { DEFAULT_MAX_REPEATS, MAX_MAX_REPEATS, make } from "@arforge-ai/core/session/repeat-guard"

describe("Session repeat guard", () => {
  it("blocks the next unchanged call after a confirmed failure, but allows a corrected input", () => {
    const guard = make()
    const call = { name: "run", input: { command: "test", count: 1 } }
    guard.observe(call)
    guard.recordOutcome(call, true)
    const blocked = guard.observe({ name: "run", input: { count: 1, command: "test" } })
    expect(blocked).toMatchObject({ kind: "blocked", reason: "previous-failure", repeatCount: 2 })
    if (blocked.kind !== "blocked") throw new Error("expected blocked call")
    expect(blocked.message).toContain("previous execution failed")
    expect(blocked.message).not.toContain('"command"')
    expect(guard.observe({ name: "run", input: { command: "test-fixed" } }).kind).toBe("allow")
  })

  it("does not treat successful results or unrelated failures as failed repeats", () => {
    const guard = make()
    const call = { name: "read", input: { file: "a" } }
    guard.observe(call)
    guard.recordOutcome(call, false)
    guard.recordOutcome({ name: "write", input: { file: "b" } }, true)
    expect(guard.observe(call).kind).toBe("allow")
    guard.recordOutcome(call, true)
    guard.reset()
    expect(guard.observe(call).kind).toBe("allow")
  })
  it("normalizes object key order and blocks only after the bounded allowance", () => {
    const guard = make()

    expect(guard.observe({ name: "echo", input: { text: "same", count: 1 } })).toMatchObject({
      kind: "allow",
      repeatCount: 1,
      maxRepeats: DEFAULT_MAX_REPEATS,
    })
    expect(guard.observe({ name: "echo", input: { count: 1, text: "same" } })).toMatchObject({
      kind: "allow",
      repeatCount: 2,
    })
    expect(guard.observe({ name: "echo", input: { text: "same", count: 1 } })).toMatchObject({
      kind: "allow",
      repeatCount: 3,
    })
    const blocked = guard.observe({ name: "echo", input: { count: 1, text: "same" } })
    expect(blocked).toMatchObject({ kind: "blocked", repeatCount: 4 })
    if (blocked.kind !== "blocked") throw new Error("expected a blocked decision")
    expect(blocked.message).toContain("Repeat guard blocked echo")
    expect(blocked.message).toContain("inputDigest=")
    expect(blocked.message).not.toContain("same")
  })

  it("resets an exact streak when the tool or input changes", () => {
    const guard = make(2)
    guard.observe({ name: "echo", input: { value: "same" } })
    guard.observe({ name: "echo", input: { value: "same" } })
    expect(guard.observe({ name: "echo", input: { value: "other" } })).toMatchObject({
      kind: "allow",
      repeatCount: 1,
    })
    expect(guard.observe({ name: "read", input: { value: "same" } })).toMatchObject({
      kind: "allow",
      repeatCount: 1,
    })
  })

  it("fails open for unsupported input without retaining a lossy digest", () => {
    const guard = make(1)
    const unhashable = guard.observe({ name: "echo", input: { value: 1n } })
    expect(unhashable).toEqual({ kind: "unhashable", name: "echo" })
    expect(guard.observe({ name: "echo", input: { value: "ok" } })).toMatchObject({
      kind: "allow",
      repeatCount: 1,
    })
  })

  it("supports explicit reset and validates the configured bound", () => {
    const guard = make(1)
    guard.observe({ name: "echo", input: {} })
    guard.reset()
    expect(guard.observe({ name: "echo", input: {} })).toMatchObject({ kind: "allow", repeatCount: 1 })
    expect(() => make(0)).toThrow()
    expect(() => make(MAX_MAX_REPEATS + 1)).toThrow()
    expect(() => make(1.5)).toThrow()
  })
})
