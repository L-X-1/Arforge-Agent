import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, SessionStatus, ToolPart } from "@arforge-ai/sdk/v2"
import { buildExecutionTrace, executionStepText, executionToolKey, executionToolStep } from "./execution-trace-model"
import { countVerificationOutcomes, projectExecutionEvidence } from "./execution-evidence"

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

function trace(parts: Part[], status: SessionStatus = { type: "idle" }, prompt?: string, permission?: PermissionRequest) {
  return buildExecutionTrace({
    messages: [user, assistant],
    parts: (id) => (id === assistant.id ? parts : []),
    status,
    prompt,
    permission,
  })
}

function tool(id: string, name: string, state: ToolPart["state"]): ToolPart {
  return { id, sessionID, messageID: assistant.id, type: "tool", callID: "call_" + id, tool: name, state }
}

describe("execution trace model", () => {
  test("only links an unsettled tool to the visible ask with the exact session, message and call", () => {
    const command = tool("verify", "bash", { status: "running", input: { command: "node visible-test.mjs" }, time: { start: 3 } })
    const request: PermissionRequest = {
      id: "per_real", sessionID, permission: "bash", patterns: ["node visible-test.mjs"], always: [], metadata: {},
      tool: { messageID: assistant.id, callID: command.callID },
    }
    const waiting = trace([command], { type: "busy" }, undefined, request)
    expect(waiting.phase).toBe("approval")
    expect(waiting.approval?.tool.id).toBe(command.id)
    expect(projectExecutionEvidence([waiting]).verifications[0]?.status).toBe("approval")
    for (const foreign of [
      { ...request, sessionID: "ses_other" },
      { ...request, tool: { messageID: "msg_other", callID: command.callID } },
      { ...request, tool: { messageID: assistant.id, callID: "call_other" } },
      { ...request, tool: undefined },
    ]) {
      const active = trace([command], { type: "busy" }, undefined, foreign)
      expect(active.phase).toBe("running")
      expect(active.approval).toBeUndefined()
      expect(active.steps[0]?.status).toBe("active")
      expect(projectExecutionEvidence([active]).verifications[0]?.status).toBe("active")
    }
    const denied = tool("verify", "bash", { status: "error", input: command.state.input, error: "Permission denied", time: { start: 3, end: 4 } })
    const finished = trace([denied], { type: "idle" }, undefined, request)
    expect(finished.approval).toBeUndefined()
    expect(finished.phase).toBe("failed")
    expect(projectExecutionEvidence([finished]).verifications[0]).toMatchObject({ status: "tool-error", output: "Permission denied" })
  })

  test("distinguishes admitted, finishing, settled and incomplete evidence", () => {
    const answer: Part = { id: "answer", sessionID, messageID: assistant.id, type: "text", text: "done", time: { start: 3, end: 4 } }
    expect(trace([], { type: "busy" }).phase).toBe("started")
    expect(trace([{ ...answer, time: { start: 3 } }], { type: "busy" }).phase).toBe("running")
    expect(trace([answer], { type: "busy" }).phase).toBe("finishing")
    expect(trace([answer]).phase).toBe("incomplete")
    const settled = buildExecutionTrace({
      messages: [user, { ...assistant, finish: "stop", time: { created: 2, completed: 4 } } as Message],
      parts: (id) => id === assistant.id ? [answer] : [],
      status: { type: "idle" },
    })
    expect(settled.phase).toBe("completed")
  })

  test("links actual exit codes and file snapshots to exact siblings and flags unexecuted requested checks", () => {
    const edit = (id: string, file: string) => tool(id, "edit", {
      status: "completed", input: { path: file }, title: "edit", output: file,
      metadata: { files: [{ file, patch: `patch for ${file}` }] }, time: { start: 2, end: 3 },
    })
    const shell = (id: string, command: string, exit?: number) => tool(id, "bash", {
      status: "completed", input: { command }, title: "bash", output: "this stdout says passed",
      metadata: { exit }, time: { start: 3, end: 4 },
    })
    const parts = [
      edit("in-scope", "c:\\work\\REPO\\src\\owned.ts"),
      edit("out-of-scope", "outside.mjs"),
      edit("unbound", "D:/other/work.ts"),
      shell("exit-three", "node visible-test.mjs", 3),
      shell("missing-exit", "bun test"),
      shell("compound", "node other-test.mjs ; echo OK", 0),
    ]
    const live = trace(parts, { type: "busy" }, "Allowed files: src/\nTest command: node visible-test.mjs\nTest command: cargo check")
    const evidence = projectExecutionEvidence([live], "C:/Work/repo")
    expect(evidence.files.map((file) => [file.toolID, file.scope])).toEqual([
      [executionToolKey(parts[0]), undefined], [executionToolKey(parts[1]), "outside"], [executionToolKey(parts[2]), "incomplete"],
    ])
    expect(evidence.files[1]?.diff).toEqual({ file: "outside.mjs", patch: "patch for outside.mjs" })
    expect(evidence.verifications).toMatchObject([
      { toolID: executionToolKey(parts[3]), status: "failed", exit: 3, output: "this stdout says passed" },
      { toolID: executionToolKey(parts[4]), status: "incomplete" },
      { command: "cargo check", status: "pending" },
    ])
    expect(executionToolStep(live.steps, executionToolKey(parts[3]))?.sections?.map((section) => section.source)).toEqual(["exit-three", "exit-three"])
    expect(executionToolStep(live.steps, executionToolKey(parts[1]))?.sections?.map((section) => section.source)).toEqual(["out-of-scope", "out-of-scope"])
    expect(projectExecutionEvidence([trace(parts, { type: "idle" }, live.prompt)], "C:/Work/repo").verifications.at(-1)?.status).toBe("unexecuted")
    expect(projectExecutionEvidence([trace([edit("case", "src/owned.ts")], { type: "idle" }, "Allowed files: SRC/")], "/work").files[0]?.scope).toBe("outside")
  })

  test("selects a repeated provider call ID by assistant message in Current", () => {
    const next = { ...assistant, id: "msg_next" } as Message
    const result = (exit: number) => ({
      status: "completed" as const, input: { command: "bun test" }, title: "bash",
      output: `receipt with exit ${exit}`, metadata: { exit }, time: { start: 3, end: 4 },
    })
    const first = tool("reused", "bash", result(0))
    const second = { ...tool("reused", "bash", result(7)), messageID: next.id }
    const current = buildExecutionTrace({
      messages: [user, assistant, next], parts: (id) => id === next.id ? [second] : [first],
      status: { type: "idle" },
    })
    const evidence = projectExecutionEvidence([current], "/owned")
    expect(evidence.verifications.map((item) => item.exit)).toEqual([0, 7])
    expect(countVerificationOutcomes(evidence.verifications)).toEqual({ passed: 1, failed: 1, incomplete: 0 })
    const failed = executionToolStep(current.steps, evidence.verifications[1]!.toolID!)
    expect(failed?.tools?.[0]?.messageID).toBe(next.id)
    expect(executionStepText(failed!)).toContain("receipt with exit 7")
    expect(executionStepText(failed!)).not.toContain("receipt with exit 0")
  })

  test("does not satisfy an exact requested command with an external or unverified working directory", () => {
    const command = "node visible-test.mjs"
    const run = (workdir?: string) => trace([tool("shell", "bash", {
      status: "completed", input: { command, ...(workdir === undefined ? {} : { workdir }) }, title: "bash",
      output: "success", metadata: { exit: 0 }, time: { start: 3, end: 4 },
    })], { type: "idle" }, `Test command: ${command}`)
    for (const [directory, cwd, expected] of [
      ["C:/Work/owned", "D:/other", "outside-workspace"],
      ["/work/owned", "/work/owned-alias", "outside-workspace"],
      ["/work/owned", "../unknown", "workdir-unverified"],
      ["/work/owned", "./maybe-a-symlink", "workdir-unverified"],
      [undefined, ".", "workdir-unverified"],
    ] as const) {
      const evidence = projectExecutionEvidence([run(cwd)], directory)
      expect(evidence.verifications.map((entry) => entry.status)).toEqual([expected, "unexecuted"])
      expect(evidence.verifications[0]?.exit).toBe(0)
      expect(countVerificationOutcomes(evidence.verifications)).toEqual({ passed: 0, failed: 0, incomplete: 1 })
    }
    for (const cwd of [undefined, ".", "c:\\WORK\\OWNED\\"]) {
      expect(projectExecutionEvidence([run(cwd)], "C:/Work/owned").verifications.map((entry) => entry.status)).toEqual(["passed"])
    }
  })

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
  test("shows a live thinking step before the first event arrives", () => {
    expect(trace([], { type: "busy" }).steps).toEqual([
      { id: "thinking:msg_user", kind: "reasoning", status: "running", count: 1 },
    ])
  })

  test("projects the public failure of an assistant with no parts", () => {
    const message = "Provider authentication failed. Check the current provider credentials before retrying."
    const failed = { ...assistant, time: { created: 2, completed: 8 }, error: {
      name: "APIError", data: { message, isRetryable: false, responseBody: "private provider response" },
    } } as Message
    const result = buildExecutionTrace({ messages: [user, failed], parts: () => [], status: { type: "idle" } })

    expect(result.failed).toBe(1)
    expect(result.completed).toBe(0)
    expect(result.steps).toMatchObject([{
      id: `${assistant.id}:error`, status: "error", detail: message, startedAt: 2, endedAt: 8,
      sections: [{ kind: "error", source: assistant.id, content: message }],
    }])
    expect(executionStepText(result.steps[0]!)).not.toContain("private provider response")
  })

  test("keeps a deliberate interruption separate from a failed answer", () => {
    const aborted = { ...assistant, error: { name: "MessageAbortedError", data: { message: "Interrupted" } } } as Message
    const result = buildExecutionTrace({ messages: [user, aborted], parts: () => [], status: { type: "idle" } })
    expect(result.failed).toBe(0)
    expect(result.steps).toEqual([])
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
