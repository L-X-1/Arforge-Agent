import { Effect, Schema } from "effect"
import { LLMError, type LLMResponse, LLMEvent } from "./schema"

/** Stable, non-sensitive prompt used by every capability probe. */
export const FIXED_PROMPT = "ARFORGE_CAPABILITY_PROBE_V1: Reply with exactly OK."

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const VERSION = "v1" as const

export const Capability = Schema.Literals(["text-generation", "streaming", "tool-calling", "structured-output"])
export type Capability = typeof Capability.Type

export const Outcome = Schema.Literals(["supported", "unsupported", "failed"])
export type Outcome = typeof Outcome.Type

export const FailureCode = Schema.Literals([
  "adapter",
  "authentication",
  "content-policy",
  "invalid-output",
  "invalid-request",
  "provider-internal",
  "quota",
  "rate-limit",
  "transport",
  "unknown",
])
export type FailureCode = typeof FailureCode.Type

export class ProbeCase extends Schema.Class<ProbeCase>("LLM.Probe.Case")({
  id: Schema.String,
  capability: Capability,
  prompt: Schema.Literal(FIXED_PROMPT),
}) {
  static fixed(capability: Capability, id = capability) {
    return new ProbeCase({ id, capability, prompt: FIXED_PROMPT })
  }
}

export class AdapterResult extends Schema.Class<AdapterResult>("LLM.Probe.AdapterResult")({
  outcome: Schema.Literals(["supported", "unsupported"]),
  latencyMs: Schema.optional(NonNegativeInt),
}) {}

/**
 * Expected probe failure. It intentionally contains classification metadata
 * only; provider messages, prompts, and model output never cross this boundary.
 */
export class ProbeFailure extends Schema.TaggedErrorClass<ProbeFailure>()("LLM.Probe.Failure", {
  capability: Capability,
  code: FailureCode,
  status: Schema.optional(Schema.Int),
  retryable: Schema.Boolean,
}) {
  override get message() {
    return `Capability probe failed: ${this.capability}/${this.code}`
  }
}

export class Observation extends Schema.Class<Observation>("LLM.Probe.Observation")({
  probeCase: ProbeCase,
  outcome: Outcome,
  latencyMs: Schema.optional(NonNegativeInt),
  failure: Schema.optional(ProbeFailure),
}) {}

export class Report extends Schema.Class<Report>("LLM.Probe.Report")({
  version: Schema.Literal(VERSION),
  adapter: Schema.String,
  observations: Schema.Array(Observation),
}) {}

/**
 * Pure adapter contract. A provider integration owns model selection, auth,
 * request construction, and response validation. This package only owns the
 * fixed probe cases and the redacted report shape.
 */
export interface Adapter<R = never> {
  readonly id: string
  readonly execute: (input: ProbeCase) => Effect.Effect<AdapterResult, ProbeFailure, R>
}

export const cases: ReadonlyArray<ProbeCase> = [
  ProbeCase.fixed("text-generation"),
  ProbeCase.fixed("streaming"),
  ProbeCase.fixed("tool-calling"),
  ProbeCase.fixed("structured-output"),
]

const failureCode = (reason: LLMError["reason"]): FailureCode => {
  switch (reason._tag) {
    case "Authentication":
      return "authentication"
    case "ContentPolicy":
      return "content-policy"
    case "InvalidProviderOutput":
      return "invalid-output"
    case "InvalidRequest":
    case "NoRoute":
      return "invalid-request"
    case "ProviderInternal":
      return "provider-internal"
    case "QuotaExceeded":
      return "quota"
    case "RateLimit":
      return "rate-limit"
    case "Transport":
      return "transport"
    case "UnknownProvider":
      return "unknown"
  }
}

const failureStatus = (reason: LLMError["reason"]) => ("http" in reason ? reason.http?.response?.status : undefined)

/** Convert an LLM error into safe probe metadata without copying its message. */
export const fromLLMError = (capability: Capability, error: LLMError) =>
  new ProbeFailure({
    capability,
    code: failureCode(error.reason),
    status: failureStatus(error.reason),
    retryable: error.retryable,
  })

const contractFailure = (input: ProbeCase) =>
  new ProbeFailure({ capability: input.capability, code: "adapter", retryable: false })

const runCase = <R>(adapter: Adapter<R>, input: ProbeCase) =>
  Effect.gen(function* () {
    if (input.prompt !== FIXED_PROMPT) return yield* contractFailure(input)
    const result = yield* adapter
      .execute(input)
      .pipe(
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(AdapterResult)(value).pipe(Effect.mapError(() => contractFailure(input))),
        ),
      )
    return new Observation({
      probeCase: input,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
    })
  }).pipe(
    Effect.catchTag("LLM.Probe.Failure", (failure) =>
      Effect.succeed(
        new Observation({
          probeCase: input,
          outcome: "failed",
          failure,
        }),
      ),
    ),
  )

/** Run fixed cases sequentially and collect expected failures as observations. */
export const run = <R>(adapter: Adapter<R>, selectedCases: ReadonlyArray<ProbeCase> = cases) =>
  Effect.forEach(selectedCases, (input) => runCase(adapter, input)).pipe(
    Effect.map((observations) => new Report({ version: VERSION, adapter: adapter.id, observations })),
  )

/**
 * Small response predicates for adapters. They inspect a response in memory
 * and return only a boolean, so raw provider output is not persisted by Probe.
 */
export const responseSupports = {
  text: (response: LLMResponse) => response.text.trim() === "OK",
  streaming: (response: LLMResponse) => response.events.some(LLMEvent.is.textDelta),
  toolCalling: (response: LLMResponse) => response.events.some(LLMEvent.is.toolCall),
} as const

export const Probe = {
  AdapterResult,
  Capability,
  FailureCode,
  FIXED_PROMPT,
  Observation,
  Outcome,
  ProbeCase,
  ProbeFailure,
  Report,
  VERSION,
  cases,
  fromLLMError,
  responseSupports,
  run,
} as const
