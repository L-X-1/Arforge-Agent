import { expect, test } from "bun:test"
import { toWorkbenchBrowserScope } from "@arforge-ai/app/browser-workbench"
import { BrowserLayoutOrder, clampBrowserBounds, requireBrowserLayoutRequest, requireBrowserWorkbenchRequest } from "./browser-embed-policy"

const pageID = "12345678-1234-1234-1234-123456789abc"
const scope = "server:workspace:session-one"
const bounds = { x: 600, y: 120, width: 480, height: 500 }

test("accepts only bounded, explicit manual browser commands", () => {
  expect(requireBrowserWorkbenchRequest({ action: "open", scope, ignored: "drop" })).toEqual({ action: "open", scope })
  expect(requireBrowserWorkbenchRequest({ action: "navigate", scope, pageID, url: "https://EXAMPLE.com" })).toEqual({
    action: "navigate", scope, pageID, url: "https://example.com/",
  })
  for (const action of ["back", "forward", "reload", "stop", "close"])
    expect(requireBrowserWorkbenchRequest({ action, scope, pageID })).toEqual({ action, scope, pageID })
  for (const action of ["executeJavaScript", "readDOM", "upload", "download", "openDevTools"])
    expect(() => requireBrowserWorkbenchRequest({ action, scope, pageID })).toThrow()
})

test("rejects malformed scope, handles, privileged schemes and credentials", () => {
  for (const value of [null, [], {}, { action: "open", scope: "" }, { action: "open", scope: "x".repeat(16_385) },
    { action: "open", scope: "session\nother" }, { action: "close", scope, pageID: "foreign" },
    { action: "navigate", scope, pageID, url: "file:///C:/secret" },
    { action: "navigate", scope, pageID, url: "https://example.com/?token=secret" }])
    expect(() => requireBrowserWorkbenchRequest(value)).toThrow()
})

test("validates layout rectangles and monotonic sequence values", () => {
  expect(requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds })).toEqual({ scope, pageID, sequence: 1, bounds })
  expect(requireBrowserLayoutRequest({ scope, pageID, sequence: 2, bounds: null }).bounds).toBeNull()
  for (const sequence of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => requireBrowserLayoutRequest({ scope, pageID, sequence, bounds })).toThrow()
  for (const rect of [undefined, {}, { ...bounds, width: 0 }, { ...bounds, y: Infinity }, { ...bounds, height: 40_000 }])
    expect(() => requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds: rect })).toThrow()
})

test("converts CSS bounds through zoom and clips them to the owning window", () => {
  expect(clampBrowserBounds(bounds, 1.25, 1200, 800)).toEqual({ x: 750, y: 150, width: 450, height: 625 })
  expect(clampBrowserBounds({ x: -10, y: -5, width: 30, height: 30 }, 1, 100, 100)).toEqual({ x: 0, y: 0, width: 20, height: 25 })
  expect(clampBrowserBounds(bounds, 1, 500, 100)).toBeNull()
  expect(clampBrowserBounds(bounds, NaN, 1200, 800)).toBeNull()
})

test("an earlier pending layout cannot overtake a later hide or scope switch", () => {
  const order = new BrowserLayoutOrder()
  expect(order.reserve(1)).toBe(true)
  expect(order.reserve(3)).toBe(true)
  expect(order.reserve(2)).toBe(false)
  expect(order.current(1)).toBe(false)
  expect(order.current(3)).toBe(true)
  expect(order.reserve(3)).toBe(false)
})

test("accepts serialized session keys on both IPC channels while rejecting raw separators", () => {
  const raw = "local\u0000workspace-base64/session-one"
  const encoded = toWorkbenchBrowserScope(raw)
  expect(() => requireBrowserWorkbenchRequest({ action: "open", scope: raw })).toThrow("Invalid browser session scope")
  expect(() => requireBrowserLayoutRequest({ scope: raw, pageID, sequence: 1, bounds })).toThrow("Invalid browser session scope")
  expect(requireBrowserWorkbenchRequest({ action: "open", scope: encoded })).toEqual({ action: "open", scope: encoded })
  expect(requireBrowserWorkbenchRequest({ action: "reload", scope: encoded, pageID })).toEqual({ action: "reload", scope: encoded, pageID })
  expect(requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 1, bounds }).scope).toBe(encoded)
  expect(requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 2, bounds: null }).scope).toBe(encoded)
})

test("retains the IPC length limit after browser scope serialization", () => {
  const encoded = toWorkbenchBrowserScope("local\u0000" + "x".repeat(16_384))
  expect(() => requireBrowserWorkbenchRequest({ action: "open", scope: encoded })).toThrow("Invalid browser session scope")
  expect(() => requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 1, bounds })).toThrow("Invalid browser session scope")
})
