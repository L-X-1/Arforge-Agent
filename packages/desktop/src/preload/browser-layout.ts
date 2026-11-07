import type { BrowserBounds, BrowserLayoutRequest, BrowserViewportSnapshot } from "@arforge-ai/app/browser-workbench"

export function readBrowserViewport(
  viewport: Pick<VisualViewport, "width" | "height" | "scale"> | null,
  zoom: number,
): BrowserViewportSnapshot {
  if (!viewport) throw new TypeError("Browser viewport is unavailable")
  // innerWidth loses up to half a CSS pixel, which becomes five DIP at 10x.
  // Undo visual pinch scale to retain the owner's fractional CSS viewport.
  return { width: viewport.width * viewport.scale, height: viewport.height * viewport.scale, zoom }
}

export function captureBrowserLayout(
  scope: string,
  pageID: string,
  bounds: BrowserBounds | null,
  sequence: number,
  readViewport: () => BrowserViewportSnapshot,
): BrowserLayoutRequest {
  // Hides must still work during teardown, without consulting a live viewport.
  if (bounds === null) return { scope, pageID, sequence, bounds: null }
  const { width, height, zoom } = readViewport()
  return { scope, pageID, sequence, bounds: { ...bounds }, viewport: { width, height, zoom } }
}
