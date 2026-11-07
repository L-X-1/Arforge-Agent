import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageUser,
} from "@arforge-ai/client/promise"
import type { AssistantMessage, FilePart, Message, Part, ToolPart, UserMessage } from "@arforge-ai/sdk/v2"
import type { SessionMessageUser as CanonicalUser } from "@arforge-ai/sdk/v2/client"
import { Option, Schema } from "effect"
import type { FileAttachment as CanonicalAttachment } from "@arforge-ai/schema/prompt"

type StructuredAssistant = SessionMessageAssistant & { structured?: Record<string, unknown> }
type RequestUser = SessionMessageUser | (Omit<CanonicalUser, "files"> & { files?: ReadonlyArray<CanonicalAttachment> })

const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const emptyModel: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }
const decodeToolInput = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeToolInput(name: string, input: Record<string, unknown>) {
  if (!["edit", "write"].includes(name) || typeof input.path !== "string" || typeof input.filePath === "string")
    return input
  return { ...input, filePath: input.path }
}

function normalizeToolMetadata(name: string, metadata: Record<string, unknown>) {
  if (name !== "edit" || !Array.isArray(metadata.files)) return metadata
  const file = metadata.files.find(record)
  if (!file || typeof file.file !== "string") return metadata
  return {
    ...metadata,
    filediff: {
      file: file.file,
      patch: typeof file.patch === "string" ? file.patch : undefined,
      additions: typeof file.additions === "number" ? file.additions : 0,
      deletions: typeof file.deletions === "number" ? file.deletions : 0,
    },
  }
}

export function normalizeSessionMessages(sessionID: string, source: readonly (SessionMessageInfo | CanonicalUser)[]) {
  const messages: Message[] = []
  const parts = new Map<string, Part[]>()
  let agent = ""
  let model = emptyModel
  let parentID: string | undefined
  let parentRoute: CanonicalUser["route"]

  source.forEach((message) => {
    if (message.type === "agent-switched") {
      agent = message.agent
      return
    }
    if (message.type === "model-switched") {
      model = message.model
      return
    }
    if (message.type === "user") {
      parentID = message.id
      parentRoute = "route" in message ? message.route : undefined
      messages.push(userMessage(sessionID, message, agent, model))
      parts.set(message.id, userParts(sessionID, message))
      return
    }
    if (message.type === "synthetic" && message.description?.trim()) {
      parentID = message.id
      parentRoute = undefined
      messages.push({
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
      })
      parts.set(message.id, [textPart(sessionID, message.id, 0, message.description, true)])
      return
    }
    if (message.type === "shell") {
      messages.push(...shellMessages(sessionID, message, agent, model))
      parts.set(message.id, [textPart(sessionID, message.id, 0, message.command)])
      parts.set(`${message.id}:assistant`, [shellPart(sessionID, message)])
      parentID = undefined
      return
    }
    if (message.type === "assistant") {
      const assistant = message as StructuredAssistant
      agent = assistant.agent
      model = assistant.model
      if (!parentID) return
      const parent = messages.findLast((item) => item.id === parentID)
      if (parent?.role === "user") {
        // Canonical admission captures the configured identity and strength.
        // An assistant may use a wire alias or fallback; infer only missing
        // legacy fields, never replace the caller's explicit turn route.
        if (!parentRoute?.agent) parent.agent = assistant.agent
        if (!parentRoute?.model)
          parent.model = {
            providerID: assistant.model.providerID,
            modelID: assistant.model.id,
            variant: assistant.model.variant,
          }
      }
      messages.push(assistantMessage(sessionID, parentID, assistant))
      parts.set(assistant.id, assistantParts(sessionID, assistant))
      return
    }
    if (message.type !== "compaction" || !parentID) return
    parts.set(parentID, [
      ...(parts.get(parentID) ?? []),
      {
        id: `${message.id}:compaction`,
        sessionID,
        messageID: parentID,
        type: "compaction",
        auto: message.reason === "auto",
      },
    ])
  })

  return { messages, parts }
}

function shellMessages(
  sessionID: string,
  message: SessionMessageShell,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): [UserMessage, AssistantMessage] {
  return [
    {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent,
      model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
    },
    {
      id: `${message.id}:assistant`,
      sessionID,
      role: "assistant",
      time: message.time,
      parentID: message.id,
      modelID: model.id,
      providerID: model.providerID,
      variant: model.variant,
      mode: agent,
      agent,
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: emptyTokens,
    },
  ]
}

function shellPart(sessionID: string, message: SessionMessageShell): ToolPart {
  const input = { command: message.command }
  const start = message.time.created
  const state: ToolPart["state"] =
    message.status === "running"
      ? { status: "running", input, time: { start } }
      : {
          status: "completed",
          input,
          output: message.output?.output ?? "",
          title: "Shell",
          metadata: {
            status: message.status,
            exit: message.exit,
            truncated: message.output?.truncated,
          },
          time: { start, end: message.time.completed ?? start },
        }
  return {
    id: `${message.id}:tool`,
    sessionID,
    messageID: `${message.id}:assistant`,
    type: "tool",
    callID: message.shellID,
    tool: "bash",
    state,
  }
}

export function sessionMessagePartID(messageID: string, type: "text" | "reasoning", ordinal: number) {
  return `${messageID}:${type}:${ordinal}`
}

function userMessage(
  sessionID: string,
  message: RequestUser,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): UserMessage {
  const system = "system" in message ? message.system : undefined
  const route = "route" in message ? message.route : undefined
  const selectedModel = route?.model ?? model
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: message.time,
    agent: route?.agent ?? agent,
    model: { providerID: selectedModel.providerID, modelID: selectedModel.id, variant: selectedModel.variant },
    // Only the original caller's explicit turn instruction is replayable.
    // Runtime/project context and unscoped legacy text must not be promoted.
    system:
      record(system) && system.source === "request" && system.scope === "turn" && typeof system.text === "string"
        ? system.text
        : undefined,
  }
}

