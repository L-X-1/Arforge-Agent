import type { BrowserBounds, BrowserLayoutRequest, BrowserWorkbenchRequest } from "@arforge-ai/app/browser-workbench"
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
  if (raw.action === "navigate") return { action: raw.action, scope: key, pageID: id, url: normalizeWorkbenchBrowserUrl(raw.url) }
  if (raw.action === "back" || raw.action === "forward" || raw.action === "reload" || raw.action === "stop" || raw.action === "close")
    return { action: raw.action, scope: key, pageID: id }
  throw new TypeError("Unsupported browser operation")
}

export function requireBrowserLayoutRequest(value: unknown): BrowserLayoutRequest {
  const raw = object(value)
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) <= 0) throw new TypeError("Invalid browser layout sequence")
  let bounds: BrowserBounds | null = null
  if (raw.bounds !== null) {
    const rect = object(raw.bounds)
    for (const key of ["x", "y", "width", "height"] as const) {
      if (typeof rect[key] !== "number" || !Number.isFinite(rect[key]) || Math.abs(rect[key]) > 32_768)
        throw new TypeError("Invalid browser bounds")
    }
    if ((rect.width as number) <= 0 || (rect.height as number) <= 0) throw new TypeError("Invalid browser size")
    bounds = { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number }
  }
  return { scope: scope(raw.scope), pageID: pageID(raw.pageID), sequence: raw.sequence as number, bounds }
}

// DOM rectangles are CSS pixels; Electron child-view bounds are device-independent pixels.
export function clampBrowserBounds(bounds: BrowserBounds, zoom: number, width: number, height: number): BrowserBounds | null {
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
  current(sequence: number) { return sequence === this.newest }
}
