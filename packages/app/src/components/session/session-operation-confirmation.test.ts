import { describe, expect, test } from "bun:test"
import { sessionOperationConfirmation, type SessionConfirmationObject } from "./session-operation-confirmation"

const source = { server: "https://user:private@example.test/api?token=secret", directory: "E:/workspace", sessionID: "ses_origin", message: "Delete selected task?" }

describe("source-bound session confirmation copy", () => {
  test("shows captured source, object, revision, consequences and recovery without credentials", () => {
    const result = sessionOperationConfirmation({ ...source, object: { kind: "task-delete", id: "task_one", revision: 7 } }, "zh")
    for (const expected of ["https://example.test", "E:/workspace", "ses_origin", "task_one", "7", "影响", "可恢复性", "依赖链接"])
      expect(result.message).toContain(expected)
    for (const secret of ["private", "token=secret", "user:"]) expect(result.message).not.toContain(secret)
    expect(result.danger).toBe(true)
  })

  test("marks destructive actions and external triggers as dangerous, not normal queue admission", () => {
    const dangerous: SessionConfirmationObject["kind"][] = ["schedule-delete", "member-shutdown", "member-remove", "team-delete", "tasks-clear", "task-cancel", "task-delete", "rewind"]
    for (const kind of dangerous) expect(sessionOperationConfirmation({ ...source, object: { kind, id: "object_one" } }, "en").danger).toBe(true)
    expect(sessionOperationConfirmation({ ...source, object: { kind: "schedule-run", id: "schedule_one" } }, "en").danger).toBe(false)
    expect(sessionOperationConfirmation({ ...source, object: { kind: "trigger-run", id: "trigger_one", profile: "local" } }, "en").danger).toBe(false)
    expect(sessionOperationConfirmation({ ...source, object: { kind: "trigger-run", id: "trigger_one", profile: "external" } }, "en").danger).toBe(true)
  })

  test("redacts supplied display text and strips control characters", () => {
    const result = sessionOperationConfirmation({ ...source, message: "Authorization: Bearer secret-token", object: { kind: "wait-wake", id: "wait_one\u0000extra" } }, "en")
    expect(result.message).not.toContain("secret-token")
    expect(result.message).not.toContain("\u0000")
    expect(result.message).toContain("wait_one extra")
    expect(result.message).toContain("Recovery:")
  })
})
