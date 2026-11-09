import type { AssistantMessage, Message, Part, PermissionRequest, SessionStatus, ToolPart } from "@arforge-ai/sdk/v2"

export type ExecutionTraceKind = "reasoning" | "context" | "command" | "edit" | "agent" | "verify" | "tool" | "answer" | "retry"
export type ExecutionTraceStatus = "pending" | "active" | "running" | "completed" | "error" | "interrupted"
export type ExecutionPhase =
  | "idle"
  | "started"
  | "running"
  | "approval"
  | "finishing"
  | "retry"
  | "completed"
  | "failed"
  | "interrupted"
  | "incomplete"
export type ExecutionTraceSection = { kind: "input" | "output" | "error" | "detail"; source: string; content: string }

export type ExecutionTraceStep = {
  id: string
  kind: ExecutionTraceKind
  status: ExecutionTraceStatus
  count: number
  title?: string
  preview?: string
  detail?: string
  startedAt?: number
  endedAt?: number
  agentSessionID?: string
  sections?: ExecutionTraceSection[]
  tools?: ToolPart[]
}

export type ExecutionTrace = {
  userMessageID?: string
  startedAt?: number
  prompt?: string
  status: SessionStatus["type"]
  phase: ExecutionPhase
  approval?: { request: PermissionRequest; tool: ToolPart }
  steps: ExecutionTraceStep[]
  completed: number
  failed: number
}

const contextTools = new Set(["read", "glob", "grep", "list", "webfetch", "websearch", "search", "fetch"])
const commandTools = new Set(["bash", "shell", "shell_command", "command"])
const editTools = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const agentTools = new Set(["task", "subagent", "dispatch_agent", "followup_task", "send_message"])
const verifyTools = new Set(["test", "test_runner", "verify", "lsp", "diagnostics"])

const detailLimit = 12_000

function clipped(value: string | undefined) {
  const text = value?.trim()
  if (!text) return
  if (text.length <= detailLimit) return text
  return `${text.slice(0, detailLimit)}\n…`
}

function json(value: unknown) {
  if (value === undefined) return
  try {
    return clipped(JSON.stringify(value, null, 2))
  } catch {
    return clipped(String(value))
  }
}

function toolKind(tool: string): ExecutionTraceKind {
  const normalized = tool.toLowerCase()
  if (contextTools.has(normalized)) return "context"
  if (commandTools.has(normalized)) return "command"
  if (editTools.has(normalized)) return "edit"
  if (agentTools.has(normalized)) return "agent"
  if (verifyTools.has(normalized)) return "verify"
  return "tool"
}

export function executionToolKey(part: ToolPart) {
  return JSON.stringify([part.messageID, part.callID])
}

export function executionToolOutput(part: ToolPart) {
  return "output" in part.state && typeof part.state.output === "string" ? part.state.output : undefined
}

export function executionToolStatus(part: ToolPart): ExecutionTraceStatus {
  if (part.state.status === "completed") return "completed"
  if (part.state.status === "error") {
    // Older runtime interruptions did not include structured receipt metadata.
    if (part.state.metadata?.interrupted === true || part.state.error === "Tool execution interrupted") return "interrupted"
    return "error"
  }
  if (part.state.status === "running") {
    // Called precedes permission admission. Captured command output is the first
    // process evidence available in this projection for older runtime events.
    if (toolKind(part.tool) === "command" && !executionToolOutput(part)) return "active"
    return "running"
  }
  return "pending"
}

function stringField(input: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
}

function toolPreview(part: ToolPart) {
  const input = part.state.input
  const stateTitle = "title" in part.state && typeof part.state.title === "string" ? part.state.title : undefined
  return clipped(
    stateTitle ??
      stringField(input, ["description", "command", "path", "file", "pattern", "query", "url", "task", "prompt"]),
  )
}

function toolDetail(part: ToolPart) {
  const blocks: string[] = []
  const input = json(part.state.input)
  if (input) blocks.push(input)
  const output = clipped(executionToolOutput(part))
  if (output) blocks.push(output)
  if (part.state.status === "error") {
    const error = clipped(part.state.error)
    if (error) blocks.push(error)
  }
  return blocks.length ? blocks.join("\n\n") : undefined
}

function toolSections(part: ToolPart): ExecutionTraceSection[] {
  const sections: ExecutionTraceSection[] = [{ kind: "input", source: part.id, content: JSON.stringify(part.state.input, null, 2) }]
  const output = executionToolOutput(part)
  if (output) sections.push({ kind: "output", source: part.id, content: output })
  if (part.state.status === "error" && part.state.error) sections.push({ kind: "error", source: part.id, content: part.state.error })
  return sections
}

