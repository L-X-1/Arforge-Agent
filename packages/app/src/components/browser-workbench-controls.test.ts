import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { BrowserPageCommand } from "@/browser-workbench"
import { browserCommandPayload, canRunBrowserCommand } from "./browser-workbench-controls"

test("stop can interrupt pending browser navigation without enabling concurrent navigations", () => {
  expect(canRunBrowserCommand(true, { action: "stop" })).toBe(true)
  expect(canRunBrowserCommand(true, { action: "navigate", url: "https://example.com" })).toBe(false)
  expect(canRunBrowserCommand(true, { action: "reload" })).toBe(false)
  expect(canRunBrowserCommand(false, { action: "back" })).toBe(true)
})

test("a failed navigation retained in Solid state can be cloned for an IPC retry", () => {
  const [state] = createStore<{ lastCommand: BrowserPageCommand }>({
    lastCommand: { action: "navigate", url: "http://127.0.0.1:4321/retry" },
  })
  expect(() => structuredClone(state.lastCommand)).toThrow()
  const captured = browserCommandPayload(state.lastCommand)
  expect(structuredClone(captured)).toEqual({ action: "navigate", url: "http://127.0.0.1:4321/retry" })
  expect(captured).not.toBe(state.lastCommand)
})

test("the renderer sends the normalized address for both first navigation and retained retry", () => {
  for (const [address, expected] of [
    ["example.com/path?q=x#y", "https://example.com/path?q=x#y"],
    ["localhost:5173/path?q=x#y", "http://localhost:5173/path?q=x#y"],
    ["[::1]:5173/path", "http://[::1]:5173/path"],
    ["http://example.com/", "http://example.com/"],
  ]) {
    const [state] = createStore<{ lastCommand: BrowserPageCommand }>({ lastCommand: { action: "navigate", url: address! } })
    expect(structuredClone(browserCommandPayload(state.lastCommand))).toEqual({ action: "navigate", url: expected })
  }
  expect(() => browserCommandPayload({ action: "navigate", url: "javascript:alert(1)" })).toThrow()
  expect(() => browserCommandPayload({ action: "navigate", url: "example.com/?token=secret" })).toThrow()
})
