import { describe, expect, test } from "bun:test"
import { isPermissionRequestGone } from "./permission-reply-error"

describe("isPermissionRequestGone", () => {
  test("recognizes the typed server error", () => {
    const error = new Error("request failed", {
      cause: {
        body: {
          _tag: "PermissionNotFoundError",
          requestID: "per_123",
          message: "Permission request not found: per_123",
        },
      },
    })
    expect(isPermissionRequestGone(error, "per_123")).toBe(true)
    expect(isPermissionRequestGone(error, "per_other")).toBe(false)
  })

  test("recognizes the legacy readable error without swallowing unrelated failures", () => {
    expect(isPermissionRequestGone(new Error("Permission request not found: per_123"), "per_123")).toBe(true)
    expect(isPermissionRequestGone(new Error("Session not found: ses_123"), "per_123")).toBe(false)
    expect(isPermissionRequestGone(new Error("Permission request not found: per_other"), "per_123")).toBe(false)
  })
})
