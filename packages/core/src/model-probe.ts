import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Probe } from "@arforge-ai/llm"
import type {
  Adapter as ProbeAdapter,
  Observation as ProbeObservation,
  ProbeCase,
  Report as ProbeReport,
} from "@arforge-ai/llm/probe"
import { Billing } from "@arforge-ai/schema/billing"
import { Model } from "@arforge-ai/schema/model"
import { Provider } from "@arforge-ai/schema/provider"
import { NonNegativeInt } from "./schema"

export const Source = Schema.Literals(["recorded", "local", "live"])
export type Source = typeof Source.Type

export const PolicyFailureCode = Schema.Literals([
  "live-not-authorized",
  "live-budget-missing",
  "live-budget-currency-missing",
  "provider-not-allowlisted",
  "model-not-allowlisted",
])
export type PolicyFailureCode = typeof PolicyFailureCode.Type

/** Runtime policy for model capability probes. Live access is deny-by-default. */
export class Policy extends Schema.Class<Policy>("ModelProbe.Policy")({
  source: Source,
  liveAuthorized: Schema.Boolean,
  providerAllowlist: Schema.Array(Schema.String),
  modelAllowlist: Schema.Array(Schema.String),
  budgetCents: Schema.optional(NonNegativeInt),
  /** Currency-aware minor-unit budget for new live callers; budgetCents remains compatible. */
  budgetCurrency: Schema.optional(Billing.Currency),
  budgetMinor: Schema.optional(NonNegativeInt),
}) {
  static offline(source: "recorded" | "local") {
    return new Policy({
      source,
      liveAuthorized: false,
      providerAllowlist: [],
      modelAllowlist: [],
    })
  }
}

export class PolicyDeniedError extends Schema.TaggedErrorClass<PolicyDeniedError>()("ModelProbe.PolicyDenied", {
  code: PolicyFailureCode,
  providerID: Schema.String,
  modelID: Schema.String,
}) {
  override get message() {
    return `Model capability probe denied: ${this.code}`
  }
}

export interface Input<R = never> {
  readonly providerID: Provider.ID | string
  readonly modelID: Model.ID | string
  readonly adapter: ProbeAdapter<R>
  readonly policy: Policy
  readonly cases?: ReadonlyArray<ProbeCase>
}

export interface Result {
  readonly providerID: Provider.ID
  readonly modelID: Model.ID
  readonly source: Source
  readonly report: ProbeReport
  readonly observations: ReadonlyArray<Model.Observation>
}

export interface ServiceShape {
  readonly run: <R>(input: Input<R>) => Effect.Effect<Result, PolicyDeniedError, R>
}

export class Service extends Context.Service<Service, ServiceShape>()("@arforge/v2/ModelProbe") {}

const identity = <R>(input: Input<R>) => ({
  providerID: Provider.ID.make(input.providerID),
  modelID: Model.ID.make(input.modelID),
})

const denied = <R>(input: Input<R>, code: PolicyFailureCode) => {
  const ids = identity(input)
  return new PolicyDeniedError({ ...ids, code })
}

const authorize = <R>(input: Input<R>) => {
  const { policy } = input
  if (policy.source === "live" && !policy.liveAuthorized) return Effect.fail(denied(input, "live-not-authorized"))
  if (policy.source === "live") {
    const budget = policy.budgetMinor ?? policy.budgetCents
    if (budget === undefined || budget <= 0) return Effect.fail(denied(input, "live-budget-missing"))
    if (
      (policy.budgetMinor !== undefined && policy.budgetCurrency === undefined) ||
      (policy.budgetCurrency !== undefined && policy.budgetMinor === undefined)
    )
      return Effect.fail(denied(input, "live-budget-currency-missing"))
  }

  const ids = identity(input)
  if (policy.providerAllowlist.length > 0 && !policy.providerAllowlist.includes(ids.providerID))
    return Effect.fail(denied(input, "provider-not-allowlisted"))
  if (policy.modelAllowlist.length > 0 && !policy.modelAllowlist.includes(ids.modelID))
    return Effect.fail(denied(input, "model-not-allowlisted"))
  return Effect.succeed(ids)
}

const observationValue = (observation: ProbeObservation) => ({
  capability: observation.probeCase.capability,
  outcome: observation.outcome,
  ...(observation.latencyMs === undefined ? {} : { latencyMs: observation.latencyMs }),
  ...(observation.failure === undefined
    ? {}
    : {
        failure: {
          code: observation.failure.code,
          retryable: observation.failure.retryable,
          ...(observation.failure.status === undefined ? {} : { status: observation.failure.status }),
        },
      }),
})

const toModelObservation = (input: {
  readonly source: Source
  readonly providerID: Provider.ID
  readonly modelID: Model.ID
  readonly adapterID: string
  readonly observedAt: DateTime.Utc
  readonly observation: ProbeObservation
}) => {
  const status =
    input.observation.outcome === "supported"
      ? "pass"
      : input.observation.outcome === "unsupported"
        ? "fail"
        : "inconclusive"
  return Model.Observation.make({
    kind: "capability",
    status,
    source: input.source,
    sourceID: `${input.adapterID}/${input.providerID}/${input.modelID}/${input.observation.probeCase.id}`,
    observedAt: input.observedAt,
    value: observationValue(input.observation),
  })
}

const runWithPolicy = <R>(input: Input<R>): Effect.Effect<Result, PolicyDeniedError, R> =>
  Effect.gen(function* () {
    const ids = yield* authorize(input)
    const report = yield* Probe.run(input.adapter, input.cases)
    const observedAt = yield* DateTime.now
    const observations = report.observations.map((observation) =>
      toModelObservation({
        source: input.policy.source,
        providerID: ids.providerID,
        modelID: ids.modelID,
        adapterID: report.adapter,
        observedAt,
        observation,
      }),
    )
    return {
      ...ids,
      source: input.policy.source,
      report,
      observations,
    }
  })

export const run = <R>(input: Input<R>) => runWithPolicy(input)

export const layer = (options: { readonly run?: ServiceShape["run"] } = {}) =>
  Layer.succeed(Service, Service.of({ run: options.run ?? run }))

export const ModelProbe = {
  Service,
  Policy,
  PolicyDeniedError,
  PolicyFailureCode,
  Source,
  layer,
  run,
} as const
