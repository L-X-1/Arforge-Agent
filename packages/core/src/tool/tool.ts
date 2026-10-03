export * as Tool from "./tool"

import { ToolDefinition, ToolFailure, ToolOutput, type ToolCall } from "@arforge-ai/llm"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { PermissionV2 } from "../permission"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import { canonicalEffectSemantics } from "./effect-semantics"
import { Egress } from "../egress"
import type { ActionGateway } from "../action-gateway"
import {
  resolveToolExecutionMetadata,
  validateToolExecutionMetadata,
  type ResolvedToolExecutionMetadata,
  type ToolExecutionMetadataConfig,
} from "./metadata"
export {
  DEFAULT_TOOL_EXECUTION_METADATA,
  ToolMetadataError,
  type ResourceKeyResolver,
  type ToolConcurrency,
  type ToolExecutionMetadataConfig,
  type ToolIdempotency,
  type ToolOutputPolicy,
  type ResolvedToolExecutionMetadata,
  type ToolSideEffect,
  type ToolTimeoutMode,
} from "./metadata"

/**
 * Dedicated leaf authorization failure. Carries the machine-readable reason
 * plus the requested and granted scopes so the tool result, UI, and audit can
 * distinguish deny, rejection, and scope escalation without exposing the
 * PermissionV2 error union.
 */
export class ToolAuthorizationFailure extends Error {
  override readonly name = "Tool.ToolAuthorizationFailure"

  constructor(
    readonly action: string,
    readonly resources: ReadonlyArray<string>,
    readonly reason: string,
    readonly granted: ReadonlyArray<{ readonly action: string; readonly resources: ReadonlyArray<string> }>,
  ) {
    super(reason)
  }
}

/**
 * Converts a leaf authorization failure into the supported LLM.ToolFailure
 * channel with structured metadata, or undefined when the error is not an
 * authorization failure. Tool mappers must preserve this conversion so the
 * authorization reason and scopes stay visible in the tool result and audit.
 */
export const toToolFailure = (error: unknown): ToolFailure | undefined =>
  error instanceof ToolAuthorizationFailure
    ? new ToolFailure({
        message: error.reason,
        metadata: {
          kind: "authorization",
          action: error.action,
          requested: error.resources,
          granted: error.granted,
        },
      })
    : error instanceof Egress.Violation
      ? new ToolFailure({
          message: error.reason,
          metadata: { kind: "egress", request: error.request },
        })
      : undefined

/**
 * The only permission surface a tool body may hold. Exposes `assert` alone —
 * never ask, reply, get, or list — so a tool can neither open a second
 * interactive authorization nor answer an unrelated pending request. The
 * error is the dedicated ToolAuthorizationFailure with no environment, and
 * `assert` never asks interactively. The extra legacy-shaped input fields
 * are accepted for call-site compatibility and ignored by the adapter.
 */
export interface LeafAuthorizer {
  readonly assert: (input: {
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: Readonly<Record<string, unknown>>
    readonly sessionID?: string
    readonly agent?: string
    readonly source?: unknown
    readonly forceAsk?: boolean
  }) => Effect.Effect<void, ToolAuthorizationFailure>
}

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /**
   * Leaf permission gate bound by ToolRegistry to the gateway-verified
   * authorization capability. Covered same-action leaf requests resolve
   * against the durable grant without a second PermissionV2 call; anything
   * outside the grant fails closed with ToolAuthorizationFailure before the
   * tool body continues. Automatic (L0/L1) execution delegates assert to the
   * configured service through the explicit safe path.
   */
  readonly permission: LeafAuthorizer
  /** Leaf-only HTTP egress guard bound to the same Gateway capability. */
  readonly egress: Egress.Authorizer
  /**
   * Cancellation signal owned by the canonical ToolRegistry execution. It is
   * aborted when the admitted Effect is interrupted; adapters must never
   * replace it with an independently owned lifetime.
   */
  readonly abort?: AbortSignal
  /**
   * Metadata-only progress checkpoint bound to the same ActionGateway
   * aggregate. Tool implementations may report bounded phase/count updates;
   * they cannot change authorization, status, lease, or retry authority.
   */
  readonly reportProgress?: (update: AgentRuntime.ActionProgressUpdate) => Effect.Effect<void, unknown>
  /** Retain a bounded producer snapshot for interruption; managed storage remains owned by the pipeline. */
  readonly retainPartialOutput?: (output: ToolOutput) => Effect.Effect<void>
  /**
   * Narrow child-action carrier bound to the current durable parent action.
   * It exposes ActionGateway.execute plus the content-free mutation-intent
   * recorder. The latter lets a mature file adapter append checkpoints to the
   * already-authorized parent action without receiving reconciliation,
   * settlement, or an unbound gateway.
   */
  readonly childActions?: {
    readonly parentActionID: AgentRuntime.ActionID
    readonly parentRunID?: AgentRuntime.RunID
    readonly authority?: AgentRuntime.Authority
    readonly execute: ActionGateway.Interface["execute"]
    readonly recordMutationIntent?: ActionGateway.Interface["recordMutationIntent"]
  }
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>
export type PostProcessingContext = Pick<Context, "sessionID" | "assistantMessageID" | "toolCallID" | "agent">

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
> = {
  readonly description: string
  /**
   * Model-facing schema override for a runtime schema whose exact JSON Schema
   * originates outside Effect Schema (for example MCP or plugin Zod). Runtime
   * decoding still uses `input`; this field cannot introduce another
   * executable representation.
   */
  readonly inputJsonSchema?: JsonSchema.JsonSchema
  /** Same boundary for the optional model-facing output schema. */
  readonly outputJsonSchema?: JsonSchema.JsonSchema
  readonly effects?: AgentRuntime.EffectSemantics | ((input: Schema.Schema.Type<Input>) => AgentRuntime.EffectSemantics)
  /**
   * Runtime-only execution metadata. It is intentionally not part of the
   * model-facing schema; ToolRegistry resolves it once before ActionGateway
   * receives the durable intent.
   */
  readonly metadata?: ToolExecutionMetadataConfig<Schema.Schema.Type<Input>, Context>
  readonly input: Input
  readonly output: Output
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  /** Presentation-only transformation after the effect's immutable Observation. */
  readonly postprocess?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: ToolOutput
    readonly context: PostProcessingContext
  }) => Effect.Effect<ToolOutput, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly postprocess?: (
    call: ToolCall,
    output: ToolOutput,
    context: PostProcessingContext,
  ) => Effect.Effect<ToolOutput, ToolFailure>
  readonly permission?: string
  readonly effectDeclaration: import("./effect-catalog").ToolEffectDeclaration
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
  readonly effects: (call: ToolCall) => Effect.Effect<AgentRuntime.EffectSemantics, ToolFailure>
  readonly decode: (call: ToolCall) => Effect.Effect<unknown, ToolFailure>
  readonly executionMetadata: ToolExecutionMetadataConfig<unknown, Context>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
