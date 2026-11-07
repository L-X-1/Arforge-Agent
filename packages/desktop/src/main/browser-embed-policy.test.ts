import { expect, test } from "bun:test"
import { toWorkbenchBrowserScope } from "@arforge-ai/app/browser-workbench"
import { createNativeActionRequest, NativeActionKind } from "@arforge-ai/core/runtime/native-action"
import {
  BrowserLayoutOrder,
  browserLayoutActionInput,
  browserViewportMatches,
  clampBrowserBounds,
  requireBrowserLayoutRequest,
  requireBrowserWorkbenchRequest,
} from "./browser-embed-policy"

const pageID = "12345678-1234-1234-1234-123456789abc"
const scope = "server:workspace:session-one"
const bounds = { x: 600, y: 120, width: 480, height: 500 }
const viewport = { width: 1440, height: 1000, zoom: 1 }

test("Core input digests bind all validated viewport fields without retaining raw scope", () => {
  const request = requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds, viewport })
  const input = browserLayoutActionInput(request)
  const digest = (payload: typeof input) =>
    createNativeActionRequest({
      senderID: 1,
      kind: NativeActionKind.window,
      name: "workbench-browser-layout",
      payload,
    }).inputDigest
  const original = digest(input)
  expect("scope" in input).toBe(false)
  expect(JSON.stringify(input).includes(scope)).toBe(false)
  expect(input.scopeDigest).toMatch(/^[a-f0-9]{64}$/)
  for (const change of [{ width: 1320 }, { height: 920 }, { zoom: 1.25 }]) {
    const checked = requireBrowserLayoutRequest({ ...request, viewport: { ...viewport, ...change } })
    expect(digest(browserLayoutActionInput(checked))).not.toBe(original)
  }
  expect(
    digest(browserLayoutActionInput(requireBrowserLayoutRequest({ ...request, scope: "other-session" }))),
  ).not.toBe(original)
  expect(digest(browserLayoutActionInput(requireBrowserLayoutRequest({ ...request, bounds: null })))).not.toBe(original)
})

test("accepts only bounded, explicit manual browser commands", () => {
  expect(requireBrowserWorkbenchRequest({ action: "open", scope, ignored: "drop" })).toEqual({ action: "open", scope })
  expect(requireBrowserWorkbenchRequest({ action: "navigate", scope, pageID, url: "https://EXAMPLE.com" })).toEqual({
    action: "navigate",
    scope,
    pageID,
    url: "https://example.com/",
  })
  for (const action of ["back", "forward", "reload", "stop", "close"] as const)
    expect(requireBrowserWorkbenchRequest({ action, scope, pageID })).toEqual({ action, scope, pageID })
  for (const action of ["executeJavaScript", "readDOM", "upload", "download", "openDevTools"])
    expect(() => requireBrowserWorkbenchRequest({ action, scope, pageID })).toThrow()
})

test("the native IPC boundary canonicalizes bare addresses before the browser owner receives them", () => {
  for (const [input, expected] of [
    ["example.com/path?q=x#y", "https://example.com/path?q=x#y"],
    ["localhost:5173/path?q=x#y", "http://localhost:5173/path?q=x#y"],
    ["[::1]:5173/path", "http://[::1]:5173/path"],
  ]) {
    expect(requireBrowserWorkbenchRequest({ action: "navigate", scope, pageID, url: input })).toEqual({
      action: "navigate", scope, pageID, url: expected,
    })
  }
})

test("rejects malformed scope, handles, privileged schemes and credentials", () => {
  for (const value of [
    null,
    [],
    {},
    { action: "open", scope: "" },
    { action: "open", scope: "x".repeat(16_385) },
    { action: "open", scope: "session\nother" },
    { action: "close", scope, pageID: "foreign" },
    { action: "navigate", scope, pageID, url: "file:///C:/secret" },
    { action: "navigate", scope, pageID, url: "https://example.com/?token=secret" },
  ])
    expect(() => requireBrowserWorkbenchRequest(value)).toThrow()
})

