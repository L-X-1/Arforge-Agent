import { describe, expect, test } from "bun:test"
import { createScopeRequestGuard } from "./scope-request"

describe("createScopeRequestGuard", () => {
  test("increments the generation exactly once when a scope changes", () => {
    let scope = "workspace-one"
    const guard = createScopeRequestGuard(() => scope)

    const first = guard.capture()
    expect(first).toEqual({ key: "workspace-one", generation: 0 })
    expect(guard.isCurrent(first)).toBe(true)

    scope = "workspace-two"
    const second = guard.current()
    expect(second).toEqual({ key: "workspace-two", generation: 1 })
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.current()).toEqual(second)
  })

  test("invalidates a same-scope request without changing its key", () => {
    const guard = createScopeRequestGuard(() => "workspace-one")
    const first = guard.capture()
    const invalidated = guard.invalidate()

    expect(invalidated).toEqual({ key: "workspace-one", generation: 1 })
    expect(guard.isCurrent(first)).toBe(false)
    expect(guard.isCurrent(invalidated)).toBe(true)
  })
})
