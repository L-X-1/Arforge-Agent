import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { Message, type ContentPart, type Model } from "@arforge-ai/llm"
import { AgentV2 } from "../../agent"
import { Location } from "../../location"
import { LocationMutation } from "../../location-mutation"
import { AbsolutePath, PositiveInt } from "../../schema"
import { ReadToolFileSystem } from "../../tool/read-filesystem"
import { ToolRegistry } from "../../tool/registry"
import { Tool } from "../../tool/tool"
import { automaticRead } from "../../tool/effect-semantics"
import { TurnToolCarrier } from "../../tool/turn-carrier"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { toLLMMessages } from "./to-llm-message"

export class FileAttachmentError extends Schema.TaggedErrorClass<FileAttachmentError>()(
  "SessionRunner.FileAttachmentError", { message: Schema.String },
) {}

/** Resolve only explicitly admitted local text/directory references through the existing
 * exact-user-grant carrier. The captured Location and read owner remain authoritative.
 */
export const prepareFileMessages = Effect.fn("SessionRunner.prepareFileMessages")(function* (input: {
  readonly context: ReadonlyArray<SessionMessage.Message>
  readonly model: Model
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly location: Location.Ref
  readonly validateExecution: Effect.Effect<void>
}) {
  const messages = toLLMMessages(input.context, input.model)
  if (!input.context.some((message) => message.type === "user" && message.files?.some(
    (file) => !file.resource && ["text/plain", "application/x-directory"].includes(file.mime.toLowerCase()) && /^file:/i.test(file.uri),
  ))) return messages
  const users = new Map<string, SessionMessage.User>()
  for (const message of input.context) {
    if (message.type !== "user") continue
    if (users.has(message.id))
      return yield* new FileAttachmentError({ message: "Duplicate user message identity in attached-file context" })
    users.set(message.id, message)
  }
  const location = yield* Location.Service
  const mutation = yield* LocationMutation.Service
  const reader = yield* ReadToolFileSystem.Service
  const registry = yield* ToolRegistry.Service
  const current = Effect.gen(function* () {
    yield* input.validateExecution
    if (location.directory !== input.location.directory || location.workspaceID !== input.location.workspaceID)
      return yield* new FileAttachmentError({ message: "Attached file belongs to a different Session source" })
    return yield* Effect.void
  })
  yield* current
  const result: Message[] = []
  for (const message of messages) {
    const source = message.id === undefined ? undefined : users.get(message.id)
    if (message.role !== "user" || !source) {
      result.push(message)
      continue
    }
    const content: ContentPart[] = []
    for (const [index, part] of message.content.entries()) {
      if (part.type !== "media" || !["text/plain", "application/x-directory"].includes(part.mediaType.toLowerCase()) ||
        typeof part.data !== "string" || !/^file:/i.test(part.data)) {
        content.push(part)
        continue
      }
      const files = (source.files ?? []).filter((file) => !file.resource)
      const admitted = files[index - 1]
      if (!admitted || admitted.uri !== part.data || admitted.mime !== part.mediaType || admitted.name !== part.filename)
        return yield* new FileAttachmentError({ message: "Attached file no longer matches its admitted user message" })
      const directory = part.mediaType.toLowerCase() === "application/x-directory"
      const parsed = yield* Effect.try({
        try: () => {
          const url = new URL(admitted.uri)
          if ((url.hostname && url.hostname !== "localhost") || url.username || url.password || url.hash ||
            [...url.searchParams.keys()].some((key) => key !== "start" && key !== "end")) throw Error("unsupported file URI")
          const start = url.searchParams.get("start"), end = url.searchParams.get("end")
          if ((start !== null && !/^[1-9]\d*$/.test(start)) || (end !== null && !/^[1-9]\d*$/.test(end)) ||
            (end !== null && (start === null || Number(end) < Number(start)))) throw Error("invalid file range")
          const offset = start === null ? undefined : Schema.decodeUnknownSync(PositiveInt)(Number(start))
          const limit = end === null ? undefined : Schema.decodeUnknownSync(PositiveInt)(Number(end) - Number(start) + 1)
          if (limit !== undefined && limit > ReadToolFileSystem.MAX_READ_LINES) throw Error("file range exceeds read limit")
          return { filePath: path.resolve(fileURLToPath(url)), page: offset === undefined ? undefined : { offset, limit } }
        },
        catch: () => new FileAttachmentError({ message: "Attached file URI or selected line range is invalid" }),
      })
      yield* current
      const target = yield* mutation.resolve({ path: parsed.filePath, kind: directory ? "directory" : "file" })
      const carrier = TurnToolCarrier.UserAttachmentRead.make(Tool.withPermission(Tool.make({
        description: "Read the exact text file or bounded directory listing explicitly attached by this user message",
        input: Schema.Struct({ filePath: Schema.Literal(parsed.filePath) }),
        output: Schema.String,
        effects: ({ filePath }) => automaticRead({ filesystemScope: [filePath] }),
        execute: (_args, context) => Effect.gen(function* () {
          yield* current
          const checked = yield* mutation.resolve({ path: parsed.filePath, kind: directory ? "directory" : "file" })
          if (checked.canonical !== target.canonical || checked.resource !== target.resource ||
            checked.externalDirectory?.resource !== target.externalDirectory?.resource)
            return yield* new FileAttachmentError({ message: "Attached file path changed before its authorized read" })
          yield* context.permission.assert({ action: "read", resources: [checked.resource] })
          if (directory) {
            const absolute = AbsolutePath.make(checked.canonical)
            if ((yield* reader.inspect(absolute)) !== "directory")
              return yield* new FileAttachmentError({ message: "Attached directory URI does not identify a directory" })
            const listing = yield* reader.list(absolute, parsed.page)
            yield* current
            return JSON.stringify(listing)
          }
          const read = yield* reader.read(AbsolutePath.make(checked.canonical), checked.resource, parsed.page, { preserveBOM: true })
          yield* current
          if ("encoding" in read) {
            if (read.encoding !== "utf8") return yield* new FileAttachmentError({ message: "Attached text file contains binary media" })
            return read.content
          }
          if (parsed.page === undefined)
            return yield* new FileAttachmentError({ message: "Attached file exceeds the bounded read; select a smaller line range" })
          return read.content
        }).pipe(Effect.mapError((error) => new Tool.Failure({ message: error instanceof Error ? error.message : "Attached file read failed" }))),
      }), "read"))
      const materialized = yield* registry.materialize([], input.sessionID, { includeRegistered: false, userAttachmentRead: carrier })
      const settled = yield* materialized.settle({
        sessionID: input.sessionID, agent: input.agent, assistantMessageID: source.id,
        call: { type: "tool-call", id: `user-attachment:${source.id}:${index - 1}:agent:${encodeURIComponent(input.agent)}`, name: TurnToolCarrier.userAttachmentReadName,
          input: { filePath: parsed.filePath } },
      })
      yield* current
      if (settled.outputPaths?.length || settled.artifactRefs?.length)
        return yield* new FileAttachmentError({ message: "Attached-file text was truncated by managed output limits; select a smaller line range" })
      if (settled.result.type === "error")
        return yield* new FileAttachmentError({ message: typeof settled.result.value === "string"
          ? settled.result.value : "Authorized attached-file read failed" })
      if ((settled.result.type !== "text" && settled.result.type !== "json") || typeof settled.result.value !== "string")
        return yield* new FileAttachmentError({ message: "Authorized attached-file read did not return complete text" })
      content.push({ type: "text", text: `Attached ${directory ? "directory" : "file"} ${JSON.stringify(admitted.name ?? path.basename(parsed.filePath))} (${part.mediaType}):\n${settled.result.value}`,
        metadata: part.metadata })
    }
    result.push(Message.make({ id: message.id, role: message.role, content, metadata: message.metadata, native: message.native }))
  }
  return result
})