export function executionStepText(step: ExecutionTraceStep) {
  return step.sections?.length
    ? step.sections.map((section) => `[${section.source}] ${section.kind}\n${section.content}`).join("\n\n")
    : step.detail ?? step.preview ?? ""
}

function toolAgentSessionID(part: ToolPart) {
  if (!("metadata" in part.state) || !part.state.metadata || typeof part.state.metadata !== "object") return
  return stringField(part.state.metadata as Record<string, unknown>, ["sessionId", "sessionID", "jobId"])
}

function toolTiming(part: ToolPart) {
  if (part.state.status === "pending") return {}
  return {
    startedAt: part.state.time.start,
    endedAt: part.state.status === "running" ? undefined : part.state.time.end,
  }
}

function partStep(part: Part, busy: boolean): ExecutionTraceStep | undefined {
  if (part.type === "reasoning") {
    return {
      id: part.id,
      kind: "reasoning",
      status: busy && part.time.end === undefined ? "running" : "completed",
      count: 1,
      preview: clipped(part.text.replace(/\s+/g, " ")),
      detail: clipped(part.text),
      sections: [{ kind: "detail", source: part.id, content: part.text }],
      startedAt: part.time.start,
      endedAt: part.time.end,
    }
  }
  if (part.type === "tool") {
    const kind = toolKind(part.tool)
    return {
      id: executionToolKey(part),
      kind,
      status: executionToolStatus(part),
      count: 1,
      title: part.tool,
      preview: toolPreview(part),
      detail: toolDetail(part),
      sections: toolSections(part),
      tools: [part],
      ...(kind === "agent" ? { agentSessionID: toolAgentSessionID(part) } : {}),
      ...toolTiming(part),
    }
  }
  if (part.type === "patch") {
    return {
      id: part.id,
      kind: "edit",
      status: "completed",
      count: Math.max(part.files.length, 1),
      preview: part.files.join(", "),
      detail: part.files.join("\n"),
      sections: [{ kind: "detail", source: part.id, content: part.files.join("\n") }],
    }
  }
  if (part.type === "agent") {
    return { id: part.id, kind: "agent", status: "completed", count: 1, preview: part.name }
  }
  if (part.type === "subtask") {
    return {
      id: part.id,
      kind: "agent",
      status: "completed",
      count: 1,
      title: part.agent,
      preview: part.description,
      detail: clipped(part.prompt),
      sections: [{ kind: "input", source: part.id, content: part.prompt }],
    }
  }
  if (part.type === "retry") {
    return {
      id: part.id,
      kind: "retry",
      status: busy ? "running" : "error",
      count: 1,
      preview: `#${part.attempt}`,
      detail: clipped(JSON.stringify(part.error, null, 2)),
      sections: [{ kind: "error", source: part.id, content: JSON.stringify(part.error, null, 2) }],
      startedAt: part.time.created,
    }
  }
  if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) {
    return {
      id: part.id,
      kind: "answer",
      status: busy && part.time?.end === undefined ? "running" : "completed",
      count: 1,
      preview: clipped(part.text.replace(/\s+/g, " ")),
      detail: clipped(part.text),
      sections: [{ kind: "output", source: part.id, content: part.text }],
      startedAt: part.time?.start,
      endedAt: part.time?.end,
    }
  }
}

function mergeable(a: ExecutionTraceStep, b: ExecutionTraceStep) {
  if (a.kind !== b.kind) return false
  return a.kind === "context" || a.kind === "command" || a.kind === "edit" || a.kind === "verify"
}

function mergeStatus(a: ExecutionTraceStatus, b: ExecutionTraceStatus): ExecutionTraceStatus {
  if (a === "error" || b === "error") return "error"
  if (a === "interrupted" || b === "interrupted") return "interrupted"
  if (a === "running" || b === "running") return "running"
  if (a === "active" || b === "active") return "active"
  if (a === "pending" || b === "pending") return "pending"
  return "completed"
}

function mergeSteps(steps: ExecutionTraceStep[]) {
  return steps.reduce<ExecutionTraceStep[]>((result, step) => {
    const previous = result.at(-1)
    if (!previous || !mergeable(previous, step)) {
      result.push(step)
      return result
    }
    previous.id = `${previous.id}:${step.id}`
    previous.status = mergeStatus(previous.status, step.status)
    previous.count += step.count
    previous.preview = [previous.preview, step.preview].filter(Boolean).join(" · ") || undefined
    previous.detail = [previous.detail, step.detail].filter(Boolean).join("\n\n") || undefined
    previous.sections = [...(previous.sections ?? []), ...(step.sections ?? [])]
    if (step.tools) (previous.tools ??= []).push(...step.tools)
    previous.startedAt = previous.startedAt ?? step.startedAt
    previous.endedAt = step.endedAt ?? previous.endedAt
    return result
  }, [])
}

