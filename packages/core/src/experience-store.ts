export * as ExperienceStoreV1 from "./experience-store"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import * as EvidenceV2 from "./evidence"
import * as ExperienceEvaluation from "./experience-evaluation"
import { LearningV2 } from "./learning"
import { redact } from "./redact"
import { DurableAction } from "./runtime/durable-action"
import { DurableRun } from "./runtime/durable-run"
import * as AdmissionEvidence from "./runtime/admission-evidence"
import * as RuntimeEvaluation from "./runtime/evaluation"
import { canonicalHash } from "./util/canonical-hash"
import {
  ExperienceAuditTable,
  ExperienceCandidateTable,
  ExperienceEvaluationTable,
  ExperienceEvidenceTable,
  ExperienceRecordTable,
  ExperienceSupportTable,
} from "./experience-store/sql"

const DIGEST = /^[a-f0-9]{64}$/i
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MINIMUM_SUPPORT = 3

export interface TrustedExperienceIdentity {
  readonly tenantID: string
  readonly userID: string
  readonly actor: string
}

export interface RecordVerifiedEvidenceInput {
  readonly identity: TrustedExperienceIdentity
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly evaluationID: AgentRuntime.EvaluationID
  readonly evidence: ReadonlyArray<AgentRuntime.Evidence>
}

/**
 * Internal runtime admission writer input.  The caller supplies the same
 * immutable admission contract used by DurableRun plus the real Action ID;
 * ExperienceStore loads the Action/Observation itself before writing.  No
 * renderer, HTTP client, provider payload, or database handle crosses this
 * boundary.
 */
export interface RecordAdmissionEvidenceInput extends AdmissionEvidence.PlanInput {
  readonly actionID: AgentRuntime.ActionID
}

export interface AdmissionEvidenceProjection {
  readonly evidenceID: AgentRuntime.EvidenceID
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly observationID: AgentRuntime.ObservationID
  readonly recordDigest: string
  readonly inserted: boolean
}

export interface VerifiedEvidenceProjection {
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly observationID: AgentRuntime.ObservationID
  readonly evaluationID: AgentRuntime.EvaluationID
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
}

export interface RecordVerifiedSupportInput extends RecordVerifiedEvidenceInput {
  readonly candidateID?: string
  readonly problemSignature: string
  readonly applicableScope: string
  readonly conditions: ReadonlyArray<string>
  readonly attemptedStrategy: string
  readonly summary: string
  readonly counterexample?: string
  readonly policyVersion: string
  readonly expiryAt?: number
}

