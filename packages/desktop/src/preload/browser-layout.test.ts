import { expect, test } from "bun:test"
import { captureBrowserLayout, readBrowserViewport } from "./browser-layout"

test("trusted fractional viewport survives maximum page zoom and normalizes visual scale", () => {
  const measured = { width: 144.10000610351562, height: 100.0999984741211, scale: 1 }
  const captured = readBrowserViewport(measured, 10)
  expect(captured).toEqual({ width: measured.width, height: measured.height, zoom: 10 })
  expect(Math.round(captured.width * captured.zoom)).toBe(1441)
  expect(Math.round(captured.height * captured.zoom)).toBe(1001)
  expect(readBrowserViewport({ width: 720.5, height: 500.5, scale: 2 }, 1)).toEqual({
    width: 1441,
    height: 1001,
    zoom: 1,
  })
  expect(() => readBrowserViewport(null, 1)).toThrow("Browser viewport is unavailable")
})

test("captures the trusted viewport at invocation and detaches it from later resize", () => {
  const viewport = { width: 1440, height: 1000, zoom: 1 }
  const bounds = { x: 1000, y: 120, width: 440, height: 840 }
  // Public callers cannot replace this metadata with fields on their rectangle.
  const rendererBounds = { ...bounds, viewport: { width: 1, height: 1, zoom: 9 } }
  const request = captureBrowserLayout("scope", "page", rendererBounds, 4, () => viewport)
  viewport.width = 1320
  rendererBounds.x = 880
  expect(request.viewport).toEqual({ width: 1440, height: 1000, zoom: 1 })
  expect(request.bounds?.x).toBe(1000)
  expect(request.scope).toBe("scope")
  expect(request.pageID).toBe("page")
  expect(request.sequence).toBe(4)
  expect(captureBrowserLayout("scope", "page", bounds, 5, () => viewport).viewport?.width).toBe(1320)
})

test("a hide requires neither a live viewport nor a zoom read during teardown", () => {
  expect(
    captureBrowserLayout("scope", "page", null, 6, () => {
      throw new Error("owner disposed")
    }),
  ).toEqual({
    scope: "scope",
    pageID: "page",
    sequence: 6,
    bounds: null,
  })
})