export function executionToolStep(steps: readonly ExecutionTraceStep[], key: string) {
  for (const step of steps) {
    const tool = step.tools?.find((part) => executionToolKey(part) === key)
    if (tool) return partStep(tool, false)
  }
}

export function executionPhaseLabel(phase: ExecutionPhase, chinese: boolean) {
  const labels: Record<ExecutionPhase, [string, string]> = {
    idle: ["等待下一项任务", "Waiting for the next task"],
    started: ["执行已开始", "Execution started"],
    running: ["正在实时执行", "Executing live"],
    approval: ["等待审批", "Waiting for approval"],
    finishing: ["正在完成本轮执行", "Finishing execution"],
    retry: ["正在重试", "Retrying"],
    completed: ["本轮执行完成", "Execution complete"],
    failed: ["本轮已结束，存在失败步骤", "Finished with failed steps"],
    interrupted: ["执行已中断", "Execution interrupted"],
    incomplete: ["执行记录不完整", "Execution evidence incomplete"],
  }
  return labels[phase][chinese ? 0 : 1]
}

function executionPhase(
  status: SessionStatus["type"],
  steps: ExecutionTraceStep[],
  latest: AssistantMessage | undefined,
  approval: ExecutionTrace["approval"],
): ExecutionPhase {
  if (approval) return "approval"
  if (status === "retry") return "retry"
  const incomplete = steps.some((step) => step.status === "pending" || step.status === "active" || step.status === "running")
  if (status === "busy") {
    if (!steps.length) return "started"
    const last = steps.at(-1)
    if (!incomplete && last?.kind === "answer" && last.status === "completed") return "finishing"
    return "running"
  }
  if (latest?.error?.name === "MessageAbortedError" || steps.at(-1)?.status === "interrupted") return "interrupted"
  if (steps.some((step) => step.status === "error")) return "failed"
  if (!latest && !steps.length) return "idle"
  if (!incomplete && latest?.time.completed !== undefined && latest.finish && latest.finish !== "tool-calls")
    return "completed"
  return "incomplete"
}

export function buildExecutionTrace(input: {
  messages: Message[]
  parts: (messageID: string) => Part[]
  status: SessionStatus
  permission?: PermissionRequest
  prompt?: string
}): ExecutionTrace {
  const user = input.messages.findLast((message) => message.role === "user")
  const assistants = user
    ? input.messages.filter(
        (message): message is AssistantMessage => message.role === "assistant" && message.parentID === user.id,
      )
    : []
  const busy = input.status.type !== "idle"
  const steps = mergeSteps(
    assistants.flatMap((message) => {
      const steps = input.parts(message.id).flatMap((part) => partStep(part, busy) ?? [])
      const error = message.error
      if (!error || error.name === "MessageAbortedError") return steps

      const detail = typeof error.data.message === "string" ? error.data.message : ""
      steps.push({
        id: `${message.id}:error`,
        kind: "answer",
        status: "error",
        count: 1,
        detail: clipped(detail),
        startedAt: message.time.created,
        endedAt: message.time.completed,
        sections: detail.trim() ? [{ kind: "error", source: message.id, content: detail }] : undefined,
      })
      return steps
    }),
  )

  const request = input.permission
  const source = request?.tool
  const approvalTool = request && source && steps.flatMap((step) => step.tools ?? []).find((part) =>
    part.sessionID === request.sessionID && part.messageID === source.messageID && part.callID === source.callID &&
    (part.state.status === "pending" || part.state.status === "running"),
  )
  const approval = request && approvalTool ? { request, tool: approvalTool } : undefined
  const phase = executionPhase(input.status.type, steps, assistants.at(-1), approval)

  if (busy && steps.length === 0) {
    steps.push({ id: `thinking:${user?.id ?? "session"}`, kind: "reasoning", status: "running", count: 1 })
  }

  return {
    userMessageID: user?.id,
    startedAt: user?.time.created,
    prompt: input.prompt ?? (user ? input.parts(user.id).flatMap((part) =>
      part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : [],
    ).join("\n") : undefined),
    status: input.status.type,
    phase,
    approval,
    steps,
    completed: steps.filter((step) => step.status === "completed").length,
    failed: steps.filter((step) => step.status === "error").length,
  }
}