function userParts(sessionID: string, message: RequestUser): Part[] {
  return [
    textPart(sessionID, message.id, 0, message.text),
    ...(message.files ?? []).map((file, index): FilePart => {
      const canonical = "uri" in file
      const mention = canonical ? file.source : file.mention
      // Native live events retain resource identity on the compatibility file
      // shape; a URI by itself cannot identify which MCP connection owns it.
      const bridgedResource = !canonical && "resource" in file ? file.resource : undefined
      const resource = canonical
        ? file.resource
        : record(bridgedResource) &&
            typeof bridgedResource.server === "string" &&
            typeof bridgedResource.uri === "string"
          ? { server: bridgedResource.server, uri: bridgedResource.uri }
          : undefined
      return {
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: canonical
          ? file.uri
          : file.source.type === "uri"
            ? file.source.uri
            : `data:${file.mime};base64,${file.data}`,
        source: resource
          ? {
              type: "resource",
              clientName: resource.server,
              uri: resource.uri,
              text: mention
                ? { value: mention.text, start: mention.start, end: mention.end }
                : { value: "", start: 0, end: 0 },
            }
          : mention
            ? {
                type: "file",
                text: { value: mention.text, start: mention.start, end: mention.end },
                path: mention.text.startsWith("@") ? mention.text.slice(1) : (file.name ?? mention.text),
              }
            : undefined,
      }
    }),
    ...(message.agents ?? []).map((item, index): Part => {
      const mention = "source" in item ? item.source : "mention" in item ? item.mention : undefined
      return {
        id: `${message.id}:agent:${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: item.name,
        source: mention ? { value: mention.text, start: mention.start, end: mention.end } : undefined,
      }
    }),
  ]
}

function assistantMessage(sessionID: string, parentID: string, message: StructuredAssistant): AssistantMessage {
  const error = message.error
    ? message.error.type.toLowerCase().includes("abort") || message.error.type.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    error,
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    finish: message.finish,
  }
}

function assistantParts(sessionID: string, message: StructuredAssistant): Part[] {
  const ordinals = { text: 0, reasoning: 0 }
  const parts = message.content.flatMap((content): Part[] => {
    if (content.type === "text") {
      const part = textPart(sessionID, message.id, ordinals.text++, content.text)
      return content.text.trim() ? [part] : []
    }
    if (content.type === "reasoning") {
      const part: Part = {
        id: sessionMessagePartID(message.id, "reasoning", ordinals.reasoning++),
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        metadata: content.state,
        time: {
          start: content.time?.created ?? message.time.created,
          end: content.time?.completed,
        },
      }
      return content.text.trim() ? [part] : []
    }
    return [toolPart(sessionID, message.id, content)]
  })
  if (message.content.some((content) => content.type === "text" && content.text.trim())) return parts
  const structured = record(message.structured) ? structuredText(message.structured) : undefined
  return structured ? [...parts, textPart(sessionID, message.id, ordinals.text, structured, true)] : parts
}

function structuredText(value: Record<string, unknown>) {
  try {
    const json = JSON.stringify(value, undefined, 2)
    const longest = Math.max(0, ...(json.match(/`+/g) ?? []).map((run) => run.length))
    const fence = "`".repeat(Math.max(3, longest + 1))
    return `${fence}json\n${json}\n${fence}`
  } catch {
    return undefined
  }
}

function textPart(sessionID: string, messageID: string, ordinal: number, text: string, synthetic?: boolean): Part {
  return {
    id: sessionMessagePartID(messageID, "text", ordinal),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function toolOutput(tool: SessionMessageAssistantTool & { state: { status: "completed" } }) {
  const output = tool.state.structured
  if (
    tool.name === "read" &&
    (output.type === "text-page" || output.encoding === "utf8") &&
    typeof output.content === "string"
  )
    return output.content
  const text = tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
  if (tool.name === "bash" && typeof output.output === "string")
    return text && text !== output.output ? `${output.output}\n\n${text}` : output.output
  if (tool.state.content.length) return text
  if (Object.keys(output).length === 0 || output.encoding === "base64") return ""
  return JSON.stringify(output, null, 2)
}

function toolPart(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const start = tool.time.ran ?? tool.time.created
  const state = (() => {
    if (tool.state.status === "streaming") {
      const value = Option.getOrUndefined(decodeToolInput(tool.state.input))
      const input = normalizeToolInput(tool.name, record(value) ? value : {})
      return { status: "pending" as const, input, raw: tool.state.input }
    }
    if (tool.state.status === "running") {
      return {
        status: "running" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        time: { start },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        error: tool.state.error.message,
        metadata: normalizeToolMetadata(tool.name, tool.state.structured),
        time: { start, end: tool.time.completed ?? start },
      }
    }
    const attachments = tool.state.content.flatMap((item, index): FilePart[] =>
      item.type === "file"
        ? [
            {
              id: `${tool.id}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              mime: item.mime,
              filename: item.name,
              url: item.uri,
            },
          ]
        : [],
    )
    return {
      status: "completed" as const,
      input: normalizeToolInput(tool.name, tool.state.input),
      output: toolOutput({ ...tool, state: tool.state }),
      title: tool.name,
      metadata: normalizeToolMetadata(tool.name, tool.state.structured),
      time: { start, end: tool.time.completed ?? start },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: { providerState: tool.providerState, providerResultState: tool.providerResultState },
  }
}
