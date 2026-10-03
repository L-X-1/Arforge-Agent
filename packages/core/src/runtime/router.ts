import { Model as SchemaModel } from "@arforge-ai/schema/model"

/**
 * Cost-aware model routing (pure scoring).
 *
 * `rankByCost` scores candidate models by estimated cost and capability fit
 * and returns a ranked list with an explainable reason. The default mode
 * keeps the session's existing model selection; this module powers the
 * "why was this model chosen" insight and the optional cheapest-fit mode.
 */

export interface CostModel {
  readonly providerID: string
  readonly modelID: string
  readonly inputCost: number // $/MTok
  readonly outputCost: number
  readonly toolcall?: boolean
  readonly vision?: boolean
  readonly reasoning?: boolean
  readonly structured?: boolean
}

export interface RoutingPreference {
  readonly vision?: boolean
  readonly toolcall?: boolean
  readonly reasoning?: boolean
  readonly structured?: boolean
  readonly quality: "balanced" | "cheapest"
  readonly estimatedInputTokens?: number
  readonly estimatedOutputTokens?: number
}

export interface RankedModel extends CostModel {
  readonly costScore: number
  readonly capabilityScore: number
  readonly totalScore: number
}

export type CircuitBreakerState = "closed" | "half-open" | "open"

export type RoutingCredential = {
  readonly available: boolean
  readonly scopes: ReadonlyArray<string>
}

export type RoutingCharge = {
  readonly currency: string
  readonly estimatedMinor: number
}

export interface PolicyModel extends CostModel {
  /** When present, Model.Profile v1 is authoritative for capability/policy evidence. */
  readonly profile?: SchemaModel.Profile
  /** Capabilities used by hard policy gates; absent means unknown and fails closed when required. */
  readonly region?: string
  readonly egress?: string
  readonly credential?: RoutingCredential
  readonly estimatedCharge?: RoutingCharge
  readonly circuitBreaker?: CircuitBreakerState
}

export interface RoutingPolicy {
  readonly preference: RoutingPreference
  readonly providerAllowlist?: ReadonlyArray<string>
  readonly regionAllowlist?: ReadonlyArray<string>
  readonly egressAllowlist?: ReadonlyArray<string>
  readonly requiredCredentialScope?: string
  readonly budget?: {
    readonly currency: string
    readonly limitMinor: number
    readonly spentMinor: number
    readonly reservedMinor: number
  }
  readonly explicitModel?: {
    readonly providerID: string
    readonly modelID: string
  }
}

export type RoutingRejection = {
  readonly providerID: string
  readonly modelID: string
  readonly reasons: ReadonlyArray<string>
  readonly evidence: ReadonlyArray<string>
}

export interface PolicyRankedModel extends RankedModel {
  readonly evidence: ReadonlyArray<string>
}

export type PolicyRoutingResult = {
  readonly ranked: ReadonlyArray<PolicyRankedModel>
  readonly rejected: ReadonlyArray<RoutingRejection>
  readonly reason: string
  readonly evidence: ReadonlyArray<string>
}

export function estimatedCallCost(
  model: Pick<CostModel, "inputCost" | "outputCost">,
  inputTokens: number,
  outputTokens: number,
): number {
  return (model.inputCost * inputTokens + model.outputCost * outputTokens) / 1_000_000
}

export function rankByCost(
  models: ReadonlyArray<CostModel>,
  preference: RoutingPreference,
): { ranked: ReadonlyArray<RankedModel>; reason: string } {
  const inputTokens = preference.estimatedInputTokens ?? 20_000
  const outputTokens = preference.estimatedOutputTokens ?? 2_000
  const key = (model: CostModel) => `${model.providerID}/${model.modelID}`
  const costs = new Map<string, number>()
  for (const model of models) {
    costs.set(key(model), estimatedCallCost(model, inputTokens, outputTokens))
  }
  const maxCost = Math.max(...models.map((model) => costs.get(key(model))!), 1e-9)
  const maxCapability = Math.max(
    ...models.map(
      (model) =>
        (model.toolcall ? 1 : 0) +
        (model.vision ? 1 : 0) +
        (model.reasoning ? 1 : 0) +
        (model.structured ? 1 : 0),
    ),
    1,
  )

  const ranked = models
    .map((model) => {
      const capability =
        (model.toolcall ? 1 : 0) +
        (model.vision ? 1 : 0) +
        (model.reasoning ? 1 : 0) +
        (model.structured ? 1 : 0)
      const missing = (preference.vision && !model.vision ? 1 : 0) + (preference.toolcall && !model.toolcall ? 1 : 0)
      const capabilityScore = capability / maxCapability - missing
      const costScore = 1 - costs.get(key(model))! / maxCost
      const qualityWeight = preference.quality === "cheapest" ? 0.8 : 0.5
      const totalScore = qualityWeight * costScore + (1 - qualityWeight) * capabilityScore
      return { ...model, costScore, capabilityScore, totalScore }
    })
    .toSorted((a, b) => b.totalScore - a.totalScore || a.costScore - b.costScore)

  const best = ranked[0]
  const reason = best
    ? `选择 ${best.providerID}/${best.modelID}：成本分 ${best.costScore.toFixed(2)}，能力分 ${best.capabilityScore.toFixed(2)}，` +
      `估算调用成本 $${costs.get(key(best))!.toFixed(4)}（${preference.quality === "cheapest" ? "成本优先" : "均衡"}策略）`
    : "无可用模型"

  return { ranked, reason }
}

