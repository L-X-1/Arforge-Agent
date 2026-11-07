import type { SessionMessageInfo } from "@arforge-ai/client/promise"
import type { OperationsApi } from "@/utils/server"
import type { WorkspaceRun } from "@/components/control-center/personal-workspace-source"
import { createV2SessionReducer } from "@/context/server-session-v2-reducer"
import type { NativeSessionEvent } from "@/context/server-session-native-reducer"
import { normalizeSessionMessages } from "@/utils/session-message"
import { buildExecutionTrace } from "./execution-trace-model"

export type SessionHistoryPage = Awaited<ReturnType<OperationsApi["sessions"]["history"]>>
export type SessionHistoryEvent = SessionHistoryPage["data"][number]
export type RunHistorySummary = Pick<WorkspaceRun, "runID" | "sessionID" | "source" | "status" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt">
export type RunHistoryEntry = {
  runID: string
  sessionID: string
  summary?: RunHistorySummary
  assistantIDs: string[]
  startedAt?: number
  models: string[]
}

type HistoryPrompt = Extract<SessionHistoryEvent, { type: "session.next.prompted" }>["data"]["prompt"]
type PresentationPrompt = Extract<NativeSessionEvent, { type: "session.next.prompted" }>["data"]["prompt"]
function presentationPrompt(prompt: HistoryPrompt): PresentationPrompt {
  const format = prompt.format
  if (format?.type !== "json_schema") return { ...prompt, format }
  // The historical generated SDK permits null for this optional setting.
  // Current Prompt treats an absent setting as its canonical default. Normalize
  // only this presentation copy; keep all JSON-schema nulls and the raw event.
  const { retryCount, ...rest } = format
  return { ...prompt, format: retryCount == null ? rest : { ...rest, retryCount } }
}

export function historyPresentationEvent(event: SessionHistoryEvent): NativeSessionEvent {
  switch (event.type) {
    case "session.next.prompted":
      return { ...event, data: { ...event.data, prompt: presentationPrompt(event.data.prompt) } }
    case "session.next.prompt.admitted":
      return { ...event, data: { ...event.data, prompt: presentationPrompt(event.data.prompt) } }
    case "session.next.prompt.queue.updated":
      return { ...event, data: { ...event.data, prompt: presentationPrompt(event.data.prompt) } }
    default:
      return event
  }
}

/** The cursor is the exclusive session aggregate sequence, never a global event ID. */
export async function readSessionHistory(
  sessionID: string,
  read: (input: { sessionID: string; limit: number; after: number }) => Promise<SessionHistoryPage>,
  signal: AbortSignal,
) {
  const events = new Map<string, SessionHistoryEvent>()
  let after = 0
  while (true) {
    if (signal.aborted) throw signal.reason ?? new Error("History read was cancelled")
    const page = await read({ sessionID, limit: 100, after })
    if (signal.aborted) throw signal.reason ?? new Error("History read was cancelled")
    let next = after
    for (const event of page.data) {
      if (event.data.sessionID !== sessionID || event.durable?.aggregateID !== sessionID) continue
      next = Math.max(next, event.durable.seq)
      events.set(`${event.durable.seq}:${event.id}`, event)
    }
    if (!page.hasMore) break
    if (next <= after) throw new Error("Session history did not advance its aggregate cursor")
    after = next
  }
  return [...events.values()].sort((a, b) => a.durable!.seq - b.durable!.seq)
}

/** A private replay projection; it never mutates the mounted conversation's sync. */
export function projectRunHistory(sessionID: string, events: readonly SessionHistoryEvent[], summaries: readonly RunHistorySummary[]) {
  const runs = new Map<string, RunHistoryEntry>()
  for (const summary of summaries) {
    if (summary.sessionID !== sessionID) continue
    runs.set(summary.runID, { runID: summary.runID, sessionID, summary, assistantIDs: [], startedAt: summary.startedAt ?? summary.createdAt, models: [] })
  }
  const unboundAssistantIDs: string[] = []
  const reducer = createV2SessionReducer()
  let messages: SessionMessageInfo[] = []
  const missingMessages = new Set<string>()
  for (const event of events) {
    if (event.data.sessionID !== sessionID || event.durable?.aggregateID !== sessionID) continue
    if (event.type === "session.next.step.started") {
      const data = event.data
      if (!data.runID) unboundAssistantIDs.push(data.assistantMessageID)
      else {
        const run: RunHistoryEntry = runs.get(data.runID) ?? { runID: data.runID, sessionID, assistantIDs: [], startedAt: data.timestamp, models: [] }
        if (!run.assistantIDs.includes(data.assistantMessageID)) run.assistantIDs.push(data.assistantMessageID)
        const model = `${data.model.providerID}/${data.model.id}`
        if (!run.models.includes(model)) run.models.push(model)
        runs.set(data.runID, run)
      }
    }
    const reduction = reducer.reduce(messages, historyPresentationEvent(event))
    if (!reduction) continue
    messages = reduction.messages
    if (reduction.missing) missingMessages.add(reduction.missing)
  }
  const normalized = normalizeSessionMessages(sessionID, messages)
  return {
    runs: [...runs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    unboundAssistantIDs: [...new Set(unboundAssistantIDs)],
    missingMessages: [...missingMessages],
    steps(runID: string) {
      const run = runs.get(runID)
      if (!run) return []
      const included = new Set(run.assistantIDs)
      const assistants = normalized.messages.filter(message => message.role === "assistant" && included.has(message.id))
      const parents = new Set(assistants.flatMap(message => message.role === "assistant" ? [message.parentID] : []))
      const busy = !!run.summary && ["running", "recovering", "verifying"].includes(run.summary.status)
      return normalized.messages.filter(message => message.role === "user" && parents.has(message.id)).flatMap(user => buildExecutionTrace({
        messages: [user, ...assistants.filter(message => message.role === "assistant" && message.parentID === user.id)],
        parts: id => normalized.parts.get(id) ?? [],
        status: busy ? { type: "busy" } : { type: "idle" },
      }).steps)
    },
  }
}
