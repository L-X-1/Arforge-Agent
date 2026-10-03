import { describe, expect, test } from "bun:test"
import { browserLaunchOptionsFromResolution, resolveBrowserExecutable } from "../playwright-browser"

describe("Playwright browser executable", () => {
  test("prefers the matching managed browser", () => {
    expect(resolveBrowserExecutable("managed", undefined, ["system"], (path) => path === "managed")).toEqual({
      source: "managed",
    })
  })

  test("uses an explicit valid override before managed Chromium", () => {
    expect(resolveBrowserExecutable("managed", "override", ["system"], () => true)).toEqual({
      executablePath: "override",
      source: "override",
    })
  })

  test("falls back to an installed system browser", () => {
    expect(resolveBrowserExecutable("missing", undefined, ["chrome", "edge"], (path) => path === "edge")).toEqual({
      executablePath: "edge",
      source: "system",
    })
  })

  test("rejects a missing explicit override", () => {
    expect(() => resolveBrowserExecutable("managed", "missing", [], () => false)).toThrow(
      "PLAYWRIGHT_BROWSER_EXECUTABLE does not exist",
    )
  })

  test("maps a managed browser to default Playwright launch options", () => {
    expect(browserLaunchOptionsFromResolution({ source: "managed" })).toEqual({})
  })

  test("maps a system browser to an explicit executable", () => {
    expect(browserLaunchOptionsFromResolution({ source: "system", executablePath: "edge" })).toEqual({
      launchOptions: { executablePath: "edge" },
    })
  })

  test("fails early with an actionable install hint when no browser exists", () => {
    expect(() => browserLaunchOptionsFromResolution({ source: "missing" })).toThrow(
      "Install Playwright Chromium",
    )
  })
})