const modelKey = (model: Pick<CostModel, "providerID" | "modelID">) => `${model.providerID}/${model.modelID}`

const allowlisted = (value: string | undefined, allowlist: ReadonlyArray<string> | undefined) =>
  allowlist === undefined || (value !== undefined && allowlist.includes(value))

const capabilityRejections = (model: PolicyModel, preference: RoutingPreference) => {
  const reasons: string[] = []
  const capabilities = model.profile
    ? {
        vision: model.profile.modality.input.includes("image"),
        toolcall: model.profile.capabilities.tools === "supported",
        reasoning: !["none", "unknown"].includes(model.profile.capabilities.reasoning),
        structured: ["native", "synthetic_tool"].includes(model.profile.capabilities.structured),
      }
    : {
        vision: model.vision === true,
        toolcall: model.toolcall === true,
        reasoning: model.reasoning === true,
        structured: model.structured === true,
      }
  if (preference.vision && !capabilities.vision) reasons.push("capability vision is not supported")
  if (preference.toolcall && !capabilities.toolcall) reasons.push("capability tool-calling is not supported")
  if (preference.reasoning && !capabilities.reasoning) reasons.push("capability reasoning is not supported")
  if (preference.structured && !capabilities.structured) reasons.push("capability structured-output is not supported")
  return reasons
}

const profileRegionAllowed = (profile: SchemaModel.Profile, allowlist: ReadonlyArray<string>) =>
  profile.policy.region.mode === "allowlist" &&
  profile.policy.region.regions.length === 1 &&
  allowlist.includes(profile.policy.region.regions[0]!)

const profileEgressAllowed = (profile: SchemaModel.Profile, allowlist: ReadonlyArray<string>) =>
  profile.policy.egress.mode !== "unknown" && allowlist.includes(profile.policy.egress.mode)

const profileEvidence = (profile: SchemaModel.Profile): ReadonlyArray<string> => [
  `model profile=${profile.version}:${profile.providerID}/${profile.modelID}`,
  `profile revision=${profile.priceCatalogRevision}; tokenizer=${profile.tokenizer}; estimator=${profile.estimator}`,
  `profile capabilities=tools:${profile.capabilities.tools},structured:${profile.capabilities.structured},reasoning:${profile.capabilities.reasoning}`,
  `profile modality=input:${profile.modality.input.join(",") || "none"};output:${profile.modality.output.join(",") || "none"}`,
  `profile policy=region:${profile.policy.region.mode};egress:${profile.policy.egress.mode}`,
  `profile observations=${profile.observations.length}`,
]

/**
 * Apply hard policy gates before the existing explainable cost/quality score.
 * Every rejection carries the policy input that caused it; no gate is inferred from legacy cost fields.
 */
