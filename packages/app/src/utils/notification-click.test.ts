import { afterEach, describe, expect, test } from "bun:test"
import { handleNotificationClick, safeNotificationHref, setNavigate } from "./notification-click"

describe("notification click", () => {
  afterEach(() => {
    setNavigate(undefined)
  })

  test("navigates via registered navigate function", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    expect(handleNotificationClick("/abc/session/123?source=notification#message-4")).toBe(true)
    expect(calls).toEqual(["/abc/session/123?source=notification#message-4"])
  })

  test("does not navigate when href is missing", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    expect(handleNotificationClick(undefined)).toBe(false)
    expect(calls).toEqual([])
  })

  test("rejects external, protocol-relative, malformed, and oversized notification targets", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))

    for (const href of [
      "https://example.test/session/123",
      "//example.test/session/123",
      "/\\example.test/session/123",
      "javascript:alert(1)",
      "/abc/session/123\nexternal",
      `/${"x".repeat(2_048)}`,
    ]) {
      expect(safeNotificationHref(href)).toBeUndefined()
      expect(handleNotificationClick(href)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  test("falls back to location.assign without registered navigate", () => {
    handleNotificationClick("/abc/session/123")
    // falls back to window.location.assign — no error thrown
  })
})
