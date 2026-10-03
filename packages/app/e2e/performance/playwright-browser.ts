import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"

const windowsBrowserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
]

const macBrowserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  join(homedir(), "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
]

const unixBrowserCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
]

const browserCandidatesForPlatform = () => {
  if (process.platform === "win32") return windowsBrowserCandidates
  if (process.platform === "darwin") return macBrowserCandidates
  return unixBrowserCandidates
}

export type BrowserExecutableResolution = {
  executablePath?: string
  source: "managed" | "override" | "system" | "missing"
}

export function resolveBrowserExecutable(
  managedPath: string,
  override: string | undefined,
  candidates = browserCandidatesForPlatform(),
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
  return [...browserCandidatesForPlatform()]
}

/**
 * Resolve one browser launch contract for every bounded reproduction suite.
 * Playwright's managed browser is preferred; an explicit executable or a
 * known system browser is accepted for local user acceptance.  When no
 * executable is available, fail while loading the config with a concrete
 * remediation instead of letting Playwright emit a deep launch-stack error.
 */
export function browserLaunchOptionsFromResolution(browser: BrowserExecutableResolution) {
  if (browser.source === "missing") {
    throw new Error(
      "No browser executable is available. Install Playwright Chromium (`bunx playwright install chromium`) " +
        "or set PLAYWRIGHT_BROWSER_EXECUTABLE to an installed Chrome/Edge path.",
    )
  }
  if (browser.source === "system") {
    console.warn(`[Arforge Playwright] managed Chromium is unavailable; using system browser ${browser.executablePath}`)
  }
  return browser.executablePath ? { launchOptions: { executablePath: browser.executablePath } } : {}
}

export function resolveBrowserLaunchOptions(override = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE) {
  return browserLaunchOptionsFromResolution(resolveBrowserExecutable(chromium.executablePath(), override))
}
