import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { observeWorkbenchBrowserOwner } from "./browser-owner-lifecycle"

function fixture() {
  const contents = new EventEmitter()
  let destroyed = false
  let reads = 0
  const owner = Object.defineProperty(new EventEmitter(), "webContents", {
    get() {
      reads++
      if (destroyed) throw new TypeError("Object has been destroyed")
      return contents
    },
  }) as EventEmitter & { readonly webContents: EventEmitter }
  return {
    owner, contents, reads: () => reads,
    destroy: () => { destroyed = true; owner.emit("closed") },
  }
}

test("cleans captured listeners after the native owner getter becomes invalid", () => {
  const source = fixture()
  let disposed = 0
  const stop = observeWorkbenchBrowserOwner(source.owner, {
    suspend: () => undefined,
    dispose: () => { disposed++; stop() },
  })
  expect(() => source.destroy()).not.toThrow()
  expect(disposed).toBe(1)
  expect(source.reads()).toBe(1)
  expect(source.owner.eventNames()).toEqual([])
  expect(source.contents.eventNames()).toEqual([])
})

test("cleanup is idempotent and preserves unrelated listeners", () => {
  const source = fixture()
  const other = () => undefined
  source.owner.on("resize", other)
  source.contents.on("did-start-navigation", other)
  const stop = observeWorkbenchBrowserOwner(source.owner, { suspend: () => undefined, dispose: () => undefined })
  stop()
  stop()
  expect(source.owner.listeners("resize")).toEqual([other])
  expect(source.contents.listeners("did-start-navigation")).toEqual([other])
  expect(source.owner.listenerCount("closed")).toBe(0)
  expect(source.contents.listenerCount("render-process-gone")).toBe(0)
})

test("only full main-frame navigation disposes pages", () => {
  const source = fixture()
  let disposed = 0
  const stop = observeWorkbenchBrowserOwner(source.owner, {
    suspend: () => undefined, dispose: () => { disposed++; stop() },
  })
  source.contents.emit("did-start-navigation", {}, "https://example.com", false, false)
  source.contents.emit("did-start-navigation", {}, "https://example.com#part", true, true)
  expect(disposed).toBe(0)
  source.contents.emit("did-start-navigation", {}, "https://example.com/next", false, true)
  expect(disposed).toBe(1)
  source.destroy()
  expect(disposed).toBe(1)
  expect(source.reads()).toBe(1)
})

test("suspends on geometry and visibility changes until stopped", () => {
  const source = fixture()
  let suspended = 0
  const stop = observeWorkbenchBrowserOwner(source.owner, { suspend: () => { suspended++ }, dispose: () => undefined })
  for (const event of ["resize", "blur", "minimize"]) source.owner.emit(event)
  expect(suspended).toBe(3)
  stop()
  for (const event of ["resize", "blur", "minimize"]) source.owner.emit(event)
  expect(suspended).toBe(3)
})

test("renderer loss disposes once and does not leave a later close callback", () => {
  const source = fixture()
  let disposed = 0
  const stop = observeWorkbenchBrowserOwner(source.owner, {
    suspend: () => undefined, dispose: () => { disposed++; stop() },
  })
  source.contents.emit("render-process-gone", {}, { reason: "crashed" })
  source.destroy()
  expect(disposed).toBe(1)
  expect(source.reads()).toBe(1)
  expect(source.contents.eventNames()).toEqual([])
})