test("validates layout rectangles and monotonic sequence values", () => {
  expect(requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds, viewport })).toEqual({
    scope,
    pageID,
    sequence: 1,
    bounds,
    viewport,
  })
  expect(requireBrowserLayoutRequest({ scope, pageID, sequence: 2, bounds: null }).bounds).toBeNull()
  for (const sequence of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => requireBrowserLayoutRequest({ scope, pageID, sequence, bounds, viewport })).toThrow()
  for (const rect of [
    undefined,
    {},
    { ...bounds, width: 0 },
    { ...bounds, y: Infinity },
    { ...bounds, height: 40_000 },
  ])
    expect(() => requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds: rect, viewport })).toThrow()
})

test("show requests require a validated detached viewport snapshot; hides remain compatible", () => {
  const raw = { scope, pageID, sequence: 1, bounds: { ...bounds }, viewport: { ...viewport } }
  const checked = requireBrowserLayoutRequest(raw)
  raw.viewport.width = 1320
  raw.bounds.x = 0
  expect(checked.viewport).toEqual(viewport)
  expect(checked.bounds).toEqual(bounds)
  for (const captured of [
    undefined,
    null,
    {},
    { ...viewport, width: 0 },
    { ...viewport, height: NaN },
    { ...viewport, width: Infinity },
    { ...viewport, zoom: 0 },
    { ...viewport, zoom: Infinity },
    { ...viewport, zoom: "1" },
  ])
    expect(() => requireBrowserLayoutRequest({ scope, pageID, sequence: 1, bounds, viewport: captured })).toThrow()
  expect(requireBrowserLayoutRequest({ scope, pageID, sequence: 2, bounds: null })).toEqual({
    scope,
    pageID,
    sequence: 2,
    bounds: null,
  })
})

test("freshness compares both owner dimensions and zoom in native DIP, not rounded CSS pixels", () => {
  expect(browserViewportMatches(viewport, 1, 1440, 1000)).toBe(true)
  expect(browserViewportMatches(viewport, 1, 1320, 1000)).toBe(false)
  expect(browserViewportMatches(viewport, 1, 1440, 920)).toBe(false)
  expect(browserViewportMatches(viewport, 1.25, 1800, 1250)).toBe(false)
  expect(browserViewportMatches(undefined, 1, 1440, 1000)).toBe(false)
  expect(browserViewportMatches(viewport, NaN, 1440, 1000)).toBe(false)
  expect(
    browserViewportMatches({ width: 1152.800048828125, height: 800.7999877929688, zoom: 1.25 }, 1.25, 1441, 1001),
  ).toBe(true)
  expect(browserViewportMatches({ width: 1152.8, height: 800.8, zoom: 1.25 }, 1.25, 1442, 1001)).toBe(false)
  expect(
    browserViewportMatches({ width: 144.10000610351562, height: 100.0999984741211, zoom: 10 }, 10, 1441, 1001),
  ).toBe(true)
  expect(browserViewportMatches({ width: 144.1, height: 100.1, zoom: 10 }, 10, 1444, 1001)).toBe(false)
})

test("converts CSS bounds through zoom and clips them to the owning window", () => {
  expect(clampBrowserBounds(bounds, 1.25, 1200, 800)).toEqual({ x: 750, y: 150, width: 450, height: 625 })
  expect(clampBrowserBounds({ x: -10, y: -5, width: 30, height: 30 }, 1, 100, 100)).toEqual({
    x: 0,
    y: 0,
    width: 20,
    height: 25,
  })
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
  expect(() => requireBrowserLayoutRequest({ scope: raw, pageID, sequence: 1, bounds, viewport })).toThrow(
    "Invalid browser session scope",
  )
  expect(requireBrowserWorkbenchRequest({ action: "open", scope: encoded })).toEqual({ action: "open", scope: encoded })
  expect(requireBrowserWorkbenchRequest({ action: "reload", scope: encoded, pageID })).toEqual({
    action: "reload",
    scope: encoded,
    pageID,
  })
  expect(requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 1, bounds, viewport }).scope).toBe(encoded)
  expect(requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 2, bounds: null }).scope).toBe(encoded)
})

test("retains the IPC length limit after browser scope serialization", () => {
  const encoded = toWorkbenchBrowserScope("local\u0000" + "x".repeat(16_384))
  expect(() => requireBrowserWorkbenchRequest({ action: "open", scope: encoded })).toThrow(
    "Invalid browser session scope",
  )
  expect(() => requireBrowserLayoutRequest({ scope: encoded, pageID, sequence: 1, bounds, viewport })).toThrow(
    "Invalid browser session scope",
  )
})
