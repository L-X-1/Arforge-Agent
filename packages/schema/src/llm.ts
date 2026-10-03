export * as LLM from "./llm"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"

export const ProviderMetadata = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)).annotate({
  identifier: "LLM.ProviderMetadata",
})
export type ProviderMetadata = Schema.Schema.Type<typeof ProviderMetadata>

export interface ToolTextContent extends Schema.Schema.Type<typeof ToolTextContent> {}
export const ToolTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface ToolFileContent extends Schema.Schema.Type<typeof ToolFileContent> {}
export const ToolFileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const ToolContent = Schema.Union([ToolTextContent, ToolFileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "LLM.ToolContent" })
export type ToolContent = Schema.Schema.Type<typeof ToolContent>

/**
 * Provider-neutral exchange contract used by Core runtime and durable
 * boundaries. Provider-specific request bodies and raw response payloads do
 * not belong here.
 */
export namespace Unified {
  export const Version = Schema.Literal("v1")
  export type Version = typeof Version.Type

  export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).annotate({
    identifier: "LLM.Unified.Digest",
  })
  export type Digest = typeof Digest.Type

  export const FinishReason = Schema.Literals(["stop", "length", "tool-calls", "content-filter", "error", "unknown"])
  export type FinishReason = typeof FinishReason.Type

  export const ErrorCategory = Schema.Literals([
    "authentication",
    "content-policy",
    "invalid-output",
    "invalid-request",
    "provider-internal",
    "quota",
    "rate-limit",
    "timeout",
    "transport",
    "unknown",
  ])
  export type ErrorCategory = typeof ErrorCategory.Type

  export const RequestBudget = Schema.Struct({
    maxInputTokens: optional(NonNegativeInt),
    maxOutputTokens: optional(NonNegativeInt),
    maxCostCents: optional(NonNegativeInt),
  }).annotate({ identifier: "LLM.Unified.RequestBudget" })
  export interface RequestBudget extends Schema.Schema.Type<typeof RequestBudget> {}

  export const Request = Schema.Struct({
    version: Version,
    providerID: Schema.NonEmptyString,
    modelID: Schema.NonEmptyString,
    messagesDigest: Digest,
    contextPackageDigest: Digest,
    toolSchemaDigest: Digest,
    modelProfileRevision: Schema.NonEmptyString,
    budget: RequestBudget,
    deadlineAt: optional(DateTimeUtcFromMillis),
  }).annotate({ identifier: "LLM.Unified.Request" })
  export interface Request extends Schema.Schema.Type<typeof Request> {}

  export const StreamFragmentKind = Schema.Literals(["text", "reasoning", "tool-input"])
  export type StreamFragmentKind = typeof StreamFragmentKind.Type

  export const StreamFragment = Schema.Struct({
    sequence: NonNegativeInt,
    kind: StreamFragmentKind,
    id: Schema.NonEmptyString,
    text: Schema.String,
  }).annotate({ identifier: "LLM.Unified.StreamFragment" })
  export interface StreamFragment extends Schema.Schema.Type<typeof StreamFragment> {}

  export const Usage = Schema.Struct({
    inputTokens: optional(NonNegativeInt),
    outputTokens: optional(NonNegativeInt),
    nonCachedInputTokens: optional(NonNegativeInt),
    cacheReadInputTokens: optional(NonNegativeInt),
    cacheWriteInputTokens: optional(NonNegativeInt),
    reasoningTokens: optional(NonNegativeInt),
    totalTokens: optional(NonNegativeInt),
  }).annotate({ identifier: "LLM.Unified.Usage" })
  export interface Usage extends Schema.Schema.Type<typeof Usage> {}

  export const ToolCall = Schema.Struct({
    id: Schema.NonEmptyString,
    name: Schema.NonEmptyString,
    input: Schema.Json,
    providerExecuted: optional(Schema.Boolean),
  }).annotate({ identifier: "LLM.Unified.ToolCall" })
  export interface ToolCall extends Schema.Schema.Type<typeof ToolCall> {}

  export const RetryEvidence = Schema.Struct({
    attempts: NonNegativeInt,
    retried: Schema.Boolean,
    fallbacks: Schema.Array(
      Schema.Struct({
        fromRoute: Schema.NonEmptyString,
        toRoute: Schema.NonEmptyString,
        reason: ErrorCategory,
      }),
    ),
  }).annotate({ identifier: "LLM.Unified.RetryEvidence" })
  export interface RetryEvidence extends Schema.Schema.Type<typeof RetryEvidence> {}

  export const RedactedError = Schema.Struct({
    category: ErrorCategory,
    retryable: Schema.Boolean,
    status: optional(Schema.Int),
  }).annotate({ identifier: "LLM.Unified.RedactedError" })
  export interface RedactedError extends Schema.Schema.Type<typeof RedactedError> {}

  export const Response = Schema.Struct({
    version: Version,
    streamFragments: Schema.Array(StreamFragment),
    finishReason: FinishReason,
    usage: optional(Usage),
    toolCalls: Schema.Array(ToolCall),
    providerRequestID: optional(Schema.NonEmptyString),
    retry: RetryEvidence,
    error: optional(RedactedError),
  }).annotate({ identifier: "LLM.Unified.Response" })
  export interface Response extends Schema.Schema.Type<typeof Response> {}

  export const Exchange = Schema.Struct({
    request: Request,
    response: Response,
  }).annotate({ identifier: "LLM.Unified.Exchange" })
  export interface Exchange extends Schema.Schema.Type<typeof Exchange> {}
}
