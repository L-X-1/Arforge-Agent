import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, desc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { Result as ModelProbeResult } from "../model-probe"
import { EvaluationResultTable } from "./sql"

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "RuntimeEvaluation.InvalidInputError",
  { reason: Schema.String },
) {}

export class DuplicateEvaluationError extends Schema.TaggedErrorClass<DuplicateEvaluationError>()(
  "RuntimeEvaluation.DuplicateEvaluationError",
  { evaluationID: AgentRuntime.EvaluationID },
) {}

export type Metrics = Readonly<Record<string, number>>

export type CapabilityEvaluationInput = {
  readonly result: ModelProbeResult
  readonly runID: AgentRuntime.RunID
  readonly suiteRevision: number
  readonly caseRevision: number
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly baselinePassed: boolean
  readonly createdAt?: number
  readonly evaluatedAt?: number
}

export type CreateInput = {
  readonly id?: AgentRuntime.EvaluationID
  readonly runID: AgentRuntime.RunID
  readonly suiteID: string
  readonly suiteRevision: number
  readonly caseID: string
  readonly caseRevision: number
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly sampleSize: number
  readonly score: number
  readonly successDelta: number
  readonly costDelta: number
  readonly latencyDelta: number
  readonly passed: boolean
  readonly metrics: Metrics
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly providerID?: string
  readonly modelID?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costMinor?: number
  readonly currency?: string
  readonly reviewerID?: string
  readonly approvalStatus?: "pending" | "approved" | "rejected"
  readonly approvalReason?: string
  readonly createdAt?: number
  readonly evaluatedAt?: number
}

