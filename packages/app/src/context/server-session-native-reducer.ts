import type { ArforgeEvent, SessionMessageInfo } from "@arforge-ai/client/promise"
import type { SessionEvent } from "@arforge-ai/schema/session-event"
import type { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { V2SessionReduction } from "./server-session-v2-reducer"

export type NativeSessionEvent = typeof SessionEvent.All.Encoded
export type NativeRunStateEvent = typeof AgentRuntime.Event.RunStateChanged.Encoded
export type CurrentServerEvent = ArforgeEvent | NativeSessionEvent | NativeRunStateEvent

export function isNativeSessionEvent(event: CurrentServerEvent): event is NativeSessionEvent {
  return event.type.startsWith("session.next.")
}

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Content = Assistant["content"][number] & { id?: string }

/** Bridge the current wire contract into the retained message presentation model.
 * IDs and timestamps come from durable data; admission alone is not a visible turn.
 */
export function translateNativeSessionEvent(
  source: readonly SessionMessageInfo[],
  event: NativeSessionEvent,
): ArforgeEvent | V2SessionReduction | undefined {
  const data = event.data
  const result = (messages: SessionMessageInfo[], touched: string[] = []): V2SessionReduction => ({
    sessionID: data.sessionID,
    messages,
    touched,
  })
  const append = (message: SessionMessageInfo) =>
    source.some((item) => item.id === message.id) ? result([...source]) : result([...source, message], [message.id])
  // These values have crossed the JSON wire boundary; the retained client types
  // describe JSON metadata more narrowly than the current schema's Unknown.
  const common = { metadata: event.metadata as SessionMessageInfo["metadata"], time: { created: data.timestamp } }
  const legacy = (type: string, fields: object = data) =>
    ({ ...event, created: data.timestamp, type, data: fields }) as ArforgeEvent
  switch (event.type) {
    case "session.next.prompted":
      return append({
        ...common,
        ...event.data.prompt,
        files: event.data.prompt.files?.map((file) => ({
          mime: file.mime,
          name: file.name,
          data: "",
          source: { type: "uri" as const, uri: file.uri },
          mention: file.source,
          ...(file.resource ? { resource: file.resource } : {}),
        })),
        agents: event.data.prompt.agents?.map((agent) => ({ name: agent.name, mention: agent.source })),
        id: event.data.messageID,
        type: "user",
      })
    case "session.next.agent.switched":
      return append({ ...common, id: event.data.messageID, type: "agent-switched", agent: event.data.agent })
    case "session.next.model.switched":
      return append({ ...common, id: event.data.messageID, type: "model-switched", model: event.data.model })
    case "session.next.synthetic":
      return append({ ...common, id: event.data.messageID, type: "synthetic", text: event.data.text })
    case "session.next.step.started":
      return legacy("session.step.started")
    case "session.next.step.ended":
      return legacy("session.step.ended")
    case "session.next.step.failed":
      return legacy("session.step.failed")
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended": {
      const fields = event.data
      const type = "textID" in fields ? "text" : "reasoning"
      const id = "textID" in fields ? fields.textID : fields.reasoningID
      const current = source.find(
        (item): item is Assistant => item.type === "assistant" && item.id === fields.assistantMessageID,
      )
      if (!current) return { ...result([...source]), missing: fields.assistantMessageID }
      const content = [...current.content] as Content[]
      const index = content.findIndex((item) => item.type === type && item.id === id)
      const prior = index >= 0 ? content[index] : undefined
      const text =
        "text" in fields
          ? fields.text
          : (prior && "text" in prior ? prior.text : "") + ("delta" in fields ? fields.delta : "")
      const next: Content =
        type === "text"
          ? { type, id, text }
          : {
              type,
              id,
              text,
              state:
                "providerMetadata" in fields
                  ? (fields.providerMetadata as Extract<Content, { type: "reasoning" }>["state"])
                  : prior?.type === "reasoning"
                    ? prior.state
                    : undefined,
              time: {
                created: prior?.type === "reasoning" ? (prior.time?.created ?? fields.timestamp) : fields.timestamp,
                completed: event.type.endsWith(".ended")
                  ? fields.timestamp
                  : prior?.type === "reasoning"
                    ? prior.time?.completed
                    : undefined,
              },
            }
      if (index < 0) content.push(next)
      else content[index] = next
      return result(
        source.map((item) => (item.id === current.id ? { ...current, content } : item)),
        [current.id],
      )
    }
    case "session.next.primary.delivered":
      return legacy(event.type)
    case "session.next.tool.input.started":
    case "session.next.tool.input.delta":
    case "session.next.tool.input.ended":
    case "session.next.tool.progress":
      return legacy(event.type.replace("session.next.", "session."))
    case "session.next.tool.called":
    case "session.next.tool.success":
    case "session.next.tool.failed":
      return legacy(event.type.replace("session.next.", "session."), {
        ...event.data,
        executed: event.data.provider.executed,
        ...("metadata" in event.data.provider
          ? { state: event.data.provider.metadata, resultState: event.data.provider.metadata }
          : {}),
      })
    case "session.next.compaction.started":
      return append({
        ...common,
        id: event.data.messageID,
        type: "compaction",
        status: "running",
        reason: event.data.reason,
        summary: "",
        recent: "",
      })
    case "session.next.compaction.delta":
    case "session.next.compaction.ended": {
      const fields = event.data
      const current = source.find((item) => item.id === fields.messageID && item.type === "compaction")
      if (event.type === "session.next.compaction.ended") {
        const message: SessionMessageInfo = {
          ...common,
          id: event.data.messageID,
          type: "compaction",
          status: "completed",
          reason: event.data.reason,
          summary: event.data.text,
          recent: event.data.recent,
        }
        return current
          ? result(
              source.map((item) => (item.id === message.id ? message : item)),
              [message.id],
            )
          : append(message)
      }
      if (!current || current.type !== "compaction" || current.status !== "running") return result([...source])
      return result(
        source.map((item) => (item.id === current.id ? { ...current, summary: current.summary + fields.text } : item)),
        [current.id],
      )
    }
    case "session.next.shell.started":
      return append({
        ...common,
        id: event.data.messageID,
        type: "shell",
        shellID: event.data.callID,
        command: event.data.command,
        status: "running",
      })
    case "session.next.shell.ended": {
      const fields = event.data
      const current = source.find((item) => item.type === "shell" && item.shellID === fields.callID)
      if (!current || current.type !== "shell") return result([...source])
      const size = new TextEncoder().encode(fields.output).byteLength
      return result(
        source.map((item) =>
          item.id === current.id
            ? {
                ...current,
                status: "exited",
                output: { output: fields.output, size, cursor: size, truncated: false },
                time: { ...current.time, completed: fields.timestamp },
              }
            : item,
        ),
        [current.id],
      )
    }
    default:
      return
  }
}
