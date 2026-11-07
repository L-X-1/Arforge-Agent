import { describe, expect, test } from "bun:test"
import { receiptOperationPhase, receiptOperationStatus, receiptOperationTarget } from "./receipt-operation"
import type { PendingControlApproval } from "@/context/control-approval"

const item = { action: "worktree.remove", subject: { id: "ctl_1", requestID: "request_origin", project: "prj_1", location: "E:/workspace" } } as Pick<PendingControlApproval, "action" | "subject">
const status = { requestID: "request_origin", operation: "worktree.remove", runID: "run_1", actionID: "action_1", phase: "executing", recovery: "none", canApprove: false } as const

describe("real control-operation receipt projection", () => {
  test("uses the captured request alias and refuses unsupported or malformed targets", () => {
    expect(receiptOperationTarget(item)).toEqual({ directory: "E:/workspace", operation: "worktree.remove", requestID: "request_origin" })
    expect(receiptOperationTarget({ ...item, action: "plugin.enable" })).toBeUndefined()
    expect(receiptOperationTarget({ ...item, subject: { ...item.subject, requestID: "../foreign" } })).toBeUndefined()
  })

  test("accepts only an actual matching status and strips payloads, credentials and arbitrary fields", () => {
    const target = receiptOperationTarget(item)!
    const result = receiptOperationStatus({ ...status, secret: "sensitive", payload: { token: "private" } }, target)
    expect(result).toEqual(status)
    expect(JSON.stringify(result)).not.toContain("sensitive")
    expect(JSON.stringify(result)).not.toContain("private")
    expect(() => receiptOperationStatus({ ...status, requestID: "foreign" }, target)).toThrow()
    expect(() => receiptOperationStatus({ ...status, operation: "worktree.reset" }, target)).toThrow()
    expect(() => receiptOperationStatus({ ...status, phase: "approved" }, target)).toThrow()
    expect(() => receiptOperationStatus(true, target)).toThrow()
    expect(receiptOperationPhase("executing", "zh")).toBe("执行中")
    expect(receiptOperationPhase("completed", "en")).toBe("Completed")
  })
})
