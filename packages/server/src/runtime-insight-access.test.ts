import { describe, expect, test } from "bun:test"
import { recoveryRollbackPermission, runtimeInsightAccess } from "./handlers/runtime-insight"

describe("runtime insight access projection", () => {
  test.each([
    ["member", false, false, false],
    ["owner", true, true, true],
    ["admin", true, true, true],
  ] as const)("keeps %s capabilities bounded and explicit", (role, canRollback, canMaintain, canRecordMcp) => {
    expect(runtimeInsightAccess(role)).toEqual({
      role,
      canReviewMutation: true,
      canRollbackMutation: canRollback,
      canMaintainArtifacts: canMaintain,
      canRecordMcpEvidence: canRecordMcp,
    })
  })

  test("does not expose profile or tenant identity", () => {
    const projection = runtimeInsightAccess("member")
    expect(Object.keys(projection).sort()).toEqual([
      "canMaintainArtifacts",
      "canRecordMcpEvidence",
      "canReviewMutation",
      "canRollbackMutation",
      "role",
    ])
  })

  test("keeps the destructive rollback gate server-side", () => {
    expect(recoveryRollbackPermission("member")).toBe(
      "Guarded mutation rollback requires an authenticated Owner or Admin.",
    )
    expect(recoveryRollbackPermission("owner")).toBeUndefined()
    expect(recoveryRollbackPermission("admin")).toBeUndefined()
  })
})