export function routeByPolicy(models: ReadonlyArray<PolicyModel>, policy: RoutingPolicy): PolicyRoutingResult {
  const rejected: RoutingRejection[] = []
  const eligible: Array<PolicyModel> = []
  const preference = policy.preference
  const budget = policy.budget

  for (const model of models) {
    const reasons = capabilityRejections(model, preference)
    const evidence: string[] = [
      `capability requirements: vision=${preference.vision === true}, toolcall=${preference.toolcall === true}, reasoning=${preference.reasoning === true}, structured=${preference.structured === true}`,
    ]
    if (model.profile) {
      evidence.push(...profileEvidence(model.profile))
      if (model.profile.providerID !== model.providerID || model.profile.modelID !== model.modelID)
        reasons.push("model profile identity does not match candidate")
    }
    if (policy.providerAllowlist && !policy.providerAllowlist.includes(model.providerID)) {
      reasons.push("provider is outside the allowlist")
      evidence.push(`provider allowlist: ${policy.providerAllowlist.join(",")}`)
    }
    const regionAllowlist = policy.regionAllowlist
    const regionAllowed =
      regionAllowlist === undefined
        ? true
        : model.profile
          ? profileRegionAllowed(model.profile, regionAllowlist)
          : allowlisted(model.region, regionAllowlist)
    if (!regionAllowed) {
      reasons.push("region is outside the allowlist or unknown")
      evidence.push(`region allowlist: ${regionAllowlist?.join(",") ?? "unknown"}`)
    }
    const egressAllowlist = policy.egressAllowlist
    const egressAllowed =
      egressAllowlist === undefined
        ? true
        : model.profile
          ? profileEgressAllowed(model.profile, egressAllowlist)
          : allowlisted(model.egress, egressAllowlist)
    if (!egressAllowed) {
      reasons.push("egress is outside the allowlist or unknown")
      evidence.push(`egress allowlist: ${egressAllowlist?.join(",") ?? "unknown"}`)
    }
    if (policy.requiredCredentialScope) {
      if (model.credential?.available !== true) reasons.push("required credential is unavailable")
      if (!model.credential?.scopes.includes(policy.requiredCredentialScope))
        reasons.push("required credential scope is missing")
      evidence.push(`credential scope: ${policy.requiredCredentialScope}`)
    }
    if (model.circuitBreaker === "open") {
      reasons.push("circuit breaker is open")
      evidence.push("circuit breaker: open")
    }
    if (budget) {
      const charge = model.estimatedCharge
      const projected = budget.spentMinor + budget.reservedMinor + (charge?.estimatedMinor ?? 0)
      evidence.push(
        `budget: ${budget.currency} ${budget.spentMinor}+${budget.reservedMinor}+${charge?.estimatedMinor ?? "unknown"} <= ${budget.limitMinor}`,
      )
      if (charge === undefined) reasons.push("estimated charge is unavailable for the active budget")
      else if (charge.currency !== budget.currency) reasons.push("estimated charge currency mismatches the budget")
      else if (projected > budget.limitMinor) reasons.push("budget cannot cover the estimated call")
    }

    if (reasons.length > 0) {
      rejected.push({ providerID: model.providerID, modelID: model.modelID, reasons, evidence })
    } else {
      eligible.push(model)
    }
  }

  const rankedBase = rankByCost(eligible, preference)
  let ranked: PolicyRankedModel[] = rankedBase.ranked.map((model) => {
    const source = eligible.find((candidate) => modelKey(candidate) === modelKey(model))!
    return {
      ...source,
      ...model,
      evidence: [
        "passed all hard policy gates",
        `provider=${model.providerID}`,
        ...(source.profile ? profileEvidence(source.profile) : []),
        ...(source.region === undefined ? [] : [`region=${source.region}`]),
        ...(source.egress === undefined ? [] : [`egress=${source.egress}`]),
        ...(source.estimatedCharge === undefined
        ? []
          : [`estimated charge=${source.estimatedCharge.currency}:${source.estimatedCharge.estimatedMinor}`]),
        ...(source.circuitBreaker === undefined ? [] : [`circuit breaker=${source.circuitBreaker}`]),
      ],
    }
  })

  const explicitKey = policy.explicitModel && modelKey(policy.explicitModel)
  if (explicitKey) {
    const explicit = ranked.find((model) => modelKey(model) === explicitKey)
    if (explicit) {
      ranked = [explicit, ...ranked.filter((model) => model !== explicit)]
    } else {
      const rejection = rejected.find((model) => modelKey(model) === explicitKey)
      return {
        ranked: [],
        rejected,
        reason: `显式选择 ${explicitKey} 未通过硬策略过滤：${rejection?.reasons.join("；") ?? "模型不可用"}`,
        evidence: [
          `explicit selection: ${explicitKey}`,
          ...(rejection?.evidence ?? []),
        ],
      }
    }
  }

  const selected = ranked[0]
  const reason = selected
    ? `${explicitKey && modelKey(selected) === explicitKey ? `显式选择 ${explicitKey}` : rankedBase.reason}；硬过滤通过 ${ranked.length}/${models.length} 个候选`
    : `无模型通过硬策略过滤（${models.length} 个候选）`
  return {
    ranked,
    rejected,
    reason,
    evidence: [
      `candidate count: ${models.length}`,
      `eligible count: ${ranked.length}`,
      ...(policy.providerAllowlist ? [`provider allowlist: ${policy.providerAllowlist.join(",")}`] : []),
      ...(policy.regionAllowlist ? [`region allowlist: ${policy.regionAllowlist.join(",")}`] : []),
      ...(policy.egressAllowlist ? [`egress allowlist: ${policy.egressAllowlist.join(",")}`] : []),
      ...(policy.requiredCredentialScope ? [`required credential scope: ${policy.requiredCredentialScope}`] : []),
      ...(budget ? [`budget: ${budget.currency}/${budget.limitMinor}`] : []),
      ...(explicitKey ? [`explicit selection: ${explicitKey}`] : []),
    ],
  }
}
