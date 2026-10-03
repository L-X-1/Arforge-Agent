import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@arforge-ai/sdk/v2"
import { buildExecutionTrace, executionMascotForm, executionStepText } from "./execution-trace-model"

const sessionID = "ses_1"
const user = {
  id: "msg_user",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "p", modelID: "m" },
} as Message
const assistant = {
  id: "msg_assistant",
  sessionID,
  role: "assistant",
  parentID: "msg_user",
  time: { created: 2 },
  mode: "build",
  agent: "build",
  modelID: "m",
  providerID: "p",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} as Message

function trace(parts: Part[], status: SessionStatus = { type: "idle" }) {
  return buildExecutionTrace({
    messages: [user, assistant],
    parts: (id) => (id === assistant.id ? parts : []),
    status,
  })
}

describe("execution trace model", () => {
  test("retains complete output, input and source identity beyond the summary limit", () => {
    const output = "full output ".repeat(3000) + "END-OF-OUTPUT"
    const parts = [{ id: "long", sessionID, messageID: assistant.id, type: "tool", callID: "call_long", tool: "bash",
      state: { status: "completed", input: { command: "inspect" }, output, title: "inspect", metadata: {}, time: { start: 1, end: 2 } } }] as Part[]
    const step = trace(parts).steps[0]!
    expect(step.sections?.find((section) => section.kind === "output")?.content).toBe(output)
    expect(executionStepText(step)).toContain("END-OF-OUTPUT")
    expect(executionStepText(step)).toContain("[long] input")
  })
  test("keeps each grouped command's inputs and errors independently inspectable", () => {
    const parts = ["one", "two"].map((id) => ({ id, sessionID, messageID: assistant.id, type: "tool", callID: id, tool: "bash",
      state: { status: "error", input: { command: id }, error: id + " failed", time: { start: 1, end: 2 } } })) as Part[]
    const step = trace(parts).steps[0]!
    expect(step.count).toBe(2)
    expect(step.sections?.filter((section) => section.kind === "error").map((section) => section.source)).toEqual(["one", "two"])
    expect(executionStepText(step)).toContain("two failed")
  })
  test("maps reasoning depth rather than tool kind onto the three mascot forms", () => {
    expect(executionMascotForm()).toBe(1)
    expect(executionMascotForm("medium")).toBe(1)
    expect(executionMascotForm("high")).toBe(2)
    expect(executionMascotForm("max")).toBe(3)
    expect(executionMascotForm("ultra")).toBe(3)
  })

  test("shows a live thinking step before the first event arrives", () => {
    expect(trace([], { type: "busy" }).steps).toEqual([
      { id: "thinking:msg_user", kind: "reasoning", status: "running", count: 1 },
    ])
  })

  test("groups consecutive context tools and carries their running state", () => {
    const parts = [
      {
        id: "read_1",
        sessionID,
        messageID: assistant.id,
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "a.ts" },
          output: "a",
          title: "a.ts",
          metadata: {},
          time: { start: 3, end: 4 },
        },
      },
      {
        id: "grep_1",
        sessionID,
        messageID: assistant.id,
        type: "tool",
        callID: "call_2",
        tool: "grep",
        state: { status: "running", input: { pattern: "TODO" }, title: "TODO", metadata: {}, time: { start: 5 } },
      },
    ] as Part[]

    expect(trace(parts, { type: "busy" }).steps).toMatchObject([
      { kind: "context", count: 2, status: "running", preview: "a.ts · TODO", startedAt: 3 },
    ])
  })

  test("keeps reasoning, edits, subagents, failures and answer delivery distinct", () => {
    const parts = [
      { id: "r", sessionID, messageID: assistant.id, type: "reasoning", text: "检查结构", time: { start: 2, end: 3 } },
      { id: "p", sessionID, messageID: assistant.id, type: "patch", hash: "h", files: ["a.ts", "b.ts"] },
      { id: "a", sessionID, messageID: assistant.id, type: "agent", name: "tester" },
      {
        id: "t",
        sessionID,
        messageID: assistant.id,
        type: "tool",
        callID: "call_t",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "bun test" },
          error: "failed",
          metadata: {},
          time: { start: 4, end: 5 },
        },
      },
      { id: "x", sessionID, messageID: assistant.id, type: "text", text: "完成", time: { start: 6, end: 7 } },
    ] as Part[]

    expect(trace(parts).steps.map((step) => [step.kind, step.status, step.count])).toEqual([
      ["reasoning", "completed", 1],
      ["edit", "completed", 2],
      ["agent", "completed", 1],
      ["command", "error", 1],
      ["answer", "completed", 1],
    ])
    expect(trace(parts).failed).toBe(1)
  })

  test("keeps the real child Session id emitted by the task tool", () => {
    const parts = [
      {
        id: "task",
        sessionID,
        messageID: assistant.id,
        type: "tool",
        callID: "call_task",
        tool: "task",
        state: {
          status: "running",
          input: { prompt: "inspect" },
          metadata: { sessionId: "ses_child" },
          time: { start: 3 },
        },
      },
    ] as Part[]
    expect(trace(parts, { type: "busy" }).steps[0]).toMatchObject({
      kind: "agent",
      status: "running",
      agentSessionID: "ses_child",
    })
  })

  test("only projects the latest user turn", () => {
    const newer = { ...user, id: "msg_user_2", time: { created: 10 } } as Message
    const newerAssistant = { ...assistant, id: "msg_assistant_2", parentID: "msg_user_2" } as Message
    const result = buildExecutionTrace({
      messages: [user, assistant, newer, newerAssistant],
      parts: (id) =>
        id === assistant.id
          ? ([{ id: "old", sessionID, messageID: id, type: "text", text: "old" }] as Part[])
          : ([{ id: "new", sessionID, messageID: id, type: "text", text: "new" }] as Part[]),
      status: { type: "idle" },
    })
    expect(result.userMessageID).toBe("msg_user_2")
    expect(result.steps[0]?.preview).toBe("new")
  })
})
