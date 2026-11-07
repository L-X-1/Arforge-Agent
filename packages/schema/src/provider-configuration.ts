export * as ProviderConfiguration from "./provider-configuration"
import { Schema } from "effect"
import * as ModelPreset from "./model-preset"
export const ApiFormat = Schema.Literals(["openai-chat", "openai-responses", "anthropic-messages"])

export const Detail = Schema.Struct({
  providerID: Schema.String,
  revision: Schema.String,
  name: Schema.String,
  baseURL: Schema.optional(Schema.String),
  apiFormat: Schema.optional(ApiFormat),
  adapter: Schema.Struct({ type: Schema.String, package: Schema.optional(Schema.String) }),
  authentication: Schema.Literals(["optional", "required"]),
  disabled: Schema.Boolean,
  canWrite: Schema.Boolean,
  credential: Schema.Struct({
    configured: Schema.Boolean,
    reconnectRequired: Schema.Boolean,
    source: Schema.Literals(["stored", "environment", "none"]),
  }),
  env: Schema.optional(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      wireID: Schema.String,
      disabled: Schema.Boolean,
      apiFormat: Schema.optional(ApiFormat),
      canTest: Schema.Boolean,
      limit: Schema.optional(ModelPreset.Limits),
      capabilities: ModelPreset.ConfigurationInput.fields.capabilities,
      preset: ModelPreset.ConfigurationInput.fields.preset,
      variants: Schema.Array(Schema.String),
      defaultVariant: Schema.optional(Schema.String),
    }),
  ),
})
export const TestInput = Schema.Struct({ revision: Schema.String, modelID: Schema.String.check(Schema.isMinLength(1)) })
export const TestResult = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  revision: Schema.String,
  outcome: Schema.Literals(["success", "failure"]),
  category: Schema.Literals([
    "ok",
    "unavailable",
    "reconnect-required",
    "authentication",
    "model-not-found",
    "invalid-response",
    "output-limit",
    "timeout",
    "transport",
    "rate-limit",
    "quota",
    "unsupported",
    "unknown",
  ]),
  latencyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  httpStatus: Schema.optional(Schema.Int),
})

export interface Detail extends Schema.Schema.Type<typeof Detail> {}
export interface TestInput extends Schema.Schema.Type<typeof TestInput> {}
export interface TestResult extends Schema.Schema.Type<typeof TestResult> {}
