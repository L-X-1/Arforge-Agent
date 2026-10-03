export * as PreviewResource from "./preview-resource"

import { Schema } from "effect"

// A separate loopback host also avoids sharing ordinary main-server IP cookies.
export const HOST = "127.0.0.2"
export const TTL_MS = 5 * 60_000
export const MAX_ASSET_BYTES = 5_000_000
export const MAX_CSS_BYTES = 1_000_000

export const Grant = Schema.Struct({
  id: Schema.String,
  documentPath: Schema.String,
  baseURL: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "PreviewResource.Grant" })
export interface Grant extends Schema.Schema.Type<typeof Grant> {}
export const isGrant = Schema.is(Grant)

const mimeTypes: Readonly<Record<string, string>> = {
  css: "text/css", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
}

export function resourcePath(value: string): string | undefined {
  if (!value || value.length > 2048 || /[\x00-\x1f\x7f\\:%?#]/.test(value)) return
  const parts = value.split("/")
  if (parts.some((part) => !part || part.startsWith(".") || part.toLowerCase() === "node_modules")) return
  return value
}

export function mimeType(value: string): string | undefined {
  if (!resourcePath(value)) return
  return mimeTypes[value.split(".").at(-1)?.toLowerCase() ?? ""]
}

export function safeBaseURL(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" || url.hostname !== HOST || !url.port || url.username || url.password || url.search || url.hash ||
      !/^\/resources\/[a-f0-9]{64}\/$/.test(url.pathname)
    ) return
    return url.href
  } catch { return }
}

export function resourceURL(value: string, baseURL: string): string | undefined {
  const base = safeBaseURL(baseURL)
  if (!base || !value || /[\x00-\x1f\x7f\\]/.test(value)) return
  try {
    const url = new URL(value, base)
    if (!url.href.startsWith(base) || url.username || url.password) return
    const relative = decodeURIComponent(url.pathname.slice(new URL(base).pathname.length))
    if (!mimeType(relative)) return
    url.search = ""
    url.hash = ""
    return url.href
  } catch { return }
}
