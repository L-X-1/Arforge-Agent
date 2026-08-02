import { describe, expect, test } from "bun:test"
import { resolveSessionListPresentation, resolveSessionStatus } from "./sidebar-status"

describe("sidebar session status priority", () => {
  test("shows permission before every other state", () => {
    expect(
      resolveSessionStatus({
        hasPermissions: true,
        hasError: true,
        isWorking: true,
        unseenCount: 3,
      }),
    ).toBe("permission")
  })

  test("shows error before running and unread", () => {
    expect(
      resolveSessionStatus({
        hasPermissions: false,
        hasError: true,
        isWorking: true,
        unseenCount: 3,
      }),
    ).toBe("error")
  })

  test("shows running before unread", () => {
    expect(
      resolveSessionStatus({
        hasPermissions: false,
        hasError: false,
        isWorking: true,
        unseenCount: 3,
      }),
    ).toBe("working")
  })

  test("falls back to unread and then no status", () => {
    expect(
      resolveSessionStatus({
        hasPermissions: false,
        hasError: false,
        isWorking: false,
        unseenCount: 3,
      }),
    ).toBe("unread")
    expect(
      resolveSessionStatus({
        hasPermissions: false,
        hasError: false,
        isWorking: false,
        unseenCount: 0,
      }),
    ).toBeUndefined()
  })
})

describe("sidebar session list presentation", () => {
  test("keeps a retry in the existing feedback row instead of returning to the skeleton", () => {
    expect(resolveSessionListPresentation({ status: "loading", retrying: true, count: 0 })).toBe("retrying")
  })

  test("distinguishes loading, first-load failure, and a genuine empty list", () => {
    expect(resolveSessionListPresentation({ status: "loading", retrying: false, count: 0 })).toBe("loading")
    expect(resolveSessionListPresentation({ status: "error", retrying: false, count: 0 })).toBe("error")
    expect(resolveSessionListPresentation({ status: "ready", retrying: false, count: 0 })).toBe("empty")
  })

  test("keeps existing sessions visible when a background refresh fails", () => {
    expect(resolveSessionListPresentation({ status: "error", retrying: false, count: 2 })).toBe("ready")
    expect(resolveSessionListPresentation({ status: "loading", retrying: true, count: 2 })).toBe("ready")
  })
})
