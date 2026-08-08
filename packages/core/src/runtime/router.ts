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
}

export interface RoutingPreference {
  readonly vision?: boolean
  readonly toolcall?: boolean
  readonly quality: "balanced" | "cheapest"
  readonly estimatedInputTokens?: number
  readonly estimatedOutputTokens?: number
}

export interface RankedModel extends CostModel {
  readonly costScore: number
  readonly capabilityScore: number
  readonly totalScore: number
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
    ...models.map((model) => (model.toolcall ? 1 : 0) + (model.vision ? 1 : 0) + (model.reasoning ? 1 : 0)),
    1,
  )

  const ranked = models
    .map((model) => {
      const capability = (model.toolcall ? 1 : 0) + (model.vision ? 1 : 0) + (model.reasoning ? 1 : 0)
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
