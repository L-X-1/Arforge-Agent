import { describe, expect, test } from "bun:test"
import { COMPACT_FILE_PREVIEW_DELAY, createFilePreviewActivation } from "./file-preview-activation"

function fixture() {
  const state = { compact: true, source: {}, identity: "server/workspace/session/tab" }
  const calls: string[] = []
  const timers = new Map<() => void, number>()
  const activation = createFilePreviewActivation(
    {
      compact: () => state.compact,
      source: () => state.source,
      identity: () => state.identity,
      preview: (path) => calls.push("preview:" + path),
      pin: (path) => calls.push("pin:" + path),
    },
    (callback, delay) => {
      timers.set(callback, delay)
      return () => {
        timers.delete(callback)
      }
    },
  )
  const flush = () => {
    const callbacks = [...timers.keys()]
    timers.clear()
    callbacks.forEach((callback) => callback())
  }
  return { state, calls, timers, activation, flush }
}

describe("compact file activation", () => {
  test("a pointer single click waits the approved500ms and keeps its captured path", () => {
    const f = fixture()
    f.activation.select("notes.md", { pointer: true })
    expect(f.calls).toEqual([])
    expect([...f.timers.values()]).toEqual([COMPACT_FILE_PREVIEW_DELAY])
    expect(COMPACT_FILE_PREVIEW_DELAY).toBe(500)
    f.flush()
    expect(f.calls).toEqual(["preview:notes.md"])
  })
  test("double click immediately pins without a later preview replacing it", () => {
    const f = fixture()
    f.activation.select("notes.md", { pointer: true })
    f.activation.select("notes.md", { permanent: true, pointer: true })
    f.flush()
    expect(f.calls).toEqual(["pin:notes.md"])
    expect(f.timers.size).toBe(0)
  })
  test("a newer file click cancels the first file", () => {
    const f = fixture()
    f.activation.select("notes.md", { pointer: true })
    f.activation.select("other.ts", { pointer: true })
    f.flush()
    expect(f.calls).toEqual(["preview:other.ts"])
  })
  for (const changed of ["source", "identity"] as const)
    test(`an old timer cannot cross a changed ${changed}`, () => {
      const f = fixture()
      f.activation.select("notes.md", { pointer: true })
      if (changed === "source") f.state.source = {}
      else f.state.identity = "server/workspace/other-session/other-tab"
      f.flush()
      expect(f.calls).toEqual([])
    })
  test("outside input, navigation and disposal can cancel without firing", () => {
    const f = fixture()
    f.activation.select("notes.md", { pointer: true })
    const stale = [...f.timers.keys()][0]!
    f.activation.cancel()
    stale()
    f.flush()
    expect(f.calls).toEqual([])
  })
  test("keyboard choices and wide layout pointer clicks keep their immediate handlers", () => {
    const f = fixture()
    f.activation.select("keyboard.ts")
    f.state.compact = false
    f.activation.select("wide.ts", { pointer: true })
    expect(f.calls).toEqual(["preview:keyboard.ts", "preview:wide.ts"])
    expect(f.timers.size).toBe(0)
  })
})
