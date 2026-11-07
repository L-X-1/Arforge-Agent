import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createRefCountMap } from "./refcount"
import { pathKey } from "./path-key"

describe("createRefCountMap", () => {
  test("shared reactive state survives disposal of its first consumer", () => {
    const [state, setState] = createStore({ value: 1 })
    let cleanups = 0
    const map = createRefCountMap(() => {
      onCleanup(() => cleanups++)
      return createMemo(() => state.value)
    })
    const first = createRoot((dispose) => ({ value: map("/shared"), dispose }))
    const second = createRoot((dispose) => ({ value: map("/shared"), dispose }))
    expect(first.value).toBe(second.value)
    first.dispose()
    setState("value", 2)
    expect(second.value()).toBe(2)
    expect(cleanups).toBe(0)
    second.dispose()
    expect(cleanups).toBe(1)
  })

  test("parent retirement releases every shared resource once and rejects reuse", () => {
    let cleanups = 0
    const removed: string[] = []
    const parent = createRoot((dispose) => ({
      dispose,
      map: createRefCountMap(
        (key) => {
          onCleanup(() => cleanups++)
          return key
        },
        (key) => removed.push(key),
      ),
    }))
    const first = createRoot((dispose) => {
      parent.map("/shared")
      return dispose
    })
    const second = createRoot((dispose) => {
      parent.map("/shared")
      return dispose
    })
    parent.dispose()
    expect(cleanups).toBe(1)
    expect(removed).toEqual(["/shared"])
    first()
    second()
    expect(cleanups).toBe(1)
    expect(removed).toEqual(["/shared"])
    expect(() => parent.map("/shared")).toThrow("disposed")
  })

  test("removes an item after its last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    const first = createRoot((dispose) => {
      map("/project")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("/project")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["/project"])
  })

  test("keeps equivalent path consumers until the last owner is disposed", () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
      pathKey,
    )
    const first = createRoot((dispose) => {
      map("C:\\repo")
      return dispose
    })
    const second = createRoot((dispose) => {
      map("C:/repo/")
      return dispose
    })

    first()
    expect(removed).toEqual([])
    second()
    expect(removed).toEqual(["C:/repo"])
  })
})
