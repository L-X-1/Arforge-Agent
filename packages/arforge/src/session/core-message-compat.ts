import { SessionV1 } from "@arforge-ai/core/v1/session"
import { canonicalHash } from "@arforge-ai/core/util/canonical-hash"
import type { SessionMessage } from "@arforge-ai/core/session/message"
import { DateTime } from "effect"

const time = (value: DateTime.Utc) => DateTime.toEpochMillis(value)
const partID = (messageID: string, type: string, id: string) => {
  const digest = canonicalHash({ messageID, type, id })
  if (!digest) throw new TypeError(`Core message part identity is not canonicalizable: ${messageID}/${type}/${id}`)
  return SessionV1.PartID.make(`prt_core_${digest.slice(0, 32)}`)
}

const textOutput = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).join("\n")

const attachments = (
  sessionID: SessionV1.SessionInfo["id"],
  messageID: SessionV1.MessageID,
  toolID: string,
  content: ReadonlyArray<{
    readonly type: string
    readonly uri?: string
    readonly mime?: string
    readonly name?: string
  }>,
) =>
  content.flatMap((item, index) =>
    item.type === "file" && item.uri && item.mime
      ? [
          {
            id: partID(messageID, "attachment", `${toolID}:${index}`),
            sessionID,
            messageID,
            type: "file" as const,
            mime: item.mime,
            url: item.uri,
            ...(item.name ? { filename: item.name } : {}),
          },
        ]
      : [],
  )

const toolPart = (
  message: SessionMessage.Assistant,
  sessionID: SessionV1.SessionInfo["id"],
  messageID: SessionV1.MessageID,
  part: SessionMessage.AssistantTool,
): SessionV1.ToolPart => {
  const id = partID(message.id, "tool", part.id)
  const base = { id, sessionID, messageID, type: "tool" as const, callID: part.id, tool: part.name }
  if (part.state.status === "pending")
    return {
      ...base,
      state: { status: "pending", input: {}, raw: part.state.input },
      metadata: { providerExecuted: part.provider?.executed === true },
    }
  if (part.state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: { ...part.state.input },
        title: typeof part.state.structured.title === "string" ? part.state.structured.title : part.name,
        metadata: { ...part.state.structured },
        time: { start: time(part.time.ran ?? part.time.created) },
      },
      metadata: { providerExecuted: part.provider?.executed === true },
    }
  if (part.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: { ...part.state.input },
        error: part.state.error.message,
        metadata: { ...part.state.structured },
        time: {
          start: time(part.time.ran ?? part.time.created),
          end: time(part.time.completed ?? message.time.completed ?? message.time.created),
        },
      },
      metadata: { providerExecuted: part.provider?.executed === true },
    }
  const files = attachments(sessionID, messageID, part.id, part.state.content)
  return {
    ...base,
    state: {
      status: "completed",
      input: { ...part.state.input },
      output: textOutput(part.state.content),
      title: typeof part.state.structured.title === "string" ? part.state.structured.title : part.name,
      metadata: { ...part.state.structured },
      time: {
        start: time(part.time.ran ?? part.time.created),
        end: time(part.time.completed ?? message.time.completed ?? message.time.created),
      },
      ...(files.length > 0 ? { attachments: files } : {}),
    },
    metadata: { providerExecuted: part.provider?.executed === true },
  }
}

export const projectAssistant = (input: {
  readonly message: SessionMessage.Assistant
  readonly sessionID: SessionV1.SessionInfo["id"]
  readonly parentID: SessionV1.MessageID
  readonly path: { readonly cwd: string; readonly root: string }
}): SessionV1.WithParts => {
  const { message, sessionID, parentID, path } = input
  const messageID = SessionV1.MessageID.make(message.id)
  const parts: SessionV1.Part[] = [
    {
      id: partID(message.id, "step-start", "0"),
      sessionID,
      messageID,
      type: "step-start",
      ...(message.snapshot?.start ? { snapshot: message.snapshot.start } : {}),
    },
    ...message.content.map((part): SessionV1.Part => {
      if (part.type === "text")
        return {
          id: partID(message.id, "text", part.id),
          sessionID,
          messageID,
          type: "text",
          text: part.text,
        }
      if (part.type === "reasoning")
        return {
          id: partID(message.id, "reasoning", part.id),
          sessionID,
          messageID,
          type: "reasoning",
          text: part.text,
          metadata: part.providerMetadata,
          time: {
            start: time(part.time?.created ?? message.time.created),
            ...(part.time?.completed ? { end: time(part.time.completed) } : {}),
          },
        }
      return toolPart(message, sessionID, messageID, part)
    }),
  ]
  const tokens = message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  if (message.finish)
    parts.push({
      id: partID(message.id, "step-finish", "0"),
      sessionID,
      messageID,
      type: "step-finish",
      reason: message.finish,
      ...(message.snapshot?.end ? { snapshot: message.snapshot.end } : {}),
      cost: message.cost ?? 0,
      tokens: {
        ...tokens,
        total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      },
    })
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      parentID,
      modelID: message.model.id,
      providerID: message.model.providerID,
      mode: message.agent,
      agent: message.agent,
      path: { ...path },
      cost: message.cost ?? 0,
      tokens: {
        ...tokens,
        total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      },
      structured: message.structured,
      finish: message.finish,
      ...(message.error ? { error: { name: "UnknownError" as const, data: { message: message.error.message } } } : {}),
      time: {
        created: time(message.time.created),
        ...(message.time.completed ? { completed: time(message.time.completed) } : {}),
      },
    },
    parts,
  }
}

export * as CoreMessageCompat from "./core-message-compat"
