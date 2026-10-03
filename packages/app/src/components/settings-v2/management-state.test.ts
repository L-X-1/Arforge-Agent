import { describe, expect, test } from "bun:test"
import { managementCopy, managementErrorText, managementState } from "./management-state"
import { ARFORGE_SETTINGS_TABS } from "../control-center/navigation"
import { SESSION_SETTINGS_TABS } from "../session/session-settings-navigation"
import { CONTROL_CENTER_CAPABILITY_MAP } from "@/capabilities/control-center-map"

describe("management feedback states", () => {
  test("does not report empty or successful data while a request is active", () => {
    expect(managementState({ loading: true, empty: true })).toBe("loading")
    expect(managementState({ saving: true, notice: "old receipt" })).toBe("saving")
    expect(managementState({ error: "offline", empty: true })).toBe("error")
    expect(managementState({ notice: "saved" })).toBe("notice")
    expect(managementState({ empty: true })).toBe("empty")
    expect(managementState({})).toBe("ready")
  })

  test("distinguishes unavailable permissions and stale revisions from generic errors", () => {
    expect(managementState({ error: { status: 403 } })).toBe("permission")
    expect(managementState({ error: new Error("401 Unauthorized") })).toBe("permission")
    expect(managementState({ error: "权限不足" })).toBe("permission")
    expect(managementState({ error: { status: 409, message: "Current revision is 9" } })).toBe("conflict")
    expect(managementState({ error: "revision mismatch" })).toBe("conflict")
    expect(managementState({ error: "Service unavailable" })).toBe("error")
  })

  test("renders only a public message and does not serialize a credential-bearing object", () => {
    expect(managementErrorText({ token: "sensitive", response: { password: "secret" } }, "Failed")).toBe("Failed")
    expect(managementErrorText({ message: "Revision 7 is stale", token: "sensitive" })).toBe("Revision 7 is stale")
  })

  test("redacts authentication from public error messages", () => {
    const error = managementErrorText('Request https://user:password@example.test/api?token=sensitive failed; Authorization: Bearer secret-token; api_key="private-value"')
    expect(error).not.toContain("user:password")
    expect(error).not.toContain("sensitive")
    expect(error).not.toContain("secret-token")
    expect(error).not.toContain("private-value")
    expect(error).toContain("example.test")
    expect(error).toContain("[redacted]")
  })

  test("reset copy explicitly limits the operation to keyboard shortcuts", () => {
    expect(managementCopy("en").resetShortcuts).toContain("Only shortcuts")
    expect(managementCopy("zh").resetShortcuts).toContain("只重置快捷键")
  })
})

describe("management capability preservation", () => {
  test("retains all eleven control groups, six session sections and twenty-nine semantic records", () => {
    expect(ARFORGE_SETTINGS_TABS).toHaveLength(11)
    expect(SESSION_SETTINGS_TABS).toHaveLength(6)
    expect(CONTROL_CENTER_CAPABILITY_MAP).toHaveLength(29)
    expect(new Set(ARFORGE_SETTINGS_TABS.map((tab) => tab.value)).size).toBe(11)
  })

  test("retains internal transport as an internal capability record", () => {
    expect(CONTROL_CENTER_CAPABILITY_MAP.filter((record) => record.surface === "transport-internal")).toHaveLength(1)
    expect(CONTROL_CENTER_CAPABILITY_MAP.find((record) => record.surface === "transport-internal")?.risk).toBe("internal")
  })
})