export interface EvaluationRecord {
  readonly id: AgentRuntime.EvaluationID
  readonly runID: AgentRuntime.RunID
  readonly suiteID: string
  readonly suiteRevision: number
  readonly caseID: string
  readonly caseRevision: number
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly sampleSize: number
  readonly score: number
  readonly successDelta: number
  readonly costDelta: number
  readonly latencyDelta: number
  readonly passed: boolean
  readonly metrics: Metrics
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly providerID?: string
  readonly modelID?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costMinor?: number
  readonly currency?: string
  readonly reviewerID?: string
  readonly approvalStatus: "pending" | "approved" | "rejected"
  readonly approvalReason?: string
  readonly createdAt: number
  readonly evaluatedAt: number
  readonly result: AgentRuntime.EvaluationResult
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<EvaluationRecord, InvalidInputError | DuplicateEvaluationError>
  readonly get: (evaluationID: AgentRuntime.EvaluationID) => Effect.Effect<EvaluationRecord | undefined>
  readonly list: (input?: {
    readonly runID?: AgentRuntime.RunID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<EvaluationRecord>>
}

const numericObservationValue = (value: unknown, key: string) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const candidate = Reflect.get(value, key)
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined
}

/**
 * Convert the redacted ModelProbe report into the one canonical Evaluation Core
 * input. Callers still provide immutable artifact/evidence references; the
 * probe report is never written through a parallel result format.
 */
export const fromCapabilityProbe = (input: CapabilityEvaluationInput): CreateInput => {
  const observations = input.result.observations
  const passedCount = observations.filter((observation) => observation.status === "pass").length
  const failedCount = observations.filter((observation) => observation.status === "fail").length
  const inconclusiveCount = observations.filter((observation) => observation.status === "inconclusive").length
  const latencyValues = observations
    .map((observation) => numericObservationValue(observation.value, "latencyMs"))
    .filter((value): value is number => value !== undefined)
  const averageLatency =
    latencyValues.length === 0 ? 0 : latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length
  const sampleSize = observations.length
  const score = sampleSize === 0 ? 0 : passedCount / sampleSize
  const passed = sampleSize > 0 && failedCount === 0 && inconclusiveCount === 0

  return {
    runID: input.runID,
    suiteID: "model-capability-probe",
    suiteRevision: input.suiteRevision,
    caseID: `${input.result.providerID}/${input.result.modelID}`,
    caseRevision: input.caseRevision,
    baselineArtifactDigest: input.baselineArtifactDigest,
    candidateArtifactDigest: input.candidateArtifactDigest,
    environmentDigest: input.environmentDigest,
    toolchainDigest: input.toolchainDigest,
    sampleSize,
    score,
    successDelta: (passed ? 1 : 0) - (input.baselinePassed ? 1 : 0),
    costDelta: 0,
    latencyDelta: averageLatency,
    passed,
    metrics: {
      observation_count: sampleSize,
      passed_count: passedCount,
      failed_count: failedCount,
      inconclusive_count: inconclusiveCount,
      average_latency_ms: averageLatency,
      source_live: input.result.source === "live" ? 1 : 0,
    },
    evidenceIDs: input.evidenceIDs,
    providerID: input.result.providerID,
    modelID: input.result.modelID,
    approvalStatus: "pending",
    createdAt: input.createdAt,
    evaluatedAt: input.evaluatedAt,
  }
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/RuntimeEvaluation") {}

type Row = typeof EvaluationResultTable.$inferSelect

const digestPattern = /^(?:sha256:)?[a-f0-9]{40,128}$/i
const validDigest = (value: string) => digestPattern.test(value)
const validInteger = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const validFinite = (value: number) => Number.isFinite(value)

const validate = (input: CreateInput): Effect.Effect<void, InvalidInputError> =>
  Effect.gen(function* () {
    if (!input.suiteID.trim() || !input.caseID.trim())
      return yield* new InvalidInputError({ reason: "suiteID and caseID are required" })
    if (!validInteger(input.suiteRevision, 1) || !validInteger(input.caseRevision, 1))
      return yield* new InvalidInputError({ reason: "suiteRevision and caseRevision must be positive integers" })
    if (!validInteger(input.sampleSize))
      return yield* new InvalidInputError({ reason: "sampleSize must be non-negative" })
    if (![input.score, input.successDelta, input.costDelta, input.latencyDelta].every(validFinite))
      return yield* new InvalidInputError({ reason: "score and deltas must be finite numbers" })
    if (
      ![
        input.baselineArtifactDigest,
        input.candidateArtifactDigest,
        input.environmentDigest,
        input.toolchainDigest,
      ].every(validDigest)
    )
      return yield* new InvalidInputError({
        reason: "artifact, environment, and toolchain values must be immutable digests",
      })
    if (input.evidenceIDs.length === 0 || input.evidenceIDs.some((id) => !String(id).startsWith("evd_")))
      return yield* new InvalidInputError({ reason: "at least one immutable evidence ID is required" })
    if (Object.entries(input.metrics).some(([name, value]) => !name.trim() || !validFinite(value)))
      return yield* new InvalidInputError({ reason: "metrics must be named finite numeric values" })
    if (input.inputTokens !== undefined && !validInteger(input.inputTokens))
      return yield* new InvalidInputError({ reason: "inputTokens must be non-negative" })
    if (input.outputTokens !== undefined && !validInteger(input.outputTokens))
      return yield* new InvalidInputError({ reason: "outputTokens must be non-negative" })
    if (input.costMinor !== undefined && !validInteger(input.costMinor))
      return yield* new InvalidInputError({ reason: "costMinor must be non-negative" })
    if (input.createdAt !== undefined && !validFinite(input.createdAt))
      return yield* new InvalidInputError({ reason: "createdAt must be finite" })
    if (input.evaluatedAt !== undefined && !validFinite(input.evaluatedAt))
      return yield* new InvalidInputError({ reason: "evaluatedAt must be finite" })
  })

const toRecord = (row: Row): EvaluationRecord => ({
  id: row.id,
  runID: row.run_id,
  suiteID: row.suite_id,
  suiteRevision: row.suite_revision,
  caseID: row.case_id,
  caseRevision: row.case_revision,
  baselineArtifactDigest: row.baseline_artifact_digest,
  candidateArtifactDigest: row.candidate_artifact_digest,
  environmentDigest: row.environment_digest,
  toolchainDigest: row.toolchain_digest,
  sampleSize: row.sample_size,
  score: row.score,
  successDelta: row.success_delta,
  costDelta: row.cost_delta,
  latencyDelta: row.latency_delta,
  passed: row.passed,
  metrics: row.metrics,
  evidenceIDs: row.evidence_ids,
  providerID: row.provider_id ?? undefined,
  modelID: row.model_id ?? undefined,
  inputTokens: row.input_tokens ?? undefined,
  outputTokens: row.output_tokens ?? undefined,
  costMinor: row.cost_minor ?? undefined,
  currency: row.currency ?? undefined,
  reviewerID: row.reviewer_id ?? undefined,
  approvalStatus: row.approval_status as "pending" | "approved" | "rejected",
  approvalReason: row.approval_reason ?? undefined,
  createdAt: row.created_at,
  evaluatedAt: row.evaluated_at,
  result: AgentRuntime.EvaluationResult.make({
    id: row.id,
    baseline: row.baseline_artifact_digest,
    candidate: row.candidate_artifact_digest,
    sampleSize: row.sample_size,
    successDelta: row.success_delta,
    costDelta: row.cost_delta,
    latencyDelta: row.latency_delta,
    passed: row.passed,
    evidenceIDs: row.evidence_ids,
    evaluatedAt: DateTime.makeUnsafe(row.evaluated_at),
  }),
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const create = Effect.fn("RuntimeEvaluation.create")(function* (input: CreateInput) {
      yield* validate(input)
      const principal = yield* Database.CurrentPrincipal
      const id = input.id ?? AgentRuntime.EvaluationID.create()
      const createdAt = input.createdAt ?? Date.now()
      const evaluatedAt = input.evaluatedAt ?? createdAt
      const inserted = yield* db
        .insert(EvaluationResultTable)
        .values({
          tenant_id: principal?.tenantID ?? "ten_local",
          owner_user_id: principal?.userID ?? "usr_local",
          id,
          run_id: input.runID,
          suite_id: input.suiteID,
          suite_revision: input.suiteRevision,
          case_id: input.caseID,
          case_revision: input.caseRevision,
          baseline_artifact_digest: input.baselineArtifactDigest,
          candidate_artifact_digest: input.candidateArtifactDigest,
          environment_digest: input.environmentDigest,
          toolchain_digest: input.toolchainDigest,
          sample_size: input.sampleSize,
          score: input.score,
          success_delta: input.successDelta,
          cost_delta: input.costDelta,
          latency_delta: input.latencyDelta,
          passed: input.passed,
          metrics: input.metrics,
          evidence_ids: input.evidenceIDs,
          provider_id: input.providerID ?? null,
          model_id: input.modelID ?? null,
          input_tokens: input.inputTokens ?? null,
          output_tokens: input.outputTokens ?? null,
          cost_minor: input.costMinor ?? null,
          currency: input.currency ?? null,
          reviewer_id: input.reviewerID ?? null,
          approval_status: input.approvalStatus ?? "pending",
          approval_reason: input.approvalReason ?? null,
          created_at: createdAt,
          evaluated_at: evaluatedAt,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!inserted) return yield* new DuplicateEvaluationError({ evaluationID: id })
      return toRecord(inserted)
    })

    const get = Effect.fn("RuntimeEvaluation.get")(function* (evaluationID: AgentRuntime.EvaluationID) {
      const principal = yield* Database.CurrentPrincipal
      const tenantID = principal?.tenantID ?? "ten_local"
      const userID = principal?.userID ?? "usr_local"
      const row = yield* db
        .select()
        .from(EvaluationResultTable)
        .where(
          and(
            eq(EvaluationResultTable.tenant_id, tenantID),
            eq(EvaluationResultTable.owner_user_id, userID),
            eq(EvaluationResultTable.id, evaluationID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? toRecord(row) : undefined
    })

    const list = Effect.fn("RuntimeEvaluation.list")(function* (input?: {
      readonly runID?: AgentRuntime.RunID
      readonly limit?: number
    }) {
      const limit = Math.max(1, Math.min(100, Math.floor(input?.limit ?? 50)))
      const principal = yield* Database.CurrentPrincipal
      const tenantID = principal?.tenantID ?? "ten_local"
      const userID = principal?.userID ?? "usr_local"
      const rows = yield* db
        .select()
        .from(EvaluationResultTable)
        .where(
          and(
            eq(EvaluationResultTable.tenant_id, tenantID),
            eq(EvaluationResultTable.owner_user_id, userID),
            input?.runID ? eq(EvaluationResultTable.run_id, input.runID) : undefined,
          ),
        )
        .orderBy(desc(EvaluationResultTable.created_at))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(toRecord)
    })

    return { create, get, list }
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
