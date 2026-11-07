import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import { browserOwnerZoomWillChange, observeWorkbenchBrowserOwnerZoom } from "./browser-owner-zoom"

function fixture() {
  const trace: string[] = []
  const contents = {
    zoom: 1,
    getZoomFactor() {
      return this.zoom
    },
    setZoomFactor(factor: number) {
      expect(this === contents).toBe(true)
      trace.push("write:" + factor)
      this.zoom = factor
    },
  }
  const owner = Object.assign(new EventEmitter(), { webContents: contents })
  return { owner, contents, trace }
}

test("notifies before the actual native writer and retains its receiver", () => {
  const f = fixture()
  f.owner.on(browserOwnerZoomWillChange, () => {
    f.trace.push("suspend:" + f.contents.zoom)
  })
  const stop = observeWorkbenchBrowserOwnerZoom(f.owner)
  f.contents.setZoomFactor(1.25)
  expect(f.trace).toEqual(["suspend:1", "write:1.25"])
  expect(f.contents.getZoomFactor()).toBe(1.25)
  stop()
})

test("hook installation is idempotent and unchanged zoom does not suspend", () => {
  const f = fixture()
  const stop = observeWorkbenchBrowserOwnerZoom(f.owner)
  const writer = f.contents.setZoomFactor
  expect(observeWorkbenchBrowserOwnerZoom(f.owner) === stop).toBe(true)
  expect(f.contents.setZoomFactor === writer).toBe(true)
  f.owner.on(browserOwnerZoomWillChange, () => {
    f.trace.push("suspend")
  })
  f.contents.setZoomFactor(1)
  expect(f.trace).toEqual(["write:1"])
  stop()
  stop()
  expect(f.owner.listenerCount("closed")).toBe(0)
})

test("close cleanup uses captured contents after the owner's getter becomes invalid", () => {
  const f = fixture()
  const original = f.contents.setZoomFactor
  let destroyed = false
  Object.defineProperty(f.owner, "webContents", {
    get() {
      if (destroyed) throw new Error("owner destroyed")
      return f.contents
    },
  })
  const stop = observeWorkbenchBrowserOwnerZoom(f.owner)
  destroyed = true
  expect(() => f.owner.emit("closed")).not.toThrow()
  expect(f.contents.setZoomFactor === original).toBe(true)
  stop()
})

test("cleanup never overwrites a later owner writer", () => {
  const f = fixture()
  const stop = observeWorkbenchBrowserOwnerZoom(f.owner)
  const later = (_factor: number) => undefined
  f.contents.setZoomFactor = later
  stop()
  expect(f.contents.setZoomFactor === later).toBe(true)
})

test("the real window zoom setup installs the guard before its first zoom write", async () => {
  const source = await readFile(new URL("windows.ts", import.meta.url), "utf8")
  const setup = source.slice(source.indexOf("function wireZoom("), source.indexOf("function clampZoom("))
  expect(setup.indexOf("observeWorkbenchBrowserOwnerZoom(win)")).toBeGreaterThanOrEqual(0)
  expect(setup.indexOf("observeWorkbenchBrowserOwnerZoom(win)")).toBeLessThan(setup.indexOf("setZoomFactor(1)"))
})
