import { existsSync } from "node:fs"

const windowsBrowserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]

export type BrowserExecutableResolution = {
  executablePath?: string
  source: "managed" | "override" | "system" | "missing"
}

export function resolveBrowserExecutable(
  managedPath: string,
  override: string | undefined,
  candidates = process.platform === "win32" ? windowsBrowserCandidates : [],
  exists: (path: string) => boolean = existsSync,
): BrowserExecutableResolution {
  if (override) {
    if (!exists(override)) {
      throw new Error(`PLAYWRIGHT_BROWSER_EXECUTABLE does not exist: ${override}`)
    }
    return { executablePath: override, source: "override" }
  }

  if (exists(managedPath)) return { source: "managed" }

  const systemPath = candidates.find((candidate) => exists(candidate))
  if (systemPath) return { executablePath: systemPath, source: "system" }

  return { source: "missing" }
}

export function systemBrowserCandidates() {
  return [...windowsBrowserCandidates]
}
