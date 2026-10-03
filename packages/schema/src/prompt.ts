import { Effect, Schema } from "effect"
import { Model } from "./model"
import { NonNegativeInt, optional } from "./schema"
import { statics } from "./schema"

export interface OutputFormatText extends Schema.Schema.Type<typeof OutputFormatText> {}
export const OutputFormatText = Schema.Struct({
  type: Schema.Literal("text"),
}).annotate({ identifier: "Prompt.OutputFormatText" })

export interface OutputFormatJsonSchema extends Schema.Schema.Type<typeof OutputFormatJsonSchema> {}
export const OutputFormatJsonSchema = Schema.Struct({
  type: Schema.Literal("json_schema"),
  // This is a durable/browser-safe contract. Runtime schema compilation and
  // semantic validation remain Core responsibilities.
  schema: Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "Prompt.JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
}).annotate({ identifier: "Prompt.OutputFormatJsonSchema" })

export const OutputFormat = Schema.Union([OutputFormatText, OutputFormatJsonSchema])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Prompt.OutputFormat" })
export type OutputFormat = Schema.Schema.Type<typeof OutputFormat>

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}).annotate({ identifier: "Prompt.Source" })

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "Prompt.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) =>
        schema.make({
          uri: input.uri,
          mime: input.mime,
          name: input.name,
          description: input.description,
          source: input.source,
        }),
    })),
  )

export interface AgentAttachment extends Schema.Schema.Type<typeof AgentAttachment> {}
export const AgentAttachment = Schema.Struct({
  name: Schema.String,
  source: Source.pipe(optional),
}).annotate({ identifier: "Prompt.AgentAttachment" })

/**
 * A caller-supplied system instruction that is authoritative only for the
 * admitted user turn. `source` and `scope` are explicit so durable replay does
 * not have to infer whether this text belongs to project configuration, an
 * agent definition, or the current request.
 */
export interface RequestSystem extends Schema.Schema.Type<typeof RequestSystem> {}
export const RequestSystem = Schema.Struct({
  text: Schema.String,
  source: Schema.Literal("request"),
  scope: Schema.Literal("turn"),
})
  .annotate({ identifier: "Prompt.RequestSystem" })
  .pipe(
    statics((schema) => ({
      create: (text: string) => schema.make({ text, source: "request", scope: "turn" }),
    })),
  )

/**
 * One explicitly scheduled subagent execution admitted with the user turn.
 * Its persistent part identity is also the durable tool-call identity, so a
 * replacement worker can recover the same child action without guessing from
 * prompt text or re-resolving a mutable slash-command definition.
 */
export interface ScheduledTask extends Schema.Schema.Type<typeof ScheduledTask> {}
export const ScheduledTask = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  description: Schema.String,
  agent: Schema.String,
  model: Model.Ref.pipe(optional),
  command: Schema.String.pipe(optional),
}).annotate({ identifier: "Prompt.ScheduledTask" })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  scheduledTasks: Schema.Array(ScheduledTask).pipe(optional),
  system: RequestSystem.pipe(optional),
  route: Schema.Struct({
    agent: Schema.String.pipe(optional),
    model: Model.Ref.pipe(optional),
  }).pipe(optional),
  command: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }).pipe(optional),
  format: OutputFormat.pipe(optional),
})
  .annotate({ identifier: "Prompt" })
  .pipe(
    statics((schema) => ({
      equivalence: Schema.toEquivalence(schema),
      fromUserMessage: (
        input: Pick<Prompt, "text" | "files" | "agents" | "scheduledTasks" | "system" | "route" | "command" | "format">,
      ) =>
        schema.make({
          text: input.text,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.agents === undefined ? {} : { agents: input.agents }),
          ...(input.scheduledTasks === undefined ? {} : { scheduledTasks: input.scheduledTasks }),
          ...(input.system === undefined ? {} : { system: input.system }),
          ...(input.route === undefined ? {} : { route: input.route }),
          ...(input.command === undefined ? {} : { command: input.command }),
          ...(input.format === undefined ? {} : { format: input.format }),
        }),
    })),
  )
