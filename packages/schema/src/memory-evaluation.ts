import { Schema } from "effect"
import { NonNegativeInt } from "./schema"

export const MetricStatus = Schema.Literals(["measured", "not_measured"]).annotate({
  identifier: "MemoryEvaluationMetricStatus",
})
export type MetricStatus = typeof MetricStatus.Type

export const Metric = Schema.Struct({
  status: MetricStatus,
  value: Schema.Finite.pipe(Schema.optional),
  numerator: NonNegativeInt.pipe(Schema.optional),
  denominator: NonNegativeInt.pipe(Schema.optional),
  note: Schema.String,
}).annotate({ identifier: "MemoryEvaluationMetric" })
export interface Metric extends Schema.Schema.Type<typeof Metric> {}

export const QueryCase = Schema.Struct({
  queryID: Schema.String,
  relevantIDs: Schema.Array(Schema.String),
  retrievedIDs: Schema.Array(Schema.String),
  scopeLeakIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  staleIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  conflictingIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  deletedIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  forgottenIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  contaminatedIDs: Schema.Array(Schema.String).pipe(Schema.optional),
  latencyMs: Schema.Finite.pipe(Schema.optional),
  inputTokens: NonNegativeInt.pipe(Schema.optional),
  costMinor: NonNegativeInt.pipe(Schema.optional),
  downstreamTaskDelta: Schema.Finite.pipe(Schema.optional),
}).annotate({ identifier: "MemoryEvaluationQueryCase" })
export interface QueryCase extends Schema.Schema.Type<typeof QueryCase> {}

export const Dataset = Schema.Struct({
  id: Schema.String,
  revision: Schema.String,
  source: Schema.Literals(["external", "recorded"]),
  queryIDs: Schema.Array(Schema.String),
}).annotate({ identifier: "MemoryEvaluationDataset" })
export interface Dataset extends Schema.Schema.Type<typeof Dataset> {}

export const Metrics = Schema.Struct({
  recallAtK: Metric,
  meanReciprocalRank: Metric,
  falseRecallRate: Metric,
  crossScopeLeakRate: Metric,
  staleRecallRate: Metric,
  conflictingRecallRate: Metric,
  deletionPropagationRate: Metric,
  forgetPropagationRate: Metric,
  promptInjectionContaminationRate: Metric,
  latencyMs: Metric,
  inputTokens: Metric,
  costMinor: Metric,
  downstreamTaskDelta: Metric,
}).annotate({ identifier: "MemoryEvaluationMetrics" })
export interface Metrics extends Schema.Schema.Type<typeof Metrics> {}

export const Snapshot = Schema.Struct({
  kind: Schema.Literals(["baseline", "candidate"]),
  dataset: Dataset,
  topK: NonNegativeInt,
  metrics: Metrics,
}).annotate({ identifier: "MemoryEvaluationSnapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
