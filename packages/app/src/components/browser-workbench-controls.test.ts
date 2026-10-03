import { expect, test } from "bun:test"
import { canRunBrowserCommand } from "./browser-workbench-controls"

test("stop can interrupt pending browser navigation without enabling concurrent navigations", () => {
  expect(canRunBrowserCommand(true, { action: "stop" })).toBe(true)
  expect(canRunBrowserCommand(true, { action: "navigate", url: "https://example.com" })).toBe(false)
  expect(canRunBrowserCommand(true, { action: "reload" })).toBe(false)
  expect(canRunBrowserCommand(false, { action: "back" })).toBe(true)
})
