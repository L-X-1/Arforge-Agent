import type { OperationsApi } from "@/utils/server"
import type { SessionHistoryEvent } from "@/pages/session/execution-run-history-model"

type Requests = Awaited<ReturnType<OperationsApi["permissions"]["list"]>>
export type WaitChildGroup = Awaited<ReturnType<OperationsApi["subagentControl"]["children"]>>
export type WaitSourceLocation = { directory: string; workspace?: string }
type TaskSource = {
  assistantMessageID: string
  callID: string
  parentRunID: string
  childRunID: string
  childSessionID: string
}
type ToolCall = { assistantMessageID: string; callID: string; task: boolean; background: boolean; settled: boolean; binding?: { childRunID: string; childSessionID: string }; invalid: boolean }
const key = (messageID: string, callID: string) => JSON.stringify([messageID, callID])

/** Only the Task owner's stored structured metadata establishes a child identity. */
function childBinding(value: Readonly<Record<string, unknown>>, sessionID: string) {
  if (value.parentSessionId !== sessionID || typeof value.sessionId !== "string" || !value.sessionId ||
    typeof value.durableRunID !== "string" || !value.durableRunID || value.sessionId === sessionID) return
  return { childRunID: value.durableRunID, childSessionID: value.sessionId }
}

/** Source-local projection: no clock, nearby child, list order or reason text joins. */
export function projectWaitSources(input: {
  sessionID: string
  location: WaitSourceLocation
  events: readonly SessionHistoryEvent[]
  requests: Requests
}) {
  const steps = new Map<string, { runID?: string; settled: boolean; invalid: boolean }>()
  const calls = new Map<string, ToolCall>()
  for (const event of input.events) {
    if (event.data.sessionID !== input.sessionID || event.durable?.aggregateID !== input.sessionID) continue
    if (event.location && (event.location.directory !== input.location.directory ||
      (event.location.workspaceID ?? "") !== (input.location.workspace ?? ""))) continue
    switch (event.type) {
      case "session.next.step.started": {
        const data = event.data, prior = steps.get(data.assistantMessageID)
        steps.set(data.assistantMessageID, { runID: data.runID, settled: false, invalid: !!prior?.invalid || (!!prior && prior.runID !== data.runID) })
        break
      }
      case "session.next.step.ended":
      case "session.next.step.failed": {
        const step = steps.get(event.data.assistantMessageID)
        if (step) step.settled = true
        break
      }
      case "session.next.tool.called": {
        const data = event.data, identity = key(data.assistantMessageID, data.callID)
        const prior = calls.get(identity)
        calls.set(identity, { assistantMessageID: data.assistantMessageID, callID: data.callID,
          task: data.tool === "task", background: data.input.background === true, settled: false, invalid: !!prior })
        break
      }
      case "session.next.tool.progress": {
        const data = event.data, call = calls.get(key(data.assistantMessageID, data.callID))
        if (!call?.task) break
        if (data.structured.background === true) call.background = true
        const binding = childBinding(data.structured, input.sessionID)
        if (!binding) { call.invalid = true; break }
        if (call.binding && (call.binding.childRunID !== binding.childRunID || call.binding.childSessionID !== binding.childSessionID)) call.invalid = true
        call.binding = binding
        break
      }
      case "session.next.tool.success":
      case "session.next.tool.failed": {
        const call = calls.get(key(event.data.assistantMessageID, event.data.callID))
        if (call) call.settled = true
      }
    }
  }
  const approvals = input.requests.filter(request => request.sessionID === input.sessionID).map(request => {
    const source = request.source
    const call = source && calls.get(key(source.messageID, source.callID))
    const step = source && steps.get(source.messageID)
    return { requestID: request.id, action: request.action, source,
    parentRunID: call && !call.invalid && !call.settled && step && !step.invalid && !step.settled ? step.runID : undefined }
  })
  const tasks: TaskSource[] = []
  let incomplete = 0
  for (const call of calls.values()) {
    if (!call.task || call.background || call.settled) continue
    const step = steps.get(call.assistantMessageID)
    if (step?.settled) continue
    if (call.invalid || !call.binding || !step?.runID || step.invalid) { incomplete++; continue }
    tasks.push({ assistantMessageID: call.assistantMessageID, callID: call.callID, parentRunID: step.runID, ...call.binding })
  }
  return { approvals, tasks, incomplete }
}

/** A child list is confirmation of the stored identity, never a substitute for it. */
export function joinWaitChildren(tasks: readonly TaskSource[], groups: readonly WaitChildGroup[]) {
  return tasks.map(task => {
    const matches = groups.filter(group => group.parentRunID === task.parentRunID)
      .flatMap(group => group.children.filter(child => child.childRunID === task.childRunID && child.sessionID === task.childSessionID))
    return { ...task, child: matches.length === 1 ? matches[0] : undefined }
  })
}
