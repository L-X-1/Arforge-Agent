export * as HybridRanking from "./hybrid-ranking"

import type { Hit } from "./code-retrieval"
import type * as SourceRegistry from "./source-registry"

export interface WeightProfile {
  readonly version: string
  readonly lexical: number
  readonly vector: number
  readonly symbol: number
  readonly recency: number
  readonly intent: number
  readonly path: number
  readonly trust: number
  readonly usefulness: number
  readonly tokenCost: number
  readonly duplication: number
  readonly modelRelevance: number
}

export const DEFAULT_WEIGHTS: WeightProfile = Object.freeze({
  version: "hybrid-v1",
  lexical: 0.2,
  vector: 0.15,
  symbol: 0.12,
  recency: 0.1,
  intent: 0.12,
  path: 0.08,
  trust: 0.1,
  usefulness: 0.05,
  tokenCost: 0.04,
  duplication: 0.04,
  modelRelevance: 0.03,
})

export interface Candidate {
  readonly hit: Hit
  readonly source: SourceRegistry.SourceRecord
  readonly symbolDistance?: number
  readonly userIntentScore?: number
  readonly pathScopeScore?: number
  readonly priorUsefulness?: number
  readonly tokenCost?: number
  readonly modelRelevance?: number
  readonly duplicateKey?: string
}

export interface Request {
  readonly candidates: ReadonlyArray<Candidate>
  readonly maxResults?: number
  readonly maxTokenCost?: number
  readonly weights?: WeightProfile
}

export interface FeatureSet {
  readonly lexical: number
  readonly vector: number
  readonly symbol: number
  readonly recency: number
  readonly intent: number
  readonly path: number
  readonly trust: number
  readonly usefulness: number
  readonly tokenCost: number
  readonly duplication: number
  readonly modelRelevance: number
}

export interface RankedCandidate {
  readonly rank: number
  readonly score: number
  readonly candidate: Candidate
  readonly features: FeatureSet
  readonly contributions: FeatureSet
  readonly explanation: string
  readonly weightVersion: string
}

export class InvalidWeightProfileError extends Error {
  readonly _tag = "Context.InvalidWeightProfile"
  readonly reason: string
  constructor(reason: string) {
    super(reason)
    this.reason = reason
  }
}

const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)

const trustScore = (trust: SourceRegistry.TrustClass) =>
  trust === "trusted" ? 1 : trust === "verified" ? 0.85 : trust === "untrusted" ? 0.35 : 0

const weights = (profile: WeightProfile): ReadonlyArray<readonly [keyof FeatureSet, number]> => [
  ["lexical", profile.lexical],
  ["vector", profile.vector],
  ["symbol", profile.symbol],
  ["recency", profile.recency],
  ["intent", profile.intent],
  ["path", profile.path],
  ["trust", profile.trust],
  ["usefulness", profile.usefulness],
  ["tokenCost", profile.tokenCost],
  ["duplication", profile.duplication],
  ["modelRelevance", profile.modelRelevance],
]

function validateWeights(profile: WeightProfile): void {
  if (!profile.version.trim()) throw new InvalidWeightProfileError("weight profile version is required")
  if (weights(profile).some(([, value]) => !Number.isFinite(value) || value < 0))
    throw new InvalidWeightProfileError("weight profile values must be finite and non-negative")
  if (weights(profile).every(([, value]) => value === 0)) throw new InvalidWeightProfileError("at least one weight is required")
}

function duplicateIdentity(candidate: Candidate): string {
  return candidate.duplicateKey ?? candidate.hit.contentDigest
}

function features(candidate: Candidate, duplicateCount: number, maxTokenCost: number): FeatureSet {
  const tokenCost = candidate.tokenCost ?? 0
  const duplicationPenalty = duplicateCount <= 1 ? 0 : Math.min(1, (duplicateCount - 1) / duplicateCount)
  return {
    lexical: clamp(candidate.hit.lexicalScore),
    vector: clamp(candidate.hit.semanticScore),
    symbol: clamp(1 / (1 + Math.max(0, candidate.symbolDistance ?? 0))),
    recency: clamp(candidate.hit.freshnessScore),
    intent: clamp(candidate.userIntentScore ?? 0.5),
    path: clamp(candidate.pathScopeScore ?? 0.5),
    trust: trustScore(candidate.source.trust),
    usefulness: clamp(candidate.priorUsefulness ?? 0.5),
    tokenCost: 1 - clamp(tokenCost / Math.max(1, maxTokenCost)),
    duplication: 1 - duplicationPenalty,
    modelRelevance: clamp(candidate.modelRelevance ?? 0),
  }
}

const weighted = (values: FeatureSet, profile: WeightProfile): { score: number; contributions: FeatureSet } => {
  const pairs = weights(profile)
  const totalWeight = pairs.reduce((sum, [, weight]) => sum + weight, 0)
  const contributions: FeatureSet = {
    lexical: values.lexical * profile.lexical,
    vector: values.vector * profile.vector,
    symbol: values.symbol * profile.symbol,
    recency: values.recency * profile.recency,
    intent: values.intent * profile.intent,
    path: values.path * profile.path,
    trust: values.trust * profile.trust,
    usefulness: values.usefulness * profile.usefulness,
    tokenCost: values.tokenCost * profile.tokenCost,
    duplication: values.duplication * profile.duplication,
    modelRelevance: values.modelRelevance * profile.modelRelevance,
  }
  const score = pairs.reduce((sum, [key, weight]) => sum + values[key] * weight, 0) / totalWeight
  return { score: clamp(score), contributions }
}

const explanation = (values: FeatureSet, profile: WeightProfile, score: number) => {
  const strongest = weights(profile)
    .map(([key, weight]) => ({ key, contribution: values[key] * weight }))
    .toSorted((left, right) => right.contribution - left.contribution)
    .slice(0, 3)
    .map(({ key }) => `${key}=${values[key].toFixed(2)}`)
    .join(", ")
  return `score=${score.toFixed(4)}; ${strongest}; weights=${profile.version}`
}

export function rank(request: Request): ReadonlyArray<RankedCandidate> {
  const profile = request.weights ?? DEFAULT_WEIGHTS
  validateWeights(profile)
  const maxTokenCost = request.maxTokenCost ?? 10_000
  const counts = new Map<string, number>()
  for (const candidate of request.candidates) {
    const key = duplicateIdentity(candidate)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return request.candidates
    .map((candidate) => {
      const value = features(candidate, counts.get(duplicateIdentity(candidate)) ?? 1, maxTokenCost)
      const result = weighted(value, profile)
      return {
        rank: 0,
        score: result.score,
        candidate,
        features: value,
        contributions: result.contributions,
        explanation: explanation(value, profile, result.score),
        weightVersion: profile.version,
      }
    })
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.features.trust - left.features.trust ||
        left.candidate.hit.path.localeCompare(right.candidate.hit.path),
    )
    .slice(0, Math.min(100, Math.max(1, request.maxResults ?? 20)))
    .map((item, index) => ({ ...item, rank: index + 1 }))
}
