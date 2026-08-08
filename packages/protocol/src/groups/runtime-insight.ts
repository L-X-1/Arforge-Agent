import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { Context, Schema } from "effect"
import { LocationQuery, locationQueryOpenApi } from "./location"

const root = "/api/runtime-insight"

export const ContextLayerReport = Schema.Struct({
  layer: Schema.String,
  name: Schema.String,
  source: Schema.String,
  tokens: Schema.Number,
  chars: Schema.Number,
  kept: Schema.Boolean,
})

export const ContextLayersReport = Schema.Struct({
  sessionID: Schema.String,
  timestamp: Schema.Number,
  model: Schema.String,
  totalTokens: Schema.Number,
  layers: Schema.Array(ContextLayerReport),
})

export const RoutingDecision = Schema.Struct({
  timestamp: Schema.Number,
  sessionID: Schema.String,
  task: Schema.String,
  providerID: Schema.String,
  modelID: Schema.String,
  inputCost: Schema.Number,
  outputCost: Schema.Number,
  reason: Schema.String,
  candidates: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      inputCost: Schema.Number,
      outputCost: Schema.Number,
    }),
  ),
})

export const VerificationRecord = Schema.Struct({
  timestamp: Schema.Number,
  sessionID: Schema.String,
  toolCallID: Schema.String,
  claim: Schema.String,
  commands: Schema.Array(Schema.String),
  results: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      ok: Schema.Boolean,
      exitCode: Schema.NullOr(Schema.Number),
      outputTail: Schema.String,
    }),
  ),
  passed: Schema.Boolean,
  durationMs: Schema.Number,
})

export const AuditEntry = Schema.Struct({
  seq: Schema.Number,
  recordedAt: Schema.Number,
  actor: Schema.String,
  action: Schema.String,
  resource: Schema.String,
  reason: Schema.NullOr(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  previousHash: Schema.String,
  recordHash: Schema.String,
})

export const AuditVerify = Schema.Struct({
  valid: Schema.Boolean,
  count: Schema.Number,
  headHash: Schema.String,
  issue: Schema.NullOr(Schema.String),
})

export const RunRecord = Schema.Struct({
  runID: Schema.String,
  sessionID: Schema.String,
  status: Schema.String,
  startedAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
  lastSeq: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
})

export const MemoryRecallHit = Schema.Struct({
  memoryID: Schema.String,
  content: Schema.String,
  score: Schema.Number,
  source: Schema.String,
})

export const MemoryRecallRecord = Schema.Struct({
  timestamp: Schema.Number,
  sessionID: Schema.String,
  query: Schema.String,
  algorithm: Schema.String,
  hits: Schema.Array(MemoryRecallHit),
})

export const RuntimeInsightPage = Schema.Struct({
  contextLayers: Schema.Array(ContextLayersReport),
  routing: Schema.Array(RoutingDecision),
  verifications: Schema.Array(VerificationRecord),
  audit: Schema.Array(AuditEntry),
  auditDropped: Schema.Number,
  auditVerify: AuditVerify,
  runs: Schema.Array(RunRecord),
  recalls: Schema.Array(MemoryRecallRecord),
})

export const makeRuntimeInsightGroup = <
  I extends HttpApiMiddleware.AnyId,
  S,
>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.runtimeInsight")
    .add(
      HttpApiEndpoint.get("runtimeInsight.snapshot", `${root}/snapshot`, {
        query: {
          ...LocationQuery.fields,
          limit: Schema.String.pipe(Schema.optional),
        },
        success: RuntimeInsightPage,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("runtimeInsight.auditVerify", `${root}/audit/verify`, {
        success: AuditVerify,
      }).middleware(locationMiddleware),
    )
