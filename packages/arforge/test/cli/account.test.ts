import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { resolveConsoleUrl, formatAccountLabel, formatOrgLine } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("requires an explicit or configured console URL", () => {
    expect(resolveConsoleUrl(undefined, {})).toBeUndefined()
    expect(resolveConsoleUrl("https://console.example.test", {})).toBe("https://console.example.test")
    expect(resolveConsoleUrl(undefined, { ARFORGE_CONSOLE_URL: "https://configured.example.test" })).toBe(
      "https://configured.example.test",
    )
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })
})
