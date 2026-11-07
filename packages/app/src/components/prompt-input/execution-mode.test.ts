import { describe, expect, test } from "bun:test"
import {
  agentForPermissionMode,
  canUnifyAgentAndPermissionMode,
  permissionModeForAgent,
} from "./execution-mode"

describe("unified prompt execution mode", () => {
  test("combines the native Build and Plan agents into the permission selector", () => {
    expect(canUnifyAgentAndPermissionMode(["build", "plan"])).toBe(true)
    expect(canUnifyAgentAndPermissionMode(["plan", "build"])).toBe(true)
  })

  test("keeps the agent selector when custom agents would otherwise be hidden", () => {
    expect(canUnifyAgentAndPermissionMode(["build", "plan", "review"])).toBe(false)
    expect(canUnifyAgentAndPermissionMode(["build"])).toBe(false)
  })

  test("never unifies away a retained unavailable selection when only native options remain", () => {
    expect(canUnifyAgentAndPermissionMode(["build", "plan"], "owned-r02-review")).toBe(false)
    expect(canUnifyAgentAndPermissionMode(["build", "plan"], "")).toBe(false)
    expect(canUnifyAgentAndPermissionMode(["build", "plan"], "build")).toBe(true)
    expect(canUnifyAgentAndPermissionMode(["build", "plan"], "plan")).toBe(true)
  })

  test("maps the three permission choices onto the two native agents", () => {
    expect(agentForPermissionMode("plan")).toBe("plan")
    expect(agentForPermissionMode("acceptEdits")).toBe("build")
    expect(agentForPermissionMode("fullAccess")).toBe("build")
  })

  test("uses accept edits as the safe Build default when cycling out of Plan", () => {
    expect(permissionModeForAgent("plan", "fullAccess")).toBe("plan")
    expect(permissionModeForAgent("build", "plan")).toBe("acceptEdits")
    expect(permissionModeForAgent("build", "fullAccess")).toBe("fullAccess")
  })
})
