export type WindowsRelease = {
  channel: string
  available: boolean
  version: string | null
  architecture: string
  fileName: string | null
  downloadUrl: string | null
  sizeBytes: number | null
  publishedAt: string | null
  signed: boolean
  sha256: string | null
  acceptancePassed: boolean
}

const SHA256 = /^[a-f0-9]{64}$/i

export function safeReturnPath(value: string | null | undefined, fallback = "/app/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback
  try {
    const parsed = new URL(value, "https://arforgeagent.com")
    if (parsed.origin !== "https://arforgeagent.com") return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

export function publicWindowsRelease(manifest: WindowsRelease): manifest is WindowsRelease & {
  version: string
  fileName: string
  downloadUrl: string
  sizeBytes: number
  publishedAt: string
  sha256: string
} {
  if (!manifest.available || !manifest.signed || !manifest.acceptancePassed) return false
  if (!manifest.version || !manifest.fileName || !manifest.downloadUrl || !manifest.publishedAt) return false
  if (!Number.isSafeInteger(manifest.sizeBytes) || (manifest.sizeBytes ?? 0) <= 0) return false
  if (!manifest.sha256 || !SHA256.test(manifest.sha256)) return false
  try {
    const url = new URL(manifest.downloadUrl)
    return url.protocol === "https:" && (url.hostname === "arforgeagent.com" || url.hostname.endsWith(".arforgeagent.com"))
  } catch {
    return false
  }
}
