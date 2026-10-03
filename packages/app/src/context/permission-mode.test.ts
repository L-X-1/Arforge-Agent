import { describe, expect, test } from "bun:test"
import { permissionModeAutoRespond, permissionModeFromRules, sessionPermissionRules } from "./permission-mode"

describe("session permission mode", () => {
  test("Plan is enforced as read-only at the backend permission boundary", () => {
    const rules = sessionPermissionRules("plan")
    expect(rules).toContainEqual({ permission: "read", pattern: "*", action: "allow" })
    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(rules).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
  })

  test("Accept edits approves edits but leaves other side effects gated", () => {
    const rules = sessionPermissionRules("acceptEdits")
    expect(rules).toContainEqual({ permission: "*", pattern: "*", action: "ask" })
    expect(rules).toContainEqual({ permission: "edit", pattern: "*", action: "allow" })
    expect(permissionModeAutoRespond("acceptEdits", "edit")).toBe(true)
    expect(permissionModeAutoRespond("acceptEdits", "bash")).toBe(false)
  })

  test("Full access is the auto-accept-all mode", () => {
    expect(sessionPermissionRules("fullAccess")).toEqual([{ permission: "*", pattern: "*", action: "allow" }])
    expect(permissionModeAutoRespond("fullAccess", "bash")).toBe(true)
  })

  test("trusted L3 confirmations remain pending in Full Access while ordinary L2 work keeps its mode behavior", () => {
    expect(permissionModeAutoRespond("fullAccess", "shell", true)).toBe(false)
    expect(permissionModeAutoRespond("fullAccess", "edit", false)).toBe(true)
  })

  test("restores the frontend selection from authoritative Session rules", () => {
    expect(permissionModeFromRules(sessionPermissionRules("plan"))).toBe("plan")
    expect(permissionModeFromRules(sessionPermissionRules("acceptEdits"))).toBe("acceptEdits")
    expect(permissionModeFromRules(sessionPermissionRules("fullAccess"))).toBe("fullAccess")
    expect(
      permissionModeFromRules([
        ...sessionPermissionRules("fullAccess"),
        { permission: "task", pattern: "*", action: "deny" },
      ]),
    ).toBe("fullAccess")
  })
})
