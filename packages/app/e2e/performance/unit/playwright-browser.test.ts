import { describe, expect, test } from "bun:test"
import { resolveBrowserExecutable } from "../playwright-browser"

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
})
