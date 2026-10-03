import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { waitForSmokeEvent } from "./browser-smoke-wait"

const options = { label: "history-back", timeoutMs: 100, failureEvents: ["destroyed", "did-fail-load"] }

test("captures an event emitted synchronously by the action and cleans listeners", async () => {
  const source = new EventEmitter()
  const result = await waitForSmokeEvent(source, "loaded", {
    ...options, action: () => { source.emit("loaded", "one") },
  })
  expect(result).toEqual(["one"])
  expect(source.eventNames()).toEqual([])
})

test("does not pass on a load event until the action also completes", async () => {
  const source = new EventEmitter()
  let finish!: () => void
  const pending = waitForSmokeEvent(source, "loaded", {
    ...options, action: () => new Promise<void>((resolve) => { finish = resolve }),
  })
  let completed = false
  void pending.then(() => { completed = true })
  source.emit("loaded", "two")
  await Promise.resolve()
  expect(completed).toBe(false)
  finish()
  expect(await pending).toEqual(["two"])
  expect(source.eventNames()).toEqual([])
})

test("does not pass on action completion without a load event", async () => {
  const source = new EventEmitter()
  const pending = waitForSmokeEvent(source, "loaded", { ...options, action: () => undefined })
  let completed = false
  void pending.then(() => { completed = true })
  await Promise.resolve()
  expect(completed).toBe(false)
  source.emit("loaded")
  expect(await pending).toEqual([])
  expect(source.eventNames()).toEqual([])
})

test("propagates synchronous action errors and cleans listeners", async () => {
  const source = new EventEmitter()
  const error = new Error("cannot go back")
  await expect(waitForSmokeEvent(source, "loaded", {
    ...options, action: () => { throw error },
  })).rejects.toBe(error)
  expect(source.eventNames()).toEqual([])
})

test("does not hide an action rejection behind an observed event", async () => {
  const source = new EventEmitter()
  const error = new Error("action failed")
  await expect(waitForSmokeEvent(source, "loaded", {
    ...options, action: () => { source.emit("loaded"); return Promise.reject(error) },
  })).rejects.toBe(error)
  expect(source.eventNames()).toEqual([])
})

test("bounds a missing event and includes the failing phase", async () => {
  const source = new EventEmitter()
  await expect(waitForSmokeEvent(source, "loaded", {
    ...options, timeoutMs: 10, action: () => undefined,
  })).rejects.toThrow("[history-back] Timed out waiting for loaded")
  expect(source.eventNames()).toEqual([])
})

test("bounds an unresolved action even when the event arrived", async () => {
  const source = new EventEmitter()
  await expect(waitForSmokeEvent(source, "loaded", {
    ...options, timeoutMs: 10, action: () => { source.emit("loaded"); return new Promise(() => {}) },
  })).rejects.toThrow("[history-back] Timed out")
  expect(source.eventNames()).toEqual([])
})

test("fails immediately when the window or load fails", async () => {
  for (const name of options.failureEvents) {
    const source = new EventEmitter()
    const pending = waitForSmokeEvent(source, "loaded", options)
    source.emit(name)
    await expect(pending).rejects.toThrow("Received " + name)
    expect(source.eventNames()).toEqual([])
  }
})

test("supports event-only waits and preserves unrelated listeners", async () => {
  const source = new EventEmitter()
  const other = () => undefined
  source.on("loaded", other)
  const pending = waitForSmokeEvent(source, "loaded", options)
  source.emit("loaded", { defaultPrevented: true })
  expect(await pending).toEqual([{ defaultPrevented: true }])
  expect(source.listeners("loaded")).toEqual([other])
  expect(source.listenerCount("destroyed")).toBe(0)
})