export interface CandidateProjection {
  readonly candidateID: string
  readonly problemSignature: string
  readonly applicableScope: string
  readonly conditions: ReadonlyArray<string>
  readonly attemptedStrategy: string
  readonly counterexamples: ReadonlyArray<string>
  readonly supportCount: number
  readonly sourceRunIDs: ReadonlyArray<AgentRuntime.RunID>
  readonly sourceSupportIDs: ReadonlyArray<string>
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly evaluationDigest?: string
  readonly reviewActor?: string
  readonly reviewReason?: string
  readonly reviewStatus: "pending" | "approved" | "rejected" | "expired"
  readonly status: "candidate" | "active" | "rejected" | "expired"
  readonly policyVersion: string
  readonly expiryAt?: number
  readonly digest: string
  readonly revision: number
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PromotionResult {
  readonly candidate: CandidateProjection
  readonly experiences: ReadonlyArray<AgentRuntime.ExperienceRecord>
  readonly receiptDigest: string
}

export interface ProvenanceBundle {
  readonly experiences: ReadonlyArray<AgentRuntime.ExperienceRecord>
  readonly evidence: ReadonlyArray<AgentRuntime.Evidence>
  readonly evaluations: ReadonlyArray<{
    readonly runID: AgentRuntime.RunID
    readonly result: AgentRuntime.EvaluationResult
  }>
}

export interface ExperienceSourceProjection {
  readonly experienceID: AgentRuntime.ExperienceID
  readonly candidateID: string
  readonly summary: string
  readonly evidenceCount: number
  readonly recordDigest: string
  readonly policyVersion: string
  readonly createdAt: number
}

export class ExperienceStoreError extends Schema.TaggedErrorClass<ExperienceStoreError>()("ExperienceStore.Error", {
  reason: Schema.String,
}) {}

export class ExperienceStoreNotFoundError extends Schema.TaggedErrorClass<ExperienceStoreNotFoundError>()(
  "ExperienceStore.NotFound",
  { kind: Schema.String, id: Schema.String },
) {}

export class ExperienceStoreConflictError extends Schema.TaggedErrorClass<ExperienceStoreConflictError>()(
  "ExperienceStore.Conflict",
  { id: Schema.String, reason: Schema.String },
) {}

export interface Interface {
  /** Internal verifier sink. No renderer/API path may submit Evidence snapshots. */
  readonly recordVerifiedEvidence: (
    input: RecordVerifiedEvidenceInput,
  ) => Effect.Effect<VerifiedEvidenceProjection, ExperienceStoreError | ExperienceStoreConflictError>
  /**
   * Persist one admitted custom-agent receipt after a real successful,
   * settled Action Observation exists.  This is intentionally not the child
   * result/budget settlement boundary yet; that coupling remains owned by the
   * future DurableRun transaction seam.
   */
  readonly recordAdmissionEvidence: (
    input: RecordAdmissionEvidenceInput,
  ) => Effect.Effect<AdmissionEvidenceProjection, ExperienceStoreError | ExperienceStoreConflictError>
  readonly recordVerifiedSupport: (
    input: RecordVerifiedSupportInput,
  ) => Effect.Effect<CandidateProjection, ExperienceStoreError | ExperienceStoreConflictError>
  readonly recordEvaluation: (input: {
    readonly identity: TrustedExperienceIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly observations: ReadonlyArray<ExperienceEvaluation.ReplayObservation>
  }) => Effect.Effect<
    CandidateProjection,
    ExperienceStoreError | ExperienceStoreNotFoundError | ExperienceStoreConflictError
  >
  readonly review: (input: {
    readonly identity: TrustedExperienceIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly decision: "approve" | "reject"
    readonly reason: string
  }) => Effect.Effect<
    PromotionResult,
    ExperienceStoreError | ExperienceStoreNotFoundError | ExperienceStoreConflictError
  >
  readonly getCandidate: (
    identity: TrustedExperienceIdentity,
    candidateID: string,
  ) => Effect.Effect<CandidateProjection, ExperienceStoreNotFoundError | ExperienceStoreError>
  readonly listCandidates: (
    identity: TrustedExperienceIdentity,
    input?: { readonly status?: CandidateProjection["status"]; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<CandidateProjection>, ExperienceStoreError>
  readonly listSources: (
    identity: TrustedExperienceIdentity,
    input?: { readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<ExperienceSourceProjection>, ExperienceStoreError>
  /**
   * Resolve EvidenceID references inside the caller's existing tenant/user
   * scope. The result is metadata-only and never returns Evidence payload.
   */
  readonly resolveEvidenceIDs: (
    identity: TrustedExperienceIdentity,
    evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>,
  ) => Effect.Effect<EvidenceV2.ReferenceResolution, ExperienceStoreError>
  /**
   * Resolve EvidenceID references and return only owner-verified record
   * digests.  This is the recovery boundary used to compare an immutable
   * settlement receipt after restart; payload, summary, artifact and path
   * fields never cross the interface.
   */
  readonly resolveEvidenceFacts: (
    identity: TrustedExperienceIdentity,
    evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>,
  ) => Effect.Effect<EvidenceV2.ReferenceResolutionFacts, ExperienceStoreError>
  readonly loadProvenance: (
    identity: TrustedExperienceIdentity,
    experienceIDs: ReadonlyArray<AgentRuntime.ExperienceID>,
  ) => Effect.Effect<ProvenanceBundle, ExperienceStoreError | ExperienceStoreNotFoundError>
  readonly verifyAudit: (
    identity: TrustedExperienceIdentity,
    candidateID: string,
  ) => Effect.Effect<
    { readonly valid: boolean; readonly events: number; readonly headHash: string },
    ExperienceStoreError
  >
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ExperienceStore") {}

type CandidateRow = typeof ExperienceCandidateTable.$inferSelect
type SupportRow = typeof ExperienceSupportTable.$inferSelect
type RecordRow = typeof ExperienceRecordTable.$inferSelect
type AuditRow = typeof ExperienceAuditTable.$inferSelect
type DatabaseTransaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]
type QueryDatabase = Database.Interface["db"] | DatabaseTransaction

const normalizeIdentity = (identity: TrustedExperienceIdentity): TrustedExperienceIdentity => {
  const tenantID = identity.tenantID.trim()
  const userID = identity.userID.trim()
  const actor = identity.actor.trim()
  if (!ID.test(tenantID) || !ID.test(userID) || !actor) throw new Error("trusted identity is invalid")
  if (actor === "user:product") throw new Error("placeholder actors are forbidden")
  return { tenantID, userID, actor }
}

const humanActor = (actor: string) => actor.startsWith("user:") || actor.startsWith("admin:")

const bounded = (value: string, field: string, maximum: number) => {
  const normalized = redact(value).trim().slice(0, maximum)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

const unique = (values: ReadonlyArray<string>, field: string, maximum = 256) => {
  const normalized = [...new Set(values.map((value) => bounded(value, field, maximum)))]
  return normalized.toSorted()
}

const ownership = (table: { tenant_id: any; owner_user_id: any }, identity: TrustedExperienceIdentity) =>
  and(eq(table.tenant_id, identity.tenantID), eq(table.owner_user_id, identity.userID))

const encodeEvidence = (value: AgentRuntime.Evidence): unknown => Schema.encodeUnknownSync(AgentRuntime.Evidence)(value)

const decodeEvidence = (value: unknown): AgentRuntime.Evidence => Schema.decodeUnknownSync(AgentRuntime.Evidence)(value)

const toExperienceSource = (row: RecordRow): ExperienceSourceProjection => {
  const experience = decodeExperience(row.record)
  const expectedEvidenceIDs = row.evidence_ids.map(String).toSorted().join("\u0000")
  const actualEvidenceIDs = experience.evidenceIDs.map(String).toSorted().join("\u0000")
  if (
    !experience.reusable ||
    String(experience.id) !== String(row.id) ||
    String(experience.runID) !== String(row.run_id) ||
    expectedEvidenceIDs !== actualEvidenceIDs ||
    row.record_digest !== canonicalHash(encodeExperience(experience))
  )
    throw new Error(`Experience record provenance is invalid: ${String(row.id)}`)
  return {
    experienceID: experience.id,
    candidateID: row.candidate_id,
    summary: experience.summary,
    evidenceCount: experience.evidenceIDs.length,
    recordDigest: row.record_digest,
    policyVersion: row.policy_version,
    createdAt: row.time_created,
  }
}

const encodeExperience = (value: AgentRuntime.ExperienceRecord): unknown =>
  Schema.encodeUnknownSync(AgentRuntime.ExperienceRecord)(value)

const decodeExperience = (value: unknown): AgentRuntime.ExperienceRecord =>
  Schema.decodeUnknownSync(AgentRuntime.ExperienceRecord)(value)

const toCandidate = (row: CandidateRow): CandidateProjection => ({
  candidateID: row.id,
  problemSignature: row.problem_signature,
  applicableScope: row.applicable_scope,
  conditions: row.conditions,
  attemptedStrategy: row.attempted_strategy,
  counterexamples: row.counterexamples,
  supportCount: row.support_count,
  sourceRunIDs: row.source_run_ids,
  sourceSupportIDs: row.source_support_ids,
  evidenceIDs: row.evidence_ids,
  evaluationDigest: row.evaluation_digest ?? undefined,
  reviewActor: row.review_actor ?? undefined,
  reviewReason: row.review_reason ?? undefined,
  reviewStatus: row.review_status,
  status: row.status,
  policyVersion: row.policy_version,
  expiryAt: row.expiry_at ?? undefined,
  digest: row.digest,
  revision: row.revision,
  createdBy: row.created_by,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

const candidateDigest = (input: {
  readonly problemSignature: string
  readonly applicableScope: string
  readonly conditions: ReadonlyArray<string>
  readonly attemptedStrategy: string
  readonly counterexamples: ReadonlyArray<string>
  readonly sourceRunIDs: ReadonlyArray<AgentRuntime.RunID>
  readonly sourceSupportIDs: ReadonlyArray<string>
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly evaluationDigest?: string
  readonly reviewStatus: string
  readonly status: string
  readonly policyVersion: string
  readonly expiryAt?: number
}) => {
  const digest = canonicalHash(input)
  if (!digest) throw new Error("experience candidate is not canonicalizable")
  return digest
}

const candidateIDFor = (input: {
  readonly problemSignature: string
  readonly applicableScope: string
  readonly attemptedStrategy: string
  readonly policyVersion: string
}) => {
  const digest = canonicalHash(input)
  if (!digest) throw new Error("experience candidate identity is not canonicalizable")
  return `exc_${digest.slice(0, 24)}`
}

const supportDigest = (input: {
  readonly candidateID: string
  readonly runID: AgentRuntime.RunID
  readonly actionID: AgentRuntime.ActionID
  readonly evaluationID: AgentRuntime.EvaluationID
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly summary: string
}) => {
  const digest = canonicalHash(input)
  if (!digest) throw new Error("experience support is not canonicalizable")
  return digest
}

const auditPayload = (input: {
  readonly aggregateID: string
  readonly sequence: number
  readonly action: string
  readonly actor: string
  readonly reason: string
  readonly metadata: Record<string, unknown>
  readonly previousHash: string
}) => ({
  aggregate_id: input.aggregateID,
  sequence: input.sequence,
  action: input.action,
  actor: input.actor,
  reason: input.reason,
  metadata: input.metadata,
  previous_hash: input.previousHash,
})

const appendAudit = (
  tx: any,
  identity: TrustedExperienceIdentity,
  input: Omit<Parameters<typeof auditPayload>[0], "sequence" | "previousHash">,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const latest = yield* tx
      .select()
      .from(ExperienceAuditTable)
      .where(and(ownership(ExperienceAuditTable, identity), eq(ExperienceAuditTable.aggregate_id, input.aggregateID)))
      .orderBy(desc(ExperienceAuditTable.sequence))
      .get()
    const sequence = (latest?.sequence ?? 0) + 1
    const previousHash = latest?.record_hash ?? "genesis"
    const payload = auditPayload({ ...input, sequence, previousHash })
    const recordHash = canonicalHash(payload)
    if (!recordHash) throw new Error("experience audit event is not canonicalizable")
    yield* tx
      .insert(ExperienceAuditTable)
      .values({
        tenant_id: identity.tenantID,
        owner_user_id: identity.userID,
        aggregate_id: input.aggregateID,
        sequence,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata,
        previous_hash: previousHash,
        record_hash: recordHash,
      })
      .run()
  }) as Effect.Effect<void>

const evaluationPassed = (comparison: ExperienceEvaluation.Comparison) =>
  comparison.candidateExperience.metrics.sampleSize > 0 &&
  comparison.candidateVsWithout.successRate >= 0 &&
  comparison.candidateVsWithout.newFailureCount <= 0 &&
  comparison.candidateVsWithout.newFailureRate <= 0

const storeFailure = (error: unknown) => {
  if (
    error instanceof ExperienceStoreError ||
    error instanceof ExperienceStoreNotFoundError ||
    error instanceof ExperienceStoreConflictError
  )
    return error
  return new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) })
}

const supportFailure = (error: unknown) =>
  error instanceof ExperienceStoreError || error instanceof ExperienceStoreConflictError
    ? error
    : new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) })

/**
 * Transaction-bound admission Evidence writer used by the settlement
 * coordinator.  Validation of the Action/Observation and supporting
 * Evidence references still belongs to the normal ExperienceStore service;
 * this lower-level seam only materializes the deterministic receipt and
 * persists it on the caller's already-open transaction.
 */
export interface AdmissionEvidenceTransactionInput {
  readonly transaction: Database.Transaction
  readonly identity: TrustedExperienceIdentity
  readonly plan: AdmissionEvidence.Plan
  readonly actionID: AgentRuntime.ActionID
  readonly observation: AgentRuntime.Observation
}

const persistEvidenceOnTransaction = (
  transaction: Database.Transaction,
  identity: TrustedExperienceIdentity,
  evidence: AgentRuntime.Evidence,
  observationID: AgentRuntime.ObservationID,
): Effect.Effect<boolean, ExperienceStoreError | ExperienceStoreConflictError> =>
  Effect.gen(function* () {
    const encoded = encodeEvidence(evidence)
    const recordDigest = canonicalHash(encoded)
    if (!recordDigest || !DIGEST.test(recordDigest))
      return yield* new ExperienceStoreError({ reason: "evidence record is not canonically hashable" })
    const inserted = yield* transaction
      .insert(ExperienceEvidenceTable)
      .values({
        tenant_id: identity.tenantID,
        owner_user_id: identity.userID,
        id: evidence.id,
        run_id: evidence.runID!,
        action_id: evidence.actionID!,
        observation_id: observationID,
        record_digest: recordDigest,
        record: encoded,
      })
      .onConflictDoNothing()
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (inserted) return true
    const existing = yield* transaction
      .select()
      .from(ExperienceEvidenceTable)
      .where(and(ownership(ExperienceEvidenceTable, identity), eq(ExperienceEvidenceTable.id, evidence.id)))
      .get()
      .pipe(Effect.orDie)
    if (
      !existing ||
      existing.record_digest !== recordDigest ||
      String(existing.id) !== String(evidence.id) ||
      String(existing.run_id) !== String(evidence.runID) ||
      String(existing.action_id) !== String(evidence.actionID) ||
      String(existing.observation_id) !== String(observationID)
    )
      return yield* new ExperienceStoreConflictError({
        id: String(evidence.id),
        reason: "evidence ID already belongs to different immutable content",
      })
    return false
  })

const appendAdmissionAuditOnTransaction = (
  transaction: Database.Transaction,
  identity: TrustedExperienceIdentity,
  materialized: AdmissionEvidence.Materialized,
  plan: AdmissionEvidence.Plan,
  actionID: AgentRuntime.ActionID,
): Effect.Effect<void, ExperienceStoreError> =>
  Effect.gen(function* () {
    const aggregateID = String(materialized.evidence.id)
    const latest = yield* transaction
      .select()
      .from(ExperienceAuditTable)
      .where(and(ownership(ExperienceAuditTable, identity), eq(ExperienceAuditTable.aggregate_id, aggregateID)))
      .orderBy(desc(ExperienceAuditTable.sequence))
      .get()
      .pipe(Effect.orDie)
    const sequence = (latest?.sequence ?? 0) + 1
    const previousHash = latest?.record_hash ?? "genesis"
    const metadata = {
      runID: plan.childRunID,
      actionID,
      observationID: materialized.observationID,
      evidenceID: materialized.evidence.id,
      recordDigest: materialized.recordDigest,
    }
    const payload = auditPayload({
      aggregateID,
      sequence,
      action: "admission-evidence.written",
      actor: identity.actor,
      reason: "Persisted payload-free custom-agent admission Evidence",
      metadata,
      previousHash,
    })
    const recordHash = canonicalHash(payload)
    if (!recordHash) return yield* new ExperienceStoreError({ reason: "experience audit event is not canonicalizable" })
    yield* transaction
      .insert(ExperienceAuditTable)
      .values({
        tenant_id: identity.tenantID,
        owner_user_id: identity.userID,
        aggregate_id: aggregateID,
        sequence,
        action: "admission-evidence.written",
        actor: identity.actor,
        reason: "Persisted payload-free custom-agent admission Evidence",
        metadata,
        previous_hash: previousHash,
        record_hash: recordHash,
      })
      .run()
      .pipe(Effect.orDie)
  })

export const recordAdmissionEvidenceInTransaction = Effect.fn("ExperienceStore.recordAdmissionEvidenceInTransaction")(
  function* (input: AdmissionEvidenceTransactionInput) {
    let identity: TrustedExperienceIdentity
    let materialized: AdmissionEvidence.Materialized
    try {
      identity = normalizeIdentity(input.identity)
      if (
        input.plan.identity.tenantID !== identity.tenantID ||
        input.plan.identity.userID !== identity.userID ||
        input.plan.identity.actor !== identity.actor
      )
        return yield* new ExperienceStoreError({ reason: "admission Evidence transaction identity drifted" })
      materialized = AdmissionEvidence.materialize({
        plan: input.plan,
        actionID: input.actionID,
        observation: input.observation,
      })
    } catch (error) {
      return yield* new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) })
    }
    const inserted = yield* persistEvidenceOnTransaction(
      input.transaction,
      identity,
      materialized.evidence,
      materialized.observationID,
    )
    if (inserted)
      yield* appendAdmissionAuditOnTransaction(input.transaction, identity, materialized, input.plan, input.actionID)
    return {
      evidenceID: materialized.evidence.id,
      runID: materialized.evidence.runID!,
      actionID: materialized.evidence.actionID!,
      observationID: materialized.observationID,
      recordDigest: materialized.recordDigest,
      inserted,
    } satisfies AdmissionEvidenceProjection
  },
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const runs = yield* DurableRun.Service
    const actions = yield* DurableAction.Service
    const evaluations = yield* RuntimeEvaluation.Service
    const learning = yield* LearningV2.Service

    const asPrincipal = <A, E>(
      identity: TrustedExperienceIdentity,
      effect: (normalized: TrustedExperienceIdentity) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | ExperienceStoreError> => {
      let normalized: TrustedExperienceIdentity
      try {
        normalized = normalizeIdentity(identity)
      } catch (error) {
        return Effect.fail(new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) }))
      }
      return database.runAsPrincipal(normalized, effect(normalized))
    }

    const getCandidateRow = (identity: TrustedExperienceIdentity, candidateID: string) =>
      db
        .select()
        .from(ExperienceCandidateTable)
        .where(and(ownership(ExperienceCandidateTable, identity), eq(ExperienceCandidateTable.id, candidateID)))
        .get()
        .pipe(Effect.orDie)

    const persistEvidence = (
      executor: QueryDatabase,
      identity: TrustedExperienceIdentity,
      evidence: AgentRuntime.Evidence,
      observationID: AgentRuntime.ObservationID,
    ): Effect.Effect<boolean, ExperienceStoreConflictError> =>
      Effect.gen(function* () {
        const encoded = encodeEvidence(evidence)
        const digest = canonicalHash(encoded)
        if (!digest || !DIGEST.test(digest)) throw new Error("evidence record is not canonicalizable")
        const inserted = yield* executor
          .insert(ExperienceEvidenceTable)
          .values({
            tenant_id: identity.tenantID,
            owner_user_id: identity.userID,
            id: evidence.id,
            run_id: evidence.runID!,
            action_id: evidence.actionID!,
            observation_id: observationID,
            record_digest: digest,
            record: encoded,
          })
          .onConflictDoNothing()
          .returning()
          .get()
          .pipe(Effect.orDie)
        if (inserted) return true
        const existing = yield* executor
          .select()
          .from(ExperienceEvidenceTable)
          .where(and(ownership(ExperienceEvidenceTable, identity), eq(ExperienceEvidenceTable.id, evidence.id)))
          .get()
          .pipe(Effect.orDie)
        if (
          !existing ||
          existing.record_digest !== digest ||
          String(existing.id) !== String(evidence.id) ||
          String(existing.run_id) !== String(evidence.runID) ||
          String(existing.action_id) !== String(evidence.actionID) ||
          String(existing.observation_id) !== String(observationID)
        )
          return yield* new ExperienceStoreConflictError({
            id: String(evidence.id),
            reason: "evidence ID already belongs to different immutable content",
          })
        return false
      })

    const validateVerifiedEvidence = (
      identity: TrustedExperienceIdentity,
      input: RecordVerifiedEvidenceInput,
    ): Effect.Effect<
      {
        readonly action: Effect.Success<ReturnType<DurableAction.Interface["load"]>>
        readonly evaluation: NonNullable<Effect.Success<ReturnType<RuntimeEvaluation.Interface["get"]>>>
        readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
        readonly observationID: AgentRuntime.ObservationID
        readonly evidence: ReadonlyArray<AgentRuntime.Evidence>
      },
      ExperienceStoreError
    > =>
      Effect.gen(function* () {
        const run = yield* runs
          .load(input.runID)
          .pipe(Effect.mapError((error) => new ExperienceStoreError({ reason: String(error) })))
        if (run.run.status !== "completed")
          return yield* new ExperienceStoreError({ reason: "experience support requires a completed durable Run" })
        const action = yield* actions
          .load(input.actionID)
          .pipe(Effect.mapError((error) => new ExperienceStoreError({ reason: String(error) })))
        if (action.action.runID !== input.runID || action.action.status !== "settled" || !action.observation)
          return yield* new ExperienceStoreError({
            reason: "experience support requires a settled Action belonging to the completed Run",
          })
        if (action.observation.status !== "succeeded")
          return yield* new ExperienceStoreError({
            reason: "only succeeded observations may support reusable Experience",
          })
        const evaluation = yield* evaluations.get(input.evaluationID)
        if (!evaluation || evaluation.runID !== input.runID || !evaluation.passed)
          return yield* new ExperienceStoreError({
            reason: "experience support requires a passed canonical EvaluationResult for the same Run",
          })
        if (input.evidence.length === 0)
          return yield* new ExperienceStoreError({ reason: "experience support requires verifier Evidence" })
        const evidenceIDs = input.evidence.map((item) => item.id).toSorted((a, b) => String(a).localeCompare(String(b)))
        if (new Set(evidenceIDs.map(String)).size !== evidenceIDs.length)
          return yield* new ExperienceStoreError({ reason: "experience support contains duplicate Evidence IDs" })
        const evaluatedEvidence = [...evaluation.evidenceIDs].toSorted((a, b) => String(a).localeCompare(String(b)))
        if (evidenceIDs.map(String).join("\u0000") !== evaluatedEvidence.map(String).join("\u0000"))
          return yield* new ExperienceStoreError({
            reason: "Experience Evidence must exactly match the canonical EvaluationResult evidence set",
          })
        for (const evidence of input.evidence) {
          if (
            evidence.runID !== input.runID ||
            evidence.actionID !== input.actionID ||
            evidence.verificationStatus !== "verified" ||
            (evidence.trust !== "verified" && evidence.trust !== "trusted") ||
            evidence.instructionAllowed ||
            !evidence.source.startsWith("verifier:") ||
            evidence.extractionMethod !== "verifier-registry" ||
            !evidence.contentDigest ||
            !evidence.extractionMethod ||
            !evidence.extractionVersion ||
            !evidence.observationIDs?.some((id) => id === action.observation!.id)
          )
            return yield* new ExperienceStoreError({
              reason: "Evidence must be verified, non-instructional, and bound to the same Run/Action/Observation",
            })
        }
        return { action, evaluation, evidenceIDs, observationID: action.observation.id, evidence: input.evidence }
      })

    const persistEvidenceBatch = (
      identity: TrustedExperienceIdentity,
      evidence: ReadonlyArray<AgentRuntime.Evidence>,
      observationID: AgentRuntime.ObservationID,
    ): Effect.Effect<ReadonlyArray<AgentRuntime.EvidenceID>, ExperienceStoreError | ExperienceStoreConflictError> =>
      db
        .transaction((tx) =>
          Effect.forEach(evidence, (item) => persistEvidence(tx, identity, item, observationID), {
            concurrency: 1,
          }).pipe(Effect.map((inserted) => evidence.filter((_item, index) => inserted[index]).map((item) => item.id))),
        )
        .pipe(Effect.mapError(supportFailure))

    const cleanupInsertedEvidence = (
      identity: TrustedExperienceIdentity,
      evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>,
    ) =>
      Effect.gen(function* () {
        if (evidenceIDs.length === 0) return
        const supports = yield* db
          .select()
          .from(ExperienceSupportTable)
          .where(ownership(ExperienceSupportTable, identity))
          .all()
          .pipe(Effect.orDie)
        const referenced = new Set(supports.flatMap((support) => support.evidence_ids.map(String)))
        const removable = evidenceIDs.filter((id) => !referenced.has(String(id)))
        if (removable.length === 0) return
        yield* db
          .delete(ExperienceEvidenceTable)
          .where(and(ownership(ExperienceEvidenceTable, identity), inArray(ExperienceEvidenceTable.id, removable)))
          .run()
          .pipe(Effect.orDie)
      })

    const recordVerifiedEvidence: Interface["recordVerifiedEvidence"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        validateVerifiedEvidence(identity, input).pipe(
          Effect.flatMap(({ evidenceIDs, observationID, evidence }) =>
            persistEvidenceBatch(identity, evidence, observationID).pipe(
              Effect.as({
                runID: input.runID,
                actionID: input.actionID,
                observationID,
                evaluationID: input.evaluationID,
                evidenceIDs,
              }),
            ),
          ),
          Effect.mapError(supportFailure),
        ),
      )

    const recordAdmissionEvidence: Interface["recordAdmissionEvidence"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          let plan: AdmissionEvidence.Plan
          try {
            plan = AdmissionEvidence.plan({ ...input, identity })
          } catch (error) {
            return yield* new ExperienceStoreError({
              reason: error instanceof Error ? error.message : String(error),
            })
          }

          const run = yield* runs
            .load(plan.childRunID)
            .pipe(
              Effect.mapError(
                (error) => new ExperienceStoreError({ reason: `admission child run is unavailable: ${String(error)}` }),
              ),
            )
          if (!("sessionID" in run.run) || run.run.child === undefined)
            return yield* new ExperienceStoreError({
              reason: "admission Evidence requires a durable SessionRun child binding",
            })
          const binding = run.run.child
          if (binding.parentRunID !== plan.parentRunID || binding.idempotencyKey !== input.idempotencyKey)
            return yield* new ExperienceStoreError({
              reason: "admission Evidence parent/idempotency binding does not match the durable child",
            })
          if (binding.runtimeAdmission === undefined)
            return yield* new ExperienceStoreError({
              reason: "admission Evidence requires the immutable runtime admission receipt on the child",
            })

          let bindingPlan: AdmissionEvidence.Plan
          try {
            bindingPlan = AdmissionEvidence.plan({
              identity,
              parentRunID: binding.parentRunID,
              childRunID: plan.childRunID,
              idempotencyKey: binding.idempotencyKey,
              admission: binding.runtimeAdmission.evidence,
              evidenceRefs: binding.runtimeAdmission.evidenceRefs,
            })
          } catch (error) {
            return yield* new ExperienceStoreError({
              reason: `durable child admission receipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
          if (
            bindingPlan.evidenceID !== plan.evidenceID ||
            bindingPlan.admissionDigest !== plan.admissionDigest ||
            bindingPlan.idempotencyDigest !== plan.idempotencyDigest
          )
            return yield* new ExperienceStoreError({
              reason: "admission Evidence plan does not match the immutable child admission receipt",
            })

          // Supporting references use the same payload-free resolver as all
          // other Evidence consumers. A missing, duplicate, malformed, or
          // cross-owner reference blocks the admission write; the writer
          // never invents a second existence check.
          if (plan.evidenceRefs.length > 0) {
            const references = yield* resolveEvidenceIDs(identity, plan.evidenceRefs)
            if (!references.valid || references.present.length !== plan.evidenceRefs.length)
              return yield* new ExperienceStoreError({
                reason: "admission Evidence supporting references are not all present and valid",
              })
          }

          const action = yield* actions
            .load(input.actionID)
            .pipe(
              Effect.mapError(
                (error) => new ExperienceStoreError({ reason: `admission Action is unavailable: ${String(error)}` }),
              ),
            )
          if (
            action.action.runID !== plan.childRunID ||
            action.action.status !== "settled" ||
            action.observation === undefined
          )
            return yield* new ExperienceStoreError({
              reason: "admission Evidence requires a settled Action belonging to the admitted child",
            })

          return yield* db
            .transaction((transaction) =>
              recordAdmissionEvidenceInTransaction({
                transaction,
                identity,
                plan,
                actionID: input.actionID,
                observation: action.observation!,
              }),
            )
            .pipe(Effect.mapError(supportFailure))
        }),
      )

    const recordVerifiedSupport: Interface["recordVerifiedSupport"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          let problemSignature: string
          let applicableScope: string
          let conditions: ReadonlyArray<string>
          let attemptedStrategy: string
          let summary: string
          let policyVersion: string
          let counterexample: string | undefined
          try {
            problemSignature = bounded(input.problemSignature, "problemSignature", 500)
            applicableScope = bounded(input.applicableScope, "applicableScope", 500)
            conditions = unique(input.conditions, "condition", 500)
            attemptedStrategy = bounded(input.attemptedStrategy, "attemptedStrategy", 2_000)
            summary = bounded(input.summary, "summary", 2_000)
            policyVersion = bounded(input.policyVersion, "policyVersion", 120)
            counterexample = input.counterexample ? bounded(input.counterexample, "counterexample", 500) : undefined
            if (input.expiryAt !== undefined && (!Number.isSafeInteger(input.expiryAt) || input.expiryAt <= Date.now()))
              throw new Error("expiryAt must be a future integer timestamp")
          } catch (error) {
            return yield* new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) })
          }
          const candidateID =
            input.candidateID?.trim() ||
            candidateIDFor({ problemSignature, applicableScope, attemptedStrategy, policyVersion })
          if (!/^exc_[A-Za-z0-9_-]{8,255}$/.test(candidateID))
            return yield* new ExperienceStoreError({ reason: "candidateID is invalid" })
          const verified = yield* validateVerifiedEvidence(identity, input)
          const insertedEvidenceIDs = yield* persistEvidenceBatch(identity, verified.evidence, verified.observationID)
          const digest = supportDigest({
            candidateID,
            runID: input.runID,
            actionID: input.actionID,
            evaluationID: input.evaluationID,
            evidenceIDs: verified.evidenceIDs,
            summary,
          })
          const supportID = `exs_${digest.slice(0, 24)}`
          const existingSupport = yield* db
            .select()
            .from(ExperienceSupportTable)
            .where(
              and(
                ownership(ExperienceSupportTable, identity),
                eq(ExperienceSupportTable.candidate_id, candidateID),
                eq(ExperienceSupportTable.run_id, input.runID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (existingSupport) {
            if (existingSupport.support_digest !== digest)
              return yield* new ExperienceStoreConflictError({
                id: existingSupport.id,
                reason: "the same Run cannot support a candidate with different content",
              })
            const existingCandidate = yield* getCandidateRow(identity, candidateID)
            if (!existingCandidate)
              return yield* new ExperienceStoreError({ reason: "idempotent support lost its candidate projection" })
            if (
              existingCandidate.problem_signature !== problemSignature ||
              existingCandidate.applicable_scope !== applicableScope ||
              existingCandidate.attempted_strategy !== attemptedStrategy ||
              existingCandidate.policy_version !== policyVersion ||
              existingCandidate.conditions.join("\u0000") !== conditions.join("\u0000") ||
              (counterexample !== undefined && !existingCandidate.counterexamples.includes(counterexample))
            )
              return yield* new ExperienceStoreConflictError({
                id: existingSupport.id,
                reason: "idempotent support replay changed immutable candidate material",
              })
            return toCandidate(existingCandidate)
          }
          const outcome = yield* learning
            .recordVerified({
              userInput: summary,
              intent: problemSignature,
              route: "experience-kernel",
              runID: input.runID,
              actionID: input.actionID,
              evaluationID: input.evaluationID,
              evidenceIDs: verified.evidenceIDs.map(String),
              terminal: true,
              verifierPassed: true,
              outcome: "success",
              tags: ["verified-experience", `candidate:${candidateID}`],
              fingerprint: `experience-support:${digest}`,
            })
            .pipe(
              Effect.catch((error) =>
                cleanupInsertedEvidence(identity, insertedEvidenceIDs).pipe(
                  Effect.andThen(Effect.fail(new ExperienceStoreError({ reason: error.reason }))),
                ),
              ),
            )

          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* tx
                  .select()
                  .from(ExperienceCandidateTable)
                  .where(
                    and(ownership(ExperienceCandidateTable, identity), eq(ExperienceCandidateTable.id, candidateID)),
                  )
                  .get()
                if (current) {
                  if (
                    current.problem_signature !== problemSignature ||
                    current.applicable_scope !== applicableScope ||
                    current.attempted_strategy !== attemptedStrategy ||
                    current.policy_version !== policyVersion ||
                    current.conditions.join("\u0000") !== conditions.join("\u0000")
                  )
                    return yield* new ExperienceStoreConflictError({
                      id: candidateID,
                      reason: "candidate identity already belongs to different immutable problem material",
                    })
                  if (current.status !== "candidate")
                    return yield* new ExperienceStoreConflictError({
                      id: candidateID,
                      reason: "only candidate status may receive support",
                    })
                  const sourceRunIDs = [...current.source_run_ids, input.runID].toSorted((a, b) =>
                    String(a).localeCompare(String(b)),
                  )
                  const sourceSupportIDs = [...current.source_support_ids, supportID].toSorted()
                  const evidenceIDs = [...new Set([...current.evidence_ids, ...verified.evidenceIDs])].toSorted(
                    (a, b) => String(a).localeCompare(String(b)),
                  )
                  const counterexamples = counterexample
                    ? [...new Set([...current.counterexamples, counterexample])].toSorted()
                    : current.counterexamples
                  const nextDigest = candidateDigest({
                    problemSignature,
                    applicableScope,
                    conditions,
                    attemptedStrategy,
                    counterexamples,
                    sourceRunIDs,
                    sourceSupportIDs,
                    evidenceIDs,
                    evaluationDigest: current.evaluation_digest ?? undefined,
                    reviewStatus: current.review_status,
                    status: current.status,
                    policyVersion,
                    expiryAt: current.expiry_at ?? undefined,
                  })
                  const next = yield* tx
                    .update(ExperienceCandidateTable)
                    .set({
                      counterexamples,
                      support_count: current.support_count + 1,
                      source_run_ids: sourceRunIDs,
                      source_support_ids: sourceSupportIDs,
                      evidence_ids: evidenceIDs,
                      digest: nextDigest,
                      revision: current.revision + 1,
                    })
                    .where(
                      and(
                        ownership(ExperienceCandidateTable, identity),
                        eq(ExperienceCandidateTable.id, candidateID),
                        eq(ExperienceCandidateTable.revision, current.revision),
                      ),
                    )
                    .returning()
                    .get()
                  if (!next)
                    return yield* new ExperienceStoreConflictError({
                      id: candidateID,
                      reason: "candidate changed while support was recorded",
                    })
                  return next
                }
                const sourceRunIDs = [input.runID]
                const sourceSupportIDs = [supportID]
                const evidenceIDs = [...verified.evidenceIDs]
                const counterexamples = counterexample ? [counterexample] : []
                const initialDigest = candidateDigest({
                  problemSignature,
                  applicableScope,
                  conditions,
                  attemptedStrategy,
                  counterexamples,
                  sourceRunIDs,
                  sourceSupportIDs,
                  evidenceIDs,
                  reviewStatus: "pending",
                  status: "candidate",
                  policyVersion,
                  expiryAt: input.expiryAt,
                })
                return yield* tx
                  .insert(ExperienceCandidateTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    id: candidateID,
                    problem_signature: problemSignature,
                    applicable_scope: applicableScope,
                    conditions,
                    attempted_strategy: attemptedStrategy,
                    counterexamples,
                    support_count: 1,
                    source_run_ids: sourceRunIDs,
                    source_support_ids: sourceSupportIDs,
                    evidence_ids: evidenceIDs,
                    review_status: "pending",
                    status: "candidate",
                    policy_version: policyVersion,
                    expiry_at: input.expiryAt ?? null,
                    digest: initialDigest,
                    revision: 1,
                    created_by: identity.actor,
                  })
                  .returning()
                  .get()
              }).pipe(
                Effect.flatMap((candidate) =>
                  Effect.gen(function* () {
                    yield* tx
                      .insert(ExperienceSupportTable)
                      .values({
                        tenant_id: identity.tenantID,
                        owner_user_id: identity.userID,
                        id: supportID,
                        candidate_id: candidateID,
                        run_id: input.runID,
                        action_id: input.actionID,
                        evaluation_id: input.evaluationID,
                        evidence_ids: verified.evidenceIDs,
                        summary,
                        support_digest: digest,
                        learning_outcome_id: outcome.id,
                      })
                      .run()
                    yield* appendAudit(tx, identity, {
                      aggregateID: candidateID,
                      action: "verified_support_recorded",
                      actor: identity.actor,
                      reason: "completed Run, settled Action, verifier Evidence, and EvaluationResult verified",
                      metadata: { supportID, runID: input.runID, evaluationID: input.evaluationID, digest },
                    })
                    return candidate
                  }),
                ),
              ),
            )
            .pipe(
              Effect.catch((error) =>
                learning.undo(outcome.id).pipe(
                  Effect.catchCause(() =>
                    Effect.fail(
                      new ExperienceStoreError({
                        reason: `support transaction failed and learning compensation could not be confirmed: ${
                          error instanceof Error ? error.message : String(error)
                        }`,
                      }),
                    ),
                  ),
                  Effect.andThen(cleanupInsertedEvidence(identity, insertedEvidenceIDs)),
                  Effect.andThen(Effect.fail(supportFailure(error))),
                ),
              ),
            )
          return toCandidate(updated)
        }),
      )

    const recordEvaluation: Interface["recordEvaluation"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const current = yield* getCandidateRow(identity, input.candidateID)
          if (!current) return yield* new ExperienceStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          let comparison: ExperienceEvaluation.Comparison
          try {
            comparison = ExperienceEvaluation.compare(input.observations)
          } catch (error) {
            return yield* new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) })
          }
          const digest = canonicalHash(comparison)
          if (!digest)
            return yield* new ExperienceStoreError({ reason: "experience evaluation is not canonicalizable" })
          if (current.evaluation_digest === digest && current.revision === input.expectedRevision + 1)
            return toCandidate(current)
          if (current.revision !== input.expectedRevision || current.status !== "candidate")
            return yield* new ExperienceStoreConflictError({
              id: input.candidateID,
              reason: `candidate revision/status conflict: expected ${input.expectedRevision}/candidate, actual ${current.revision}/${current.status}`,
            })
          const passed = evaluationPassed(comparison)
          const evaluationID = `xee_${digest.slice(0, 24)}`
          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(ExperienceEvaluationTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    id: evaluationID,
                    candidate_id: input.candidateID,
                    evaluation_digest: digest,
                    comparison,
                    passed,
                    created_by: identity.actor,
                  })
                  .onConflictDoNothing()
                  .run()
                const nextDigest = candidateDigest({
                  problemSignature: current.problem_signature,
                  applicableScope: current.applicable_scope,
                  conditions: current.conditions,
                  attemptedStrategy: current.attempted_strategy,
                  counterexamples: current.counterexamples,
                  sourceRunIDs: current.source_run_ids,
                  sourceSupportIDs: current.source_support_ids,
                  evidenceIDs: current.evidence_ids,
                  evaluationDigest: digest,
                  reviewStatus: current.review_status,
                  status: current.status,
                  policyVersion: current.policy_version,
                  expiryAt: current.expiry_at ?? undefined,
                })
                const next = yield* tx
                  .update(ExperienceCandidateTable)
                  .set({ evaluation_digest: digest, digest: nextDigest, revision: current.revision + 1 })
                  .where(
                    and(
                      ownership(ExperienceCandidateTable, identity),
                      eq(ExperienceCandidateTable.id, input.candidateID),
                      eq(ExperienceCandidateTable.revision, input.expectedRevision),
                    ),
                  )
                  .returning()
                  .get()
                if (!next)
                  return yield* new ExperienceStoreConflictError({
                    id: input.candidateID,
                    reason: "candidate changed while evaluation was recorded",
                  })
                yield* appendAudit(tx, identity, {
                  aggregateID: input.candidateID,
                  action: "offline_evaluation_recorded",
                  actor: identity.actor,
                  reason: passed ? "offline replay passed" : "offline replay failed",
                  metadata: { evaluationID, digest, passed },
                })
                return next
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return toCandidate(updated)
        }),
      )

    const review: Interface["review"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const reason = yield* Effect.try({
            try: () => bounded(input.reason, "reason", 500),
            catch: (error) =>
              new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) }),
          })
          if (!humanActor(identity.actor))
            return yield* new ExperienceStoreError({ reason: "Experience review requires a trusted human actor" })
          const current = yield* getCandidateRow(identity, input.candidateID)
          if (!current) return yield* new ExperienceStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          if (
            current.revision === input.expectedRevision + 1 &&
            ((input.decision === "approve" && current.status === "active") ||
              (input.decision === "reject" && current.status === "rejected")) &&
            current.review_actor === identity.actor &&
            current.review_reason === reason
          ) {
            const replayRecords = yield* db
              .select()
              .from(ExperienceRecordTable)
              .where(
                and(
                  ownership(ExperienceRecordTable, identity),
                  eq(ExperienceRecordTable.candidate_id, input.candidateID),
                ),
              )
              .orderBy(asc(ExperienceRecordTable.id))
              .all()
              .pipe(Effect.orDie)
            const experiences = replayRecords.map((row) => decodeExperience(row.record))
            const receiptDigest = canonicalHash({
              candidateID: input.candidateID,
              candidateDigest: current.digest,
              actor: identity.actor,
              decision: input.decision,
              experienceIDs: experiences.map((item) => item.id),
            })!
            return { candidate: toCandidate(current), experiences, receiptDigest }
          }
          if (current.revision !== input.expectedRevision || current.status !== "candidate")
            return yield* new ExperienceStoreConflictError({
              id: input.candidateID,
              reason: `candidate revision/status conflict: expected ${input.expectedRevision}/candidate, actual ${current.revision}/${current.status}`,
            })
          const now = Date.now()
          if (current.expiry_at !== null && current.expiry_at <= now)
            return yield* new ExperienceStoreError({ reason: "expired Experience candidates cannot be reviewed" })
          const evaluation = current.evaluation_digest
            ? yield* db
                .select()
                .from(ExperienceEvaluationTable)
                .where(
                  and(
                    ownership(ExperienceEvaluationTable, identity),
                    eq(ExperienceEvaluationTable.candidate_id, input.candidateID),
                    eq(ExperienceEvaluationTable.evaluation_digest, current.evaluation_digest),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
            : undefined
          if (
            input.decision === "approve" &&
            (current.support_count < MINIMUM_SUPPORT || !evaluation || !evaluation.passed)
          )
            return yield* new ExperienceStoreError({
              reason: `approval requires ${MINIMUM_SUPPORT} distinct verified Runs and a passed offline replay`,
            })
          const supports = yield* db
            .select()
            .from(ExperienceSupportTable)
            .where(
              and(
                ownership(ExperienceSupportTable, identity),
                eq(ExperienceSupportTable.candidate_id, input.candidateID),
              ),
            )
            .orderBy(asc(ExperienceSupportTable.id))
            .all()
            .pipe(Effect.orDie)
          if (supports.length !== current.support_count)
            return yield* new ExperienceStoreError({ reason: "candidate support projection is inconsistent" })
          const status = input.decision === "approve" ? ("active" as const) : ("rejected" as const)
          const reviewStatus = input.decision === "approve" ? ("approved" as const) : ("rejected" as const)
          const records =
            input.decision === "approve" ? supports.map((support) => experienceFromSupport(support, now)) : []
          const nextDigest = candidateDigest({
            problemSignature: current.problem_signature,
            applicableScope: current.applicable_scope,
            conditions: current.conditions,
            attemptedStrategy: current.attempted_strategy,
            counterexamples: current.counterexamples,
            sourceRunIDs: current.source_run_ids,
            sourceSupportIDs: current.source_support_ids,
            evidenceIDs: current.evidence_ids,
            evaluationDigest: current.evaluation_digest ?? undefined,
            reviewStatus,
            status,
            policyVersion: current.policy_version,
            expiryAt: current.expiry_at ?? undefined,
          })
          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                for (const item of records) {
                  const encoded = encodeExperience(item.record)
                  yield* tx
                    .insert(ExperienceRecordTable)
                    .values({
                      tenant_id: identity.tenantID,
                      owner_user_id: identity.userID,
                      id: item.record.id,
                      candidate_id: input.candidateID,
                      support_id: item.support.id,
                      run_id: item.support.run_id,
                      action_id: item.support.action_id,
                      evaluation_id: item.support.evaluation_id,
                      evidence_ids: item.support.evidence_ids,
                      record_digest: canonicalHash(encoded)!,
                      record: encoded,
                      policy_version: current.policy_version,
                      promoted_by: identity.actor,
                    })
                    .onConflictDoNothing()
                    .run()
                }
                const next = yield* tx
                  .update(ExperienceCandidateTable)
                  .set({
                    review_actor: identity.actor,
                    review_reason: reason,
                    review_status: reviewStatus,
                    status,
                    digest: nextDigest,
                    revision: current.revision + 1,
                  })
                  .where(
                    and(
                      ownership(ExperienceCandidateTable, identity),
                      eq(ExperienceCandidateTable.id, input.candidateID),
                      eq(ExperienceCandidateTable.revision, input.expectedRevision),
                    ),
                  )
                  .returning()
                  .get()
                if (!next)
                  return yield* new ExperienceStoreConflictError({
                    id: input.candidateID,
                    reason: "candidate changed while review was recorded",
                  })
                yield* appendAudit(tx, identity, {
                  aggregateID: input.candidateID,
                  action: input.decision === "approve" ? "experience_promoted" : "experience_rejected",
                  actor: identity.actor,
                  reason,
                  metadata: {
                    fromRevision: current.revision,
                    toRevision: current.revision + 1,
                    evaluationDigest: current.evaluation_digest,
                    experienceIDs: records.map((item) => item.record.id),
                  },
                })
                return next
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          const receiptDigest = canonicalHash({
            candidateID: input.candidateID,
            candidateDigest: updated.digest,
            actor: identity.actor,
            decision: input.decision,
            experienceIDs: records.map((item) => item.record.id),
          })!
          return { candidate: toCandidate(updated), experiences: records.map((item) => item.record), receiptDigest }
        }),
      )

    const getCandidate: Interface["getCandidate"] = (identity, candidateID) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const row = yield* getCandidateRow(normalized, candidateID)
          if (!row) return yield* new ExperienceStoreNotFoundError({ kind: "candidate", id: candidateID })
          return toCandidate(row)
        }),
      )

    const listCandidates: Interface["listCandidates"] = (identity, input = {}) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
          const rows = yield* db
            .select()
            .from(ExperienceCandidateTable)
            .where(
              and(
                ownership(ExperienceCandidateTable, normalized),
                input.status ? eq(ExperienceCandidateTable.status, input.status) : undefined,
              ),
            )
            .orderBy(desc(ExperienceCandidateTable.time_updated))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
          return rows.map(toCandidate)
        }),
      )

    const listSources: Interface["listSources"] = (identity, input = {}) =>
      asPrincipal<ReadonlyArray<ExperienceSourceProjection>, ExperienceStoreError>(identity, (normalized) =>
        Effect.gen(function* () {
          const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
          const rows = yield* db
            .select()
            .from(ExperienceRecordTable)
            .where(ownership(ExperienceRecordTable, normalized))
            .orderBy(desc(ExperienceRecordTable.time_created), asc(ExperienceRecordTable.id))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
          return yield* Effect.try({
            try: () => rows.map(toExperienceSource),
            catch: (error) =>
              new ExperienceStoreError({ reason: error instanceof Error ? error.message : String(error) }),
          })
        }),
      )

    const resolveEvidenceFacts: Interface["resolveEvidenceFacts"] = (identity, evidenceIDs) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          // Validate shape before touching storage. This keeps malformed or
          // over-bounded requests deterministic and avoids constructing a
          // dynamic SQL IN clause from untrusted values.
          const shape = EvidenceV2.resolveReferenceSet(evidenceIDs, new Set())
          if (
            shape.requested.length === 0 ||
            shape.invalid.length > 0 ||
            shape.duplicate.length > 0 ||
            shape.requested.length > 32
          )
            return Object.freeze({ resolution: shape, recordDigests: Object.freeze([]) })
          const ids = evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(String(id)))
          const rows = yield* db
            .select()
            .from(ExperienceEvidenceTable)
            .where(and(ownership(ExperienceEvidenceTable, normalized), inArray(ExperienceEvidenceTable.id, ids)))
            .all()
            .pipe(Effect.orDie)
          const available = new Set<string>()
          const digests = new Map<string, string>()
          for (const row of rows) {
            let decoded: AgentRuntime.Evidence
            try {
              decoded = decodeEvidence(row.record)
            } catch (error) {
              return yield* new ExperienceStoreError({
                reason: `Evidence record cannot be decoded: ${String(row.id)} (${String(error)})`,
              })
            }
            const recordDigest = canonicalHash(encodeEvidence(decoded))
            if (!recordDigest || row.record_digest !== recordDigest || String(decoded.id) !== String(row.id))
              return yield* new ExperienceStoreError({
                reason: `Evidence record provenance is invalid: ${String(row.id)}`,
              })
            available.add(String(row.id))
            digests.set(String(row.id), recordDigest)
          }
          const resolution = EvidenceV2.resolveReferenceSet(evidenceIDs, available)
          const recordDigests = resolution.present
            .map((id) => {
              const recordDigest = digests.get(String(id))
              return recordDigest === undefined ? undefined : Object.freeze({ evidenceID: id, recordDigest })
            })
            .filter(
              (value): value is { readonly evidenceID: AgentRuntime.EvidenceID; readonly recordDigest: string } =>
                value !== undefined,
            )
          return Object.freeze({ resolution, recordDigests: Object.freeze(recordDigests) })
        }),
      )

    const resolveEvidenceIDs: Interface["resolveEvidenceIDs"] = (identity, evidenceIDs) =>
      resolveEvidenceFacts(identity, evidenceIDs).pipe(Effect.map(({ resolution }) => resolution))

    const loadProvenance: Interface["loadProvenance"] = (identity, experienceIDs) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const ids = [...new Set(experienceIDs.map(String))].toSorted()
          if (ids.length === 0 || ids.length > 20 || ids.some((id) => !id.startsWith("exp_")))
            return yield* new ExperienceStoreError({ reason: "1-20 unique Experience IDs are required" })
          const rows = yield* db
            .select()
            .from(ExperienceRecordTable)
            .where(
              and(
                ownership(ExperienceRecordTable, normalized),
                inArray(
                  ExperienceRecordTable.id,
                  ids.map((id) => AgentRuntime.ExperienceID.make(id)),
                ),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (rows.length !== ids.length)
            return yield* new ExperienceStoreNotFoundError({ kind: "experience", id: ids.join(",") })
          const ordered = rows.toSorted((left, right) => String(left.id).localeCompare(String(right.id)))
          const experiences = ordered.map((row) => decodeExperience(row.record))
          for (const [index, row] of ordered.entries()) {
            const experience = experiences[index]!
            const encoded = encodeExperience(experience)
            const expectedEvidenceIDs = row.evidence_ids.map(String).toSorted().join("\u0000")
            const actualEvidenceIDs = experience.evidenceIDs.map(String).toSorted().join("\u0000")
            if (
              !experience.reusable ||
              String(experience.id) !== String(row.id) ||
              String(experience.runID) !== String(row.run_id) ||
              expectedEvidenceIDs !== actualEvidenceIDs ||
              row.record_digest !== canonicalHash(encoded)
            )
              return yield* new ExperienceStoreError({
                reason: `Experience record provenance is invalid: ${String(row.id)}`,
              })
          }
          const evidenceIDs = [...new Set(ordered.flatMap((row) => row.evidence_ids.map(String)))].toSorted()
          const evidenceRows = yield* db
            .select()
            .from(ExperienceEvidenceTable)
            .where(
              and(
                ownership(ExperienceEvidenceTable, normalized),
                inArray(
                  ExperienceEvidenceTable.id,
                  evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
                ),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (evidenceRows.length !== evidenceIDs.length)
            return yield* new ExperienceStoreError({ reason: "Experience Evidence storage is incomplete" })
          const expectedRunByEvidenceID = new Map<string, string>()
          for (const row of ordered)
            for (const evidenceID of row.evidence_ids)
              expectedRunByEvidenceID.set(String(evidenceID), String(row.run_id))
          const evidence: Array<AgentRuntime.Evidence> = []
          for (const row of evidenceRows.toSorted((left, right) => String(left.id).localeCompare(String(right.id)))) {
            let decoded: AgentRuntime.Evidence
            try {
              decoded = decodeEvidence(row.record)
            } catch {
              return yield* new ExperienceStoreError({
                reason: `Experience Evidence cannot be decoded: ${String(row.id)}`,
              })
            }
            const digest = canonicalHash(encodeEvidence(decoded))
            if (
              row.record_digest !== digest ||
              String(decoded.id) !== String(row.id) ||
              String(decoded.runID) !== String(row.run_id) ||
              String(decoded.actionID) !== String(row.action_id) ||
              !decoded.observationIDs?.some((id) => String(id) === String(row.observation_id)) ||
              expectedRunByEvidenceID.get(String(row.id)) !== String(row.run_id) ||
              decoded.verificationStatus !== "verified" ||
              (decoded.trust !== "verified" && decoded.trust !== "trusted") ||
              decoded.instructionAllowed ||
              !decoded.source.startsWith("verifier:") ||
              decoded.extractionMethod !== "verifier-registry" ||
              !decoded.contentDigest
            )
              return yield* new ExperienceStoreError({
                reason: `Experience Evidence provenance is invalid: ${String(row.id)}`,
              })
            evidence.push(decoded)
          }
          const evaluationRecords: Array<{ runID: AgentRuntime.RunID; result: AgentRuntime.EvaluationResult }> = []
          const seenEvaluationIDs = new Set<string>()
          for (const row of ordered) {
            const evaluation = yield* evaluations.get(row.evaluation_id)
            if (
              !evaluation ||
              !evaluation.passed ||
              String(evaluation.runID) !== String(row.run_id) ||
              evaluation.evidenceIDs.map(String).toSorted().join("\u0000") !==
                row.evidence_ids.map(String).toSorted().join("\u0000")
            )
              return yield* new ExperienceStoreError({
                reason: `canonical EvaluationResult is unavailable: ${row.evaluation_id}`,
              })
            if (!seenEvaluationIDs.has(String(row.evaluation_id))) {
              seenEvaluationIDs.add(String(row.evaluation_id))
              evaluationRecords.push({ runID: evaluation.runID, result: evaluation.result })
            }
          }
          return { experiences, evidence, evaluations: evaluationRecords }
        }),
      )

    const verifyAudit: Interface["verifyAudit"] = (identity, candidateID) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(ExperienceAuditTable)
            .where(and(ownership(ExperienceAuditTable, normalized), eq(ExperienceAuditTable.aggregate_id, candidateID)))
            .orderBy(asc(ExperienceAuditTable.sequence))
            .all()
            .pipe(Effect.orDie)
          let previous = "genesis"
          for (let index = 0; index < rows.length; index++) {
            const row = rows[index]!
            const expected = canonicalHash(
              auditPayload({
                aggregateID: row.aggregate_id,
                sequence: row.sequence,
                action: row.action,
                actor: row.actor,
                reason: row.reason,
                metadata: row.metadata,
                previousHash: row.previous_hash,
              }),
            )
            if (row.sequence !== index + 1 || row.previous_hash !== previous || row.record_hash !== expected)
              return { valid: false, events: index, headHash: previous }
            previous = row.record_hash
          }
          return { valid: true, events: rows.length, headHash: previous }
        }),
      )

    return Service.of({
      recordVerifiedEvidence,
      recordAdmissionEvidence,
      recordVerifiedSupport,
      recordEvaluation,
      review,
      getCandidate,
      listCandidates,
      listSources,
      resolveEvidenceIDs,
      resolveEvidenceFacts,
      loadProvenance,
      verifyAudit,
    })
  }),
)

const experienceFromSupport = (support: SupportRow, promotedAt: number) => {
  const identityDigest = canonicalHash({
    domain: "arforge.experience-record/v1",
    candidateID: support.candidate_id,
    supportID: support.id,
    supportDigest: support.support_digest,
  })!
  const record = AgentRuntime.ExperienceRecord.make({
    id: AgentRuntime.ExperienceID.make(`exp_${identityDigest.slice(0, 24)}`),
    runID: support.run_id,
    outcome: "success",
    summary: support.summary,
    evidenceIDs: support.evidence_ids,
    reusable: true,
    createdAt: DateTime.makeUnsafe(promotedAt),
  })
  return { support, record }
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, DurableRun.globalNode, DurableAction.globalNode, RuntimeEvaluation.node, LearningV2.node],
})

export const Policy = Object.freeze({ minimumSupport: MINIMUM_SUPPORT })
