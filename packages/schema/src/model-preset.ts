export * as ModelPreset from "./model-preset"

import { Schema } from "effect"
import { Model } from "./model"
import { optional } from "./schema"

// Re-export the exact shared identity to avoid a Model <-> ModelPreset cycle.
export { PresetOrigin as Origin, PresetReference as Reference } from "./model"

const ID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const PositiveSafeInt = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export interface Limits extends Schema.Schema.Type<typeof Limits> {}
export const Limits = Schema.Struct({
  context: PositiveSafeInt.pipe(optional),
  input: PositiveSafeInt.pipe(optional),
  output: PositiveSafeInt.pipe(optional),
}).annotate({ identifier: "ModelPreset.Limits" })

export const ReasoningOption = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("effort"),
    values: Schema.Array(Schema.NullOr(ID)).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: PositiveSafeInt.pipe(optional),
    max: PositiveSafeInt.pipe(optional),
  }),
]).annotate({ identifier: "ModelPreset.ReasoningOption" })
export type ReasoningOption = typeof ReasoningOption.Type

export interface Provenance extends Schema.Schema.Type<typeof Provenance> {}
export const Provenance = Schema.Struct({
  source: Schema.Literals(["bundled", "official"]),
  sourceID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  verifiedAt: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)).pipe(
    optional,
  ),
}).annotate({ identifier: "ModelPreset.Provenance" })

export interface Preset extends Schema.Schema.Type<typeof Preset> {}
export const Preset = Schema.Struct({
  origin: Model.PresetOrigin,
  name: ID,
  family: ID.pipe(optional),
  aliases: Schema.Array(ID).check(Schema.isMaxLength(32)),
  limit: Limits.pipe(optional),
  capabilities: Model.Capabilities.pipe(optional),
  reasoning: Schema.Array(ReasoningOption).check(Schema.isMaxLength(16)).pipe(optional),
  status: Model.Info.fields.status,
  provenance: Schema.Array(Provenance).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
}).annotate({ identifier: "ModelPreset.Preset" })

export interface Catalog extends Schema.Schema.Type<typeof Catalog> {}
export const Vendor = Schema.Struct({ id: ID, name: ID }).annotate({ identifier: "ModelPreset.Vendor" })
export interface Vendor extends Schema.Schema.Type<typeof Vendor> {}
export const Catalog = Schema.Struct({
  revision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  vendors: Schema.Array(Vendor).check(Schema.isMaxLength(500)),
  items: Schema.Array(Preset).check(Schema.isMaxLength(500)),
}).annotate({ identifier: "ModelPreset.Catalog" })

/** Canonical non-secret save DTO. Presets themselves never carry request bodies. */
export const ConfigurationInput = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(Schema.isMinLength(1)),
  disabled: Schema.Boolean.pipe(optional),
  limit: Limits.pipe(optional),
  capabilities: Model.Capabilities.pipe(optional),
  preset: Model.PresetReference.pipe(optional),
  variants: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
      body: Schema.Record(Schema.String, Schema.Json).pipe(optional),
    }),
  )
    .check(Schema.isMaxLength(64))
    .pipe(optional),
  defaultVariant: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))).pipe(optional),
}).annotate({ identifier: "ProviderConfiguration.ModelInput" })
export interface ConfigurationInput extends Schema.Schema.Type<typeof ConfigurationInput> {}
