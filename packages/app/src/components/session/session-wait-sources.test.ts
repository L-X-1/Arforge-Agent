import { describe, expect, test } from "bun:test"
import type { OperationsApi } from "@/utils/server"
import type { SessionHistoryEvent } from "@/pages/session/execution-run-history-model"
import { joinWaitChildren, projectWaitSources, type WaitChildGroup } from "./session-wait-sources"

const sessionID = "ses_parent", location = { directory: "C:/owned" }
const event = (type: SessionHistoryEvent["type"], data: Record<string, unknown>, seq: number): SessionHistoryEvent => ({
  id: `evt_${seq}`, type, durable: { aggregateID: sessionID, seq, version: 1 }, location,
  data: { sessionID, timestamp: seq, ...data },
}) as SessionHistoryEvent
const started = (seq = 1, data = {}) => event("session.next.step.started", { assistantMessageID: "msg_parent", runID: "run_parent", agent: "build", model: { id: "model", providerID: "owned" }, ...data }, seq)
const called = (input = {}, data = {}) => event("session.next.tool.called", { assistantMessageID: "msg_parent", callID: "call_task", tool: "task", input, provider: { executed: false }, ...data }, 2)
const progress = (structured = {}, data = {}, seq = 3) => event("session.next.tool.progress", { assistantMessageID: "msg_parent", callID: "call_task", content: [], structured: { parentSessionId: sessionID, sessionId: "ses_child", durableRunID: "run_child", ...structured }, ...data }, seq)
const events = () => [started(), called(), progress()]
const requests: Awaited<ReturnType<OperationsApi["permissions"]["list"]>> = [{ id: "per_exact", sessionID, action: "task", resources: ["explore"], source: { type: "tool", messageID: "msg_parent", callID: "call_task" } }]
const project = (history = events(), pending = requests) => projectWaitSources({ sessionID, location, events: history, requests: pending })
const group: WaitChildGroup = { parentRunID: "run_parent", children: [{ childRunID: "run_child", sessionID: "ses_child", status: "running", resultReceiptStatus: "pending", depth: 1, objectiveDigest: "a".repeat(64) }] }

describe("Wait source identity projection", () => {
  test("binds permission before child creation, then stored foreground Task to authorized child", () => {
    const pending = project([started(), called()])
    expect(pending.approvals[0]?.parentRunID).toBe("run_parent")
    expect(pending.tasks).toEqual([])
    expect(pending.incomplete).toBe(1)
    const current = project()
    expect(current.tasks).toEqual([{ parentRunID: "run_parent", assistantMessageID: "msg_parent", callID: "call_task", childRunID: "run_child", childSessionID: "ses_child" }])
    expect(joinWaitChildren(current.tasks, [group])[0]?.child?.resultReceiptStatus).toBe("pending")
  })
  test("never joins mismatched assistant/call, parent, foreign directory/workspace or foreign Session", () => {
    for (const history of [
      [started(), called(), progress({}, { assistantMessageID: "msg_other" })],
      [started(), called(), progress({}, { callID: "other" })],
      [started(), called(), progress({ parentSessionId: "ses_foreign" })],
      events().map(e => ({ ...e, location: { directory: "C:/foreign" } })),
      events().map(e => ({ ...e, location: { ...location, workspaceID: "foreign" } })),
      events().map(e => ({ ...e, data: { ...e.data, sessionID: "ses_foreign" } })),
    ]) expect(project(history as SessionHistoryEvent[]).tasks).toEqual([])
    expect(project(events(), [{ ...requests[0]!, sessionID: "ses_foreign" }]).approvals).toEqual([])
  })
  test("a single or latest child cannot replace missing/legacy/conflicting stored binding", () => {
    expect(project([started(1, { runID: undefined }), called(), progress()]).tasks).toEqual([])
    expect(project([called(), progress()]).tasks).toEqual([])
    expect(project([started(), called(), progress({ durableRunID: undefined })]).tasks).toEqual([])
    expect(project([...events(), progress({ durableRunID: "run_other" }, {}, 4)]).tasks).toEqual([])
    expect(project([started(), called(), progress(), started(4, { runID: "run_other" })]).tasks).toEqual([])
    expect(project([started(), called(), progress(), started(4, { runID: "run_other" }), started(5, { runID: "run_other" })]).tasks).toEqual([])
    const task = project().tasks
    for (const other of [{ ...group, parentRunID: "run_foreign" }, { ...group, children: [{ ...group.children[0]!, childRunID: "run_other" }] }, { ...group, children: [{ ...group.children[0]!, sessionID: "ses_other" }] }]) {
      expect(joinWaitChildren(task, [other])[0]?.child).toBeUndefined()
    }
    expect(joinWaitChildren(task, [group, group])[0]?.child).toBeUndefined()
  })
  test("background work and returned/failed tools are not presented as parent waits", () => {
    expect(project([started(), called({ background: true }), progress()]).tasks).toEqual([])
    expect(project([started(), called(), progress({ background: true })]).tasks).toEqual([])
    for (const type of ["session.next.tool.success", "session.next.tool.failed", "session.next.step.ended", "session.next.step.failed"] as const) {
      const terminal = event(type, { assistantMessageID: "msg_parent", callID: "call_task" }, 4)
      expect(project([...events(), terminal]).tasks).toEqual([])
    }
  })
  test("terminal child without receipt remains missing; a receipt is not parent delivery", () => {
    const child = { ...group.children[0]!, status: "completed" as const, resultReceiptStatus: "missing" as const }
    expect(joinWaitChildren(project().tasks, [{ ...group, children: [child] }])[0]?.child).toEqual(child)
    expect(joinWaitChildren(project().tasks, [{ ...group, children: [{ ...child, resultReceiptStatus: undefined }] }])[0]?.child?.resultReceiptStatus).toBeUndefined()
  })
  test("unbound approval stays visible without inventing its parent Run", () => {
    expect(project([], requests).approvals[0]).toMatchObject({ requestID: "per_exact", parentRunID: undefined })
    expect(project([started(), called({}, { callID: "other" })]).approvals[0]?.parentRunID).toBeUndefined()
  })
  test("duplicate tool identities keep approval visible without a verified parent Run", () => {
    const duplicate = { ...called({}, { tool: "read" }), id: "evt_duplicate", durable: { aggregateID: sessionID, seq: 3, version: 1 } }
    const result = project([started(), called(), duplicate])
    expect(result.approvals).toHaveLength(1)
    expect(result.approvals[0]).toMatchObject({ requestID: "per_exact", source: requests[0].source })
    expect(result.approvals[0]?.parentRunID).toBeUndefined()
    expect(result.tasks).toEqual([])
  })
})
