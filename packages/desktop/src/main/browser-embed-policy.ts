import type {
  BrowserBounds,
  BrowserLayoutRequest,
  BrowserViewportSnapshot,
  BrowserWorkbenchRequest,
} from "@arforge-ai/app/browser-workbench"
import { createHash } from "node:crypto"
import { normalizeWorkbenchBrowserUrl } from "./browser-policy"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid browser request")
  return value as Record<string, unknown>
}

function scope(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/.test(value))
    throw new TypeError("Invalid browser session scope")
  return value
}

function pageID(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new TypeError("Invalid browser page handle")
  return value
}

export function requireBrowserWorkbenchRequest(value: unknown): BrowserWorkbenchRequest {
  const raw = object(value)
  const key = scope(raw.scope)
  if (raw.action === "open") return { action: "open", scope: key }
  const id = pageID(raw.pageID)
  if (raw.action === "navigate")
    return { action: raw.action, scope: key, pageID: id, url: normalizeWorkbenchBrowserUrl(raw.url) }
  if (
    raw.action === "back" ||
    raw.action === "forward" ||
    raw.action === "reload" ||
    raw.action === "stop" ||
    raw.action === "close"
  )
    return { action: raw.action, scope: key, pageID: id }
  throw new TypeError("Unsupported browser operation")
}

export function requireBrowserLayoutRequest(value: unknown): BrowserLayoutRequest {
  const raw = object(value)
  const key = scope(raw.scope)
  const id = pageID(raw.pageID)
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) <= 0)
    throw new TypeError("Invalid browser layout sequence")
  let bounds: BrowserBounds | null = null
  let viewport: BrowserViewportSnapshot | undefined
  if (raw.bounds !== null) {
    const rect = object(raw.bounds)
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof rect[key] !== "number" || !Number.isFinite(rect[key]) || Math.abs(rect[key]) > 32_768)
        throw new TypeError("Invalid browser bounds")
    }
    if ((rect.width as number) <= 0 || (rect.height as number) <= 0) throw new TypeError("Invalid browser size")
    bounds = { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }
    const captured = object(raw.viewport)
    if (!validViewport(captured)) throw new TypeError("Invalid browser viewport")
    viewport = { width: captured.width, height: captured.height, zoom: captured.zoom }
  }
  return { scope: key, pageID: id, sequence: raw.sequence as number, bounds, ...(viewport ? { viewport } : {}) }
}

function validViewport(value: Record<string, unknown>): value is Record<string, unknown> & BrowserViewportSnapshot {
  return (
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    (value.width as number) > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    (value.height as number) > 0 &&
    typeof value.zoom === "number" &&
    Number.isFinite(value.zoom) &&
    value.zoom > 0
  )
}

export function browserViewportMatches(
  viewport: BrowserViewportSnapshot | undefined,
  zoom: number,
  width: number,
  height: number,
): boolean {
  // Fractional visual-viewport metrics can contain floating-point noise.
  // Quantize in native DIP, never integer CSS pixels (up to 10 DIP per pixel).
  // No missing-snapshot fallback: order/epoch alone cannot establish freshness.
  return (
    !!viewport &&
    validViewport(viewport) &&
    [zoom, width, height].every(Number.isFinite) &&
    zoom > 0 &&
    width > 0 &&
    height > 0 &&
    viewport.zoom === zoom &&
    Math.round(viewport.width * zoom) === width &&
    Math.round(viewport.height * zoom) === height
  )
}

export function browserLayoutActionInput(request: BrowserLayoutRequest) {
  // Bind every validated layout field, while keeping the raw session key out
  // of native authorization payloads and receipts.
  const { scope, ...input } = request
  return { ...input, scopeDigest: createHash("sha256").update(scope).digest("hex") }
}

// DOM rectangles are CSS pixels; Electron child-view bounds are device-independent pixels.
export function clampBrowserBounds(
  bounds: BrowserBounds,
  zoom: number,
  width: number,
  height: number,
): BrowserBounds | null {
  if (![zoom, width, height].every(Number.isFinite) || zoom <= 0 || width <= 0 || height <= 0) return null
  const x = Math.max(0, Math.ceil(bounds.x * zoom))
  const y = Math.max(0, Math.ceil(bounds.y * zoom))
  const right = Math.min(Math.floor(width), Math.floor((bounds.x + bounds.width) * zoom))
  const bottom = Math.min(Math.floor(height), Math.floor((bounds.y + bounds.height) * zoom))
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

export class BrowserLayoutOrder {
  private newest = 0
  reserve(sequence: number) {
    if (sequence <= this.newest) return false
    this.newest = sequence
    return true
  }
  current(sequence: number) {
    return sequence === this.newest
  }
}
