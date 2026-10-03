import { Schema } from "effect"
import { JsonSchema, ModelID, ProviderID } from "./ids"
import type { AnyRoute } from "../route/client"
import { isRecord } from "../utils/record"

export const mergeJsonRecords = (
  ...items: ReadonlyArray<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined => {
  const defined = items.filter((item): item is Record<string, unknown> => item !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1 && Object.values(defined[0]).every((value) => value !== undefined)) return defined[0]
  const result: Record<string, unknown> = {}
  for (const item of defined) {
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue
      result[key] = isRecord(result[key]) && isRecord(value) ? mergeJsonRecords(result[key], value) : value
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

const mergeStringRecords = (
  ...items: ReadonlyArray<Record<string, string> | undefined>
): Record<string, string> | undefined => {
  const defined = items.filter((item): item is Record<string, string> => item !== undefined)
  if (defined.length === 0) return undefined
  if (defined.length === 1) return defined[0]
  const result = Object.fromEntries(
    defined.flatMap((item) =>
      Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

export const ProviderOptions = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))
export type ProviderOptions = Schema.Schema.Type<typeof ProviderOptions>

export const mergeProviderOptions = (
  ...items: ReadonlyArray<ProviderOptions | undefined>
): ProviderOptions | undefined => {
  const result: Record<string, Record<string, unknown>> = {}
  for (const item of items) {
    if (!item) continue
    for (const [provider, options] of Object.entries(item)) {
      const merged = mergeJsonRecords(result[provider], options)
      if (merged) result[provider] = merged
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

export class HttpOptions extends Schema.Class<HttpOptions>("LLM.HttpOptions")({
  body: Schema.optional(JsonSchema),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export namespace HttpOptions {
  export type Input = HttpOptions | ConstructorParameters<typeof HttpOptions>[0]

  /** Normalize HTTP option input into the canonical `HttpOptions` class. */
  export const make = (input: Input) => (input instanceof HttpOptions ? input : new HttpOptions(input))
}

export const mergeHttpOptions = (...items: ReadonlyArray<HttpOptions | undefined>): HttpOptions | undefined => {
  const body = mergeJsonRecords(...items.map((item) => item?.body))
  const headers = mergeStringRecords(...items.map((item) => item?.headers))
  const query = mergeStringRecords(...items.map((item) => item?.query))
  if (!body && !headers && !query) return undefined
  return new HttpOptions({ body, headers, query })
}

export class GenerationOptions extends Schema.Class<GenerationOptions>("LLM.GenerationOptions")({
  maxTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  frequencyPenalty: Schema.optional(Schema.Number),
  presencePenalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
}) {}

export namespace GenerationOptions {
  export type Input = GenerationOptions | ConstructorParameters<typeof GenerationOptions>[0]

  /** Normalize generation option input into the canonical `GenerationOptions` class. */
  export const make = (input: Input = {}) => (input instanceof GenerationOptions ? input : new GenerationOptions(input))
}

export type GenerationOptionsFields = {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly seed?: number
  readonly stop?: ReadonlyArray<string>
}

export type GenerationOptionsInput = GenerationOptions | GenerationOptionsFields

const latestGeneration = <Key extends keyof GenerationOptionsFields>(
  items: ReadonlyArray<GenerationOptionsInput | undefined>,
  key: Key,
) => items.findLast((item) => item?.[key] !== undefined)?.[key]

export const mergeGenerationOptions = (...items: ReadonlyArray<GenerationOptionsInput | undefined>) => {
  const result = new GenerationOptions({
    maxTokens: latestGeneration(items, "maxTokens"),
    temperature: latestGeneration(items, "temperature"),
    topP: latestGeneration(items, "topP"),
    topK: latestGeneration(items, "topK"),
    frequencyPenalty: latestGeneration(items, "frequencyPenalty"),
    presencePenalty: latestGeneration(items, "presencePenalty"),
    seed: latestGeneration(items, "seed"),
    stop: latestGeneration(items, "stop"),
  })
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

export class ModelLimits extends Schema.Class<ModelLimits>("LLM.ModelLimits")({
  context: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
}) {}

export namespace ModelLimits {
  export type Input = ModelLimits | ConstructorParameters<typeof ModelLimits>[0]

  /** Normalize model limit input into the canonical `ModelLimits` class. */
  export const make = (input: Input | undefined) =>
    input instanceof ModelLimits ? input : new ModelLimits(input ?? {})
}

export class ModelDefaults extends Schema.Class<ModelDefaults>("LLM.ModelDefaults")({
  limits: Schema.optional(ModelLimits),
  generation: Schema.optional(GenerationOptions),
  providerOptions: Schema.optional(ProviderOptions),
  http: Schema.optional(HttpOptions),
}) {}

export namespace ModelDefaults {
  export type Input =
    | ModelDefaults
    | {
        readonly limits?: ModelLimits.Input
        readonly generation?: GenerationOptions.Input
        readonly providerOptions?: ProviderOptions
        readonly http?: HttpOptions.Input
      }

  /** Normalize selected-model request defaults without applying precedence. */
  export const make = (input: Input) => {
    if (input instanceof ModelDefaults) return input
    return new ModelDefaults({
      limits: input.limits === undefined ? undefined : ModelLimits.make(input.limits),
      generation: input.generation === undefined ? undefined : GenerationOptions.make(input.generation),
      providerOptions: input.providerOptions,
      http: input.http === undefined ? undefined : HttpOptions.make(input.http),
    })
  }
}

export const ModelToolSchemaCompatibility = Schema.Literals(["gemini", "moonshot"])
export type ModelToolSchemaCompatibility = Schema.Schema.Type<typeof ModelToolSchemaCompatibility>

export class ModelCompatibility extends Schema.Class<ModelCompatibility>("LLM.ModelCompatibility")({
  toolSchema: Schema.optional(ModelToolSchemaCompatibility),
}) {}

export namespace ModelCompatibility {
  export type Input = ModelCompatibility | ConstructorParameters<typeof ModelCompatibility>[0]

  /** Normalize model/upstream compatibility metadata without projecting requests. */
  export const make = (input: Input) => (input instanceof ModelCompatibility ? input : new ModelCompatibility(input))
}

/**
 * Provider-owned token accounting is runtime-only metadata. It is deliberately
 * kept outside the serializable model schema and request payloads. The Context
 * Surface/checkpoint owner records the revision and digest, never the
 * executable counter.
 */
export type ModelTokenizerKind = "provider" | "upper-bound"

export type ModelTokenizer = Readonly<{
  readonly revision: string
  /** Defaults to an exact provider tokenizer for backwards compatibility. */
  readonly kind?: ModelTokenizerKind
  readonly count: (input: string) => number
}>

export type UpperBoundTokenizerInput = Readonly<{
  /** Stable catalog revision included in Context Surface/checkpoint evidence. */
  readonly revision: string
  /** Maximum tokens per UTF-16 code unit; must be a finite positive number. */
  readonly maxTokensPerCharacter: number
  /** Fixed protocol/model overhead conservatively charged to every input. */
  readonly overheadTokens?: number
}>

const tokenizerRevision = (revision: string): string => {
  const normalized = revision.trim()
  if (!normalized) throw new Error("Tokenizer revision is required")
  return normalized
}

/**
 * Build a deterministic conservative tokenizer for providers without a local
 * tokenizer implementation. The caller supplies a measured upper bound; the
 * result is explicitly classified as `upper-bound` so diagnostics never call
 * it an exact provider count.
 */
export const makeUpperBoundTokenizer = (input: UpperBoundTokenizerInput): ModelTokenizer => {
  const revision = tokenizerRevision(input.revision)
  const maxTokensPerCharacter = input.maxTokensPerCharacter
  if (!Number.isFinite(maxTokensPerCharacter) || maxTokensPerCharacter <= 0)
    throw new Error("maxTokensPerCharacter must be a finite positive number")
  const overheadTokens = input.overheadTokens ?? 0
  if (!Number.isFinite(overheadTokens) || overheadTokens < 0 || !Number.isInteger(overheadTokens))
    throw new Error("overheadTokens must be a non-negative integer")
  return Object.freeze({
    revision,
    kind: "upper-bound" as const,
    count: (text: string) => {
      const value = Math.ceil(text.length * maxTokensPerCharacter + overheadTokens)
      if (!Number.isSafeInteger(value)) throw new Error("upper-bound tokenizer result exceeds safe integer range")
      return value
    },
  })
}

export type TokenizerRegistration = Readonly<{
  readonly provider: string | ProviderID
  /** Omit model to register a provider-wide fallback. */
  readonly model?: string | ModelID
  readonly tokenizer: ModelTokenizer
  readonly source?: string
}>

export type TokenizerResolution = Readonly<{
  readonly provider: string
  readonly model: string
  readonly match: "model" | "provider"
  readonly source?: string
  readonly tokenizer: ModelTokenizer
}>

const registrationKey = (provider: string, model?: string): string => `${provider}\u0000${model ?? "*"}`

/**
 * Immutable provider/model tokenizer catalog. Exact model registrations win
 * over provider-wide fallbacks; duplicate keys fail closed instead of making
 * request reconstruction depend on registration order.
 */
export class TokenizerRegistry {
  readonly entries: ReadonlyArray<TokenizerRegistration>

  constructor(entries: ReadonlyArray<TokenizerRegistration> = []) {
    const normalized = entries.map((entry) => {
      const provider = String(entry.provider).trim()
      const model = entry.model === undefined ? undefined : String(entry.model).trim()
      if (!provider) throw new Error("Tokenizer registration provider is required")
      if (model !== undefined && !model) throw new Error("Tokenizer registration model must not be empty")
      if (!entry.tokenizer.revision.trim()) throw new Error("Tokenizer registration revision is required")
      if (
        entry.tokenizer.kind !== undefined &&
        entry.tokenizer.kind !== "provider" &&
        entry.tokenizer.kind !== "upper-bound"
      )
        throw new Error("Tokenizer registration kind is invalid")
      return Object.freeze({
        ...entry,
        provider: ProviderID.make(provider),
        ...(model === undefined ? {} : { model: ModelID.make(model) }),
        source: entry.source?.trim() || undefined,
      })
    })
    const keys = new Set<string>()
    for (const entry of normalized) {
      const key = registrationKey(String(entry.provider), entry.model === undefined ? undefined : String(entry.model))
      if (keys.has(key)) throw new Error(`Duplicate tokenizer registration: ${key.replace("\u0000", "/")}`)
      keys.add(key)
    }
    this.entries = Object.freeze(
      normalized.toSorted((left, right) => {
        const leftModel = left.model === undefined ? 1 : 0
        const rightModel = right.model === undefined ? 1 : 0
        return leftModel - rightModel
      }),
    )
  }

  register(entry: TokenizerRegistration): TokenizerRegistry {
    return new TokenizerRegistry([...this.entries, entry])
  }

  resolve(input: {
    readonly provider: string | ProviderID
    readonly model: string | ModelID
  }): TokenizerResolution | undefined {
    const provider = String(input.provider).trim()
    const model = String(input.model).trim()
    if (!provider || !model) return undefined
    const entry = this.entries.find(
      (candidate) =>
        String(candidate.provider) === provider && (candidate.model === undefined || String(candidate.model) === model),
    )
    if (!entry) return undefined
    return Object.freeze({
      provider,
      model,
      match: entry.model === undefined ? ("provider" as const) : ("model" as const),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      tokenizer: entry.tokenizer,
    })
  }
}

export class Model {
  readonly id: ModelID
  readonly provider: ProviderID
  readonly route: AnyRoute
  readonly defaults?: ModelDefaults
  readonly compatibility?: ModelCompatibility
  readonly tokenizer?: ModelTokenizer

  constructor(input: Model.ConstructorInput) {
    this.id = input.id
    this.provider = input.provider
    this.route = input.route
    this.defaults = input.defaults
    this.compatibility = input.compatibility
    this.tokenizer = input.tokenizer
  }

  static make(input: Model.Input) {
    return new Model({
      id: ModelID.make(input.id),
      provider: ProviderID.make(input.provider),
      route: input.route,
      defaults: input.defaults === undefined ? undefined : ModelDefaults.make(input.defaults),
      compatibility: input.compatibility === undefined ? undefined : ModelCompatibility.make(input.compatibility),
      tokenizer: input.tokenizer,
    })
  }

  static input(model: Model): Model.ConstructorInput {
    return {
      id: model.id,
      provider: model.provider,
      route: model.route,
      defaults: model.defaults,
      compatibility: model.compatibility,
      tokenizer: model.tokenizer,
    }
  }

  static update(model: Model, patch: Partial<Model.Input>) {
    if (Object.keys(patch).length === 0) return model
    return Model.make({
      ...Model.input(model),
      ...patch,
    })
  }
}

export namespace Model {
  export type ConstructorInput = {
    readonly id: ModelID
    readonly provider: ProviderID
    readonly route: AnyRoute
    readonly defaults?: ModelDefaults
    readonly compatibility?: ModelCompatibility
    readonly tokenizer?: ModelTokenizer
  }

  export type Input = Omit<ConstructorInput, "id" | "provider" | "defaults" | "compatibility"> & {
    readonly id: string | ModelID
    readonly provider: string | ProviderID
    readonly defaults?: ModelDefaults.Input
    readonly compatibility?: ModelCompatibility.Input
    readonly tokenizer?: ModelTokenizer
  }
}

export type ModelInput = Model.Input

export const ModelSchema = Schema.declare((value): value is Model => value instanceof Model, { expected: "LLM.Model" })

export class CacheHint extends Schema.Class<CacheHint>("LLM.CacheHint")({
  type: Schema.Literals(["ephemeral", "persistent"]),
  ttlSeconds: Schema.optional(Schema.Number),
}) {}

// Auto-placement policy for prompt caching. The protocol-neutral lowering step
// reads this and injects `CacheHint`s at the configured boundaries; the
// per-protocol body builders then translate those hints into wire markers as
// usual. `"auto"` is the recommended default for agent loops — it places one
// breakpoint at the last tool definition, one at the last system part, and one
// at the latest user message. The combination of provider invalidation
// hierarchy (tools → system → messages) and Anthropic/Bedrock's 20-block
// lookback means three trailing breakpoints reliably cover the static prefix.
//
// Pass `"none"` to opt out entirely (the legacy behavior). Pass the granular
// object form to override individual choices.
export const CachePolicyObject = Schema.Struct({
  tools: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  messages: Schema.optional(
    Schema.Union([
      Schema.Literal("latest-user-message"),
      Schema.Literal("latest-assistant"),
      Schema.Struct({ tail: Schema.Number }),
    ]),
  ),
  ttlSeconds: Schema.optional(Schema.Number),
})
export type CachePolicyObject = Schema.Schema.Type<typeof CachePolicyObject>

export const CachePolicy = Schema.Union([Schema.Literal("auto"), Schema.Literal("none"), CachePolicyObject])
export type CachePolicy = Schema.Schema.Type<typeof CachePolicy>