>(config: Config<Input, Output, Structured>): Definition<Input, Structured> {
  validateToolExecutionMetadata(config.metadata)
  // External schemas are request identity material. Snapshot them when the
  // sole executable Tool value is created so later plugin/MCP mutation cannot
  // change an already registered model contract.
  const inputJsonSchema = config.inputJsonSchema ? immutableJsonSchema(config.inputJsonSchema) : undefined
  const outputJsonSchema = config.outputJsonSchema ? immutableJsonSchema(config.outputJsonSchema) : undefined
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    ...(config.postprocess
      ? {
          postprocess: (call: ToolCall, output: ToolOutput, context: PostProcessingContext) =>
            Schema.decodeUnknownEffect(config.input)(structuredClone(call.input)).pipe(
              Effect.mapError(
                (error) => new ToolFailure({ message: `Invalid postprocessing input: ${error.message}` }),
              ),
              Effect.flatMap((input) =>
                config.postprocess!({
                  input,
                  output,
                  context: {
                    sessionID: context.sessionID,
                    assistantMessageID: context.assistantMessageID,
                    toolCallID: context.toolCallID,
                    agent: context.agent,
                  },
                }),
              ),
              Effect.flatMap((output) =>
                Schema.decodeUnknownEffect(ToolOutput)(output).pipe(
                  Effect.mapError(
                    () => new ToolFailure({ message: "Tool postprocessing returned an invalid presentation" }),
                  ),
                ),
              ),
            ),
        }
      : {}),
    effectDeclaration:
      config.effects === undefined ? "default_deny" : typeof config.effects === "function" ? "dynamic" : "static",
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: inputJsonSchema ?? toJsonSchema(config.input),
        outputSchema: outputJsonSchema ?? toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.flatMap((output) => {
                  if (!config.structured || !config.toStructuredOutput)
                    return Effect.succeed({ output, structured: output })
                  return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
                    Effect.map((structured) => ({ output, structured })),
                  )
                }),
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.map(({ output, structured }) => ({
              structured,
              content:
                config.toModelOutput?.({ input, output }).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        uri: `data:${part.mime};base64,${part.data}`,
                        mime: part.mime,
                        name: part.name,
                      },
                ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
            })),
          ),
        ),
      ),
    effects: (call) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.map((input) =>
          canonicalEffectSemantics(
            typeof config.effects === "function" ? config.effects(input) : (config.effects ?? undeclaredEffects),
          ),
        ),
      ),
    decode: (call) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
      ),
    executionMetadata: (config.metadata ?? {}) as ToolExecutionMetadataConfig<unknown, Context>,
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const effectDeclaration = (tool: AnyTool) => runtimeOf(tool).effectDeclaration
export const hasPostprocessing = (tool: AnyTool) => runtimeOf(tool).postprocess !== undefined
export const postprocess = (tool: AnyTool, call: ToolCall, output: ToolOutput, context: PostProcessingContext) =>
  runtimeOf(tool).postprocess?.(call, output, context) ?? Effect.succeed(output)
/** Returns the declaration without evaluating a dynamic resource-key resolver. */
export const executionMetadata = (tool: AnyTool) => runtimeOf(tool).executionMetadata
/** Resolve metadata after the input has been decoded and before ActionGateway. */
export const resolveExecutionMetadata = (
  tool: AnyTool,
  input: unknown,
  context: Context,
  semantics?: AgentRuntime.EffectSemantics,
): ResolvedToolExecutionMetadata =>
  resolveToolExecutionMetadata(runtimeOf(tool).executionMetadata, input, context, semantics)
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => runtimeOf(tool).settle(call, context)
export const effects = (tool: AnyTool, call: ToolCall) => runtimeOf(tool).effects(call)
export const decodeInput = (tool: AnyTool, call: ToolCall) => runtimeOf(tool).decode(call)

const undeclaredEffects = AgentRuntime.EffectSemantics.make({
  riskTier: "L3",
  authority: "human",
  idempotency: "non_idempotent",
  retryability: "never",
  reversibility: "irreversible",
  filesystemScope: [],
  networkScope: [],
  secretScope: [],
  externalServices: [],
  expectedArtifacts: [],
  successCriteria: [],
})

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

function immutableJsonSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const clone = structuredClone(schema)
  const freeze = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      for (const item of value) freeze(item)
      return Object.freeze(value)
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item)
      return Object.freeze(value)
    }
    return value
  }
  return freeze(clone) as JsonSchema.JsonSchema
}
