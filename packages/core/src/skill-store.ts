export * as SkillStoreV1 from "./skill-store"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { ExperienceStoreV1 } from "./experience-store"
import { ExperienceEvidenceTable } from "./experience-store/sql"
import { redact } from "./redact"
import { DurableRun } from "./runtime/durable-run"
import * as RuntimeEvaluation from "./runtime/evaluation"
import {
  compileSkillArtifact,
  type CompileInput,
  type CompilerFile,
  type CompilerTestCase,
  type DeterministicTest,
  type SecurityScan,
} from "./skill-compiler"
import { assignCohort, evaluateSkill, type EvaluationObservation, type SkillEvaluationReport } from "./skill-lifecycle"
import { ensureNoPermissionExpansion, transition } from "./skill-v1"
import {
  SkillAuditTable,
  SkillCanaryObservationTable,
  SkillDeploymentTable,
  SkillEvaluationTable,
  SkillVersionTable,
} from "./skill-store/sql"
import { canonicalHash } from "./util/canonical-hash"

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const DIGEST = /^[a-f0-9]{64}$/i
const MINIMUM_CANARY_OBSERVATIONS = 3
const MINIMUM_CANARY_SUCCESS_RATE = 0.8

export interface TrustedSkillIdentity {
  readonly tenantID: string
  readonly userID: string
  readonly actor: string
}

export interface CreateSkillCandidateInput extends Omit<CompileInput, "experiences" | "evaluationID" | "now"> {
  readonly identity: TrustedSkillIdentity
  readonly sourceExperienceIDs: ReadonlyArray<AgentRuntime.ExperienceID>
  readonly now?: number
}

export interface SkillCandidateProjection {
  readonly candidateID: string
  readonly skill: SkillContract.Skill
  readonly baselineCandidateID?: string
  readonly sourceEvidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly evaluationDigest?: string
  readonly evaluationPassed?: boolean
  readonly revision: number
  readonly createdBy: string
  readonly reviewActor?: string
  readonly reviewReason?: string
  readonly trafficPercent?: number
  readonly canaryDigest?: string
  readonly rollbackVersion?: string
  readonly recordDigest: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SkillDeploymentProjection {
  readonly skillID: SkillContract.SkillID
  readonly activeCandidateID: string
  readonly previousCandidateID?: string
  readonly generation: number
  readonly digest: string
}

export interface SkillCanarySummaryProjection {
  readonly observationCount: number
  readonly successCount: number
  readonly safetyIncidentCount: number
  readonly successRate: number
  readonly minimumObservations: number
  readonly minimumSuccessRate: number
  readonly promotionReady: boolean
}

export interface SkillCandidateDetailProjection {
  readonly candidate: SkillCandidateProjection
  readonly evaluation?: SkillEvaluationReport
  readonly canary: SkillCanarySummaryProjection
}

export class SkillStoreError extends Schema.TaggedErrorClass<SkillStoreError>()("SkillStore.Error", {
  reason: Schema.String,
}) {}

export class SkillStoreNotFoundError extends Schema.TaggedErrorClass<SkillStoreNotFoundError>()("SkillStore.NotFound", {
  kind: Schema.String,
  id: Schema.String,
}) {}

export class SkillStoreConflictError extends Schema.TaggedErrorClass<SkillStoreConflictError>()("SkillStore.Conflict", {
  id: Schema.String,
  reason: Schema.String,
}) {}

type StoreFailure = SkillStoreError | SkillStoreNotFoundError | SkillStoreConflictError

export interface Interface {
  readonly createCandidate: (input: CreateSkillCandidateInput) => Effect.Effect<SkillCandidateProjection, StoreFailure>
  readonly recordEvaluation: (input: {
    readonly identity: TrustedSkillIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly observations: ReadonlyArray<EvaluationObservation>
  }) => Effect.Effect<
    { readonly candidate: SkillCandidateProjection; readonly report: SkillEvaluationReport },
    StoreFailure
  >
  readonly startCanary: (input: {
    readonly identity: TrustedSkillIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly trafficPercent: number
    readonly reason: string
    readonly now?: number
  }) => Effect.Effect<SkillCandidateProjection, StoreFailure>
  readonly recordCanaryObservation: (input: {
    readonly identity: TrustedSkillIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly idempotencyKey: string
    readonly cohortKey: string
    readonly runID: AgentRuntime.RunID
    readonly evaluationID: AgentRuntime.EvaluationID
    readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
    readonly success: boolean
    readonly safetyIncident: boolean
  }) => Effect.Effect<
    { readonly candidate: SkillCandidateProjection; readonly observationID: string; readonly replayed: boolean },
    StoreFailure
  >
  readonly promote: (input: {
    readonly identity: TrustedSkillIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly reason: string
    readonly now?: number
  }) => Effect.Effect<
    {
      readonly candidate: SkillCandidateProjection
      readonly deployment: SkillDeploymentProjection
      readonly receiptDigest: string
    },
    StoreFailure
  >
  readonly rollback: (input: {
    readonly identity: TrustedSkillIdentity
    readonly candidateID: string
    readonly expectedRevision: number
    readonly reason: string
    readonly now?: number
  }) => Effect.Effect<
    {
      readonly rolledBack: SkillCandidateProjection
      readonly restored: SkillCandidateProjection
      readonly deployment: SkillDeploymentProjection
      readonly receiptDigest: string
    },
    StoreFailure
  >
  readonly getCandidate: (
    identity: TrustedSkillIdentity,
    candidateID: string,
  ) => Effect.Effect<SkillCandidateProjection, SkillStoreError | SkillStoreNotFoundError>
  readonly getCandidateDetail: (
    identity: TrustedSkillIdentity,
    candidateID: string,
  ) => Effect.Effect<SkillCandidateDetailProjection, StoreFailure>
  readonly listCandidates: (
    identity: TrustedSkillIdentity,
    input?: { readonly skillID?: string; readonly status?: SkillContract.Status; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<SkillCandidateProjection>, SkillStoreError>
  readonly getDeployment: (
    identity: TrustedSkillIdentity,
    skillID: string,
  ) => Effect.Effect<SkillDeploymentProjection | undefined, SkillStoreError>
  readonly verifyAudit: (
    identity: TrustedSkillIdentity,
    candidateID: string,
  ) => Effect.Effect<{ readonly valid: boolean; readonly events: number; readonly headHash: string }, SkillStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SkillStore") {}

type VersionRow = typeof SkillVersionTable.$inferSelect
type DeploymentRow = typeof SkillDeploymentTable.$inferSelect
type AuditRow = typeof SkillAuditTable.$inferSelect
type CanaryObservationRow = typeof SkillCanaryObservationTable.$inferSelect

const normalizeIdentity = (identity: TrustedSkillIdentity): TrustedSkillIdentity => {
  const tenantID = identity.tenantID.trim()
  const userID = identity.userID.trim()
  const actor = identity.actor.trim()
  if (!ID.test(tenantID) || !ID.test(userID) || !actor) throw new Error("trusted identity is invalid")
  if (actor === "user:product") throw new Error("placeholder actors are forbidden")
  return { tenantID, userID, actor }
}

const humanActor = (actor: string) => actor.startsWith("user:") || actor.startsWith("admin:")

const bounded = (value: string, field: string, maximum: number) => {
  const clean = redact(value).trim().slice(0, maximum)
  if (!clean) throw new Error(`${field} is required`)
  return clean
}

const ownership = (table: { tenant_id: any; owner_user_id: any }, identity: TrustedSkillIdentity) =>
  and(eq(table.tenant_id, identity.tenantID), eq(table.owner_user_id, identity.userID))

const encodeSkill = (value: SkillContract.Skill): unknown => Schema.encodeUnknownSync(SkillContract.Skill)(value)
const decodeSkill = (value: unknown): SkillContract.Skill => Schema.decodeUnknownSync(SkillContract.Skill)(value)
const decodeEvidence = (value: unknown): AgentRuntime.Evidence => Schema.decodeUnknownSync(AgentRuntime.Evidence)(value)

const decodeTests = (value: unknown): ReadonlyArray<DeterministicTest> => {
  if (!Array.isArray(value)) throw new Error("stored Skill tests are invalid")
  const tests = value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("stored Skill test is invalid")
    const testID = Reflect.get(item, "testID")
    const digest = Reflect.get(item, "digest")
    const input = Reflect.get(item, "input")
    const expected = Reflect.get(item, "expected")
    if (typeof testID !== "string" || typeof digest !== "string" || !DIGEST.test(digest))
      throw new Error("stored Skill test identity is invalid")
    return { testID, digest, input, expected } as DeterministicTest
  })
  if (new Set(tests.map((test) => test.testID)).size !== tests.length)
    throw new Error("stored Skill tests contain duplicates")
  return tests
}

const decodeReport = (value: unknown): SkillEvaluationReport => {
  if (typeof value !== "object" || value === null) throw new Error("stored Skill evaluation is invalid")
  const report = value as SkillEvaluationReport
  if (
    typeof report.candidateDigest !== "string" ||
    typeof report.baselineDigest !== "string" ||
    typeof report.passed !== "boolean" ||
    !Array.isArray(report.evidenceIDs) ||
    !report.evidenceIDs.every((id) => typeof id === "string" && id.startsWith("evd_")) ||
    typeof report.checks !== "object" ||
    report.checks === null
  )
    throw new Error("stored Skill evaluation is malformed")
  return report
}

const versionDigest = (input: {
  readonly candidateID: string
  readonly skill: SkillContract.Skill
  readonly baselineCandidateID?: string
  readonly sourceEvidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly evaluationDigest?: string
  readonly evaluationPassed?: boolean
  readonly revision: number
  readonly createdBy: string
  readonly reviewActor?: string
  readonly reviewReason?: string
  readonly trafficPercent?: number
  readonly canaryDigest?: string
  readonly rollbackVersion?: string
}) => {
  const digest = canonicalHash({
    candidateID: input.candidateID,
    skill: encodeSkill(input.skill),
    baselineCandidateID: input.baselineCandidateID,
    sourceEvidenceIDs: input.sourceEvidenceIDs,
    evaluationDigest: input.evaluationDigest,
    evaluationPassed: input.evaluationPassed,
    revision: input.revision,
    createdBy: input.createdBy,
    reviewActor: input.reviewActor,
    reviewReason: input.reviewReason,
    trafficPercent: input.trafficPercent,
    canaryDigest: input.canaryDigest,
    rollbackVersion: input.rollbackVersion,
  })
  if (!digest) throw new Error("Skill lifecycle record is not canonicalizable")
  return digest
}

const toProjection = (row: VersionRow): SkillCandidateProjection => ({
  candidateID: row.id,
  skill: decodeSkill(row.skill_record),
  baselineCandidateID: row.baseline_version_id ?? undefined,
  sourceEvidenceIDs: row.source_evidence_ids,
  evaluationDigest: row.evaluation_digest ?? undefined,
  evaluationPassed: row.evaluation_passed ?? undefined,
  revision: row.revision,
  createdBy: row.created_by,
  reviewActor: row.review_actor ?? undefined,
  reviewReason: row.review_reason ?? undefined,
  trafficPercent: row.traffic_percent ?? undefined,
  canaryDigest: row.canary_digest ?? undefined,
  rollbackVersion: row.rollback_version ?? undefined,
  recordDigest: row.record_digest,
  createdAt: row.time_created,
  updatedAt: row.time_updated,
})

const toDeployment = (row: DeploymentRow): SkillDeploymentProjection => ({
  skillID: row.skill_id,
  activeCandidateID: row.active_candidate_id,
  previousCandidateID: row.previous_candidate_id ?? undefined,
  generation: row.generation,
  digest: row.deployment_digest,
})

const summarizeCanary = (
  candidateID: string,
  status: SkillContract.Status,
  rows: ReadonlyArray<CanaryObservationRow>,
): SkillCanarySummaryProjection => {
  for (const row of rows) {
    const record = row.record
    if (typeof record !== "object" || record === null || Array.isArray(record))
      throw new Error("stored Skill canary observation is invalid")
    const value = record as {
      readonly candidateID?: unknown
      readonly success?: unknown
      readonly safetyIncident?: unknown
    }
    if (
      value.candidateID !== candidateID ||
      value.success !== row.success ||
      value.safetyIncident !== row.safety_incident ||
      canonicalHash(record) !== row.record_digest
    )
      throw new Error("stored Skill canary observation failed integrity verification")
  }
  const observationCount = rows.length
  const successCount = rows.filter((row) => row.success).length
  const safetyIncidentCount = rows.filter((row) => row.safety_incident).length
  const successRate = observationCount === 0 ? 0 : successCount / observationCount
  return {
    observationCount,
    successCount,
    safetyIncidentCount,
    successRate,
    minimumObservations: MINIMUM_CANARY_OBSERVATIONS,
    minimumSuccessRate: MINIMUM_CANARY_SUCCESS_RATE,
    promotionReady:
      status === "canary" &&
      observationCount >= MINIMUM_CANARY_OBSERVATIONS &&
      safetyIncidentCount === 0 &&
      successRate >= MINIMUM_CANARY_SUCCESS_RATE,
  }
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
  identity: TrustedSkillIdentity,
  input: Omit<Parameters<typeof auditPayload>[0], "sequence" | "previousHash">,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const latest = yield* tx
      .select()
      .from(SkillAuditTable)
      .where(and(ownership(SkillAuditTable, identity), eq(SkillAuditTable.aggregate_id, input.aggregateID)))
      .orderBy(desc(SkillAuditTable.sequence))
      .get()
    const sequence = (latest?.sequence ?? 0) + 1
    const previousHash = latest?.record_hash ?? "genesis"
    const payload = auditPayload({ ...input, sequence, previousHash })
    const recordHash = canonicalHash(payload)
    if (!recordHash) throw new Error("Skill audit event is not canonicalizable")
    yield* tx
      .insert(SkillAuditTable)
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

const storeFailure = (error: unknown): StoreFailure => {
  if (
    error instanceof SkillStoreError ||
    error instanceof SkillStoreNotFoundError ||
    error instanceof SkillStoreConflictError
  )
    return error
  return new SkillStoreError({ reason: error instanceof Error ? error.message : String(error) })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const experiences = yield* ExperienceStoreV1.Service
    const runs = yield* DurableRun.Service
    const evaluations = yield* RuntimeEvaluation.Service

    const asPrincipal = <A, E>(
      identity: TrustedSkillIdentity,
      effect: (normalized: TrustedSkillIdentity) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | SkillStoreError> => {
      let normalized: TrustedSkillIdentity
      try {
        normalized = normalizeIdentity(identity)
      } catch (error) {
        return Effect.fail(new SkillStoreError({ reason: error instanceof Error ? error.message : String(error) }))
      }
      return database.runAsPrincipal(normalized, effect(normalized))
    }

    const getVersionRow = (identity: TrustedSkillIdentity, candidateID: string) =>
      db
        .select()
        .from(SkillVersionTable)
        .where(and(ownership(SkillVersionTable, identity), eq(SkillVersionTable.id, candidateID)))
        .get()
        .pipe(Effect.orDie)

    const getDeploymentRow = (identity: TrustedSkillIdentity, skillID: SkillContract.SkillID) =>
      db
        .select()
        .from(SkillDeploymentTable)
        .where(and(ownership(SkillDeploymentTable, identity), eq(SkillDeploymentTable.skill_id, skillID)))
        .get()
        .pipe(Effect.orDie)

    const createCandidate: Interface["createCandidate"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const skillID = bounded(input.skillID, "skillID", 128)
          const version = bounded(input.version, "version", 64)
          const sourceExperienceIDs = [...new Set(input.sourceExperienceIDs.map(String))].toSorted()
          const provenance = yield* experiences
            .loadProvenance(
              identity,
              sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id)),
            )
            .pipe(Effect.mapError(storeFailure))
          const identityDigest = canonicalHash({
            skillID,
            version,
            purpose: input.purpose,
            triggers: input.triggers,
            allowedTools: input.allowedTools,
            allowedCapabilities: input.allowedCapabilities,
            inputSchema: input.inputSchema,
            outputSchema: input.outputSchema,
            instructions: input.instructions,
            assets: input.assets ?? [],
            scripts: input.scripts ?? [],
            sourceExperienceIDs,
            testCases: input.testCases,
            policyVersion: input.policyVersion,
          })
          if (!identityDigest) return yield* new SkillStoreError({ reason: "Skill candidate is not canonicalizable" })
          const evaluationID = AgentRuntime.EvaluationID.make(`eva_skill_${identityDigest.slice(0, 24)}`)
          const existing = yield* db
            .select()
            .from(SkillVersionTable)
            .where(
              and(
                ownership(SkillVersionTable, identity),
                eq(SkillVersionTable.skill_id, SkillContract.SkillID.make(skillID)),
                eq(SkillVersionTable.version, version),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          const createdAt = existing ? DateTime.toEpochMillis(decodeSkill(existing.skill_record).createdAt) : input.now
          const artifact = yield* Effect.try({
            try: () =>
              compileSkillArtifact({
                ...input,
                skillID,
                version,
                experiences: provenance.experiences,
                evaluationID,
                ...(createdAt === undefined ? {} : { now: createdAt }),
              }),
            catch: storeFailure,
          })
          if (existing) {
            const exact =
              existing.digest === artifact.skill.digest &&
              canonicalHash(existing.manifest) === canonicalHash(artifact.manifest) &&
              canonicalHash(existing.artifact_files) === canonicalHash(artifact.files) &&
              canonicalHash(existing.tests) === canonicalHash(artifact.tests) &&
              canonicalHash(existing.scan) === canonicalHash(artifact.scan)
            if (!exact)
              return yield* new SkillStoreConflictError({
                id: `${skillID}@${version}`,
                reason: "Skill version already belongs to a different immutable artifact",
              })
            return toProjection(existing)
          }
          const deployment = yield* getDeploymentRow(identity, artifact.skill.skillID)
          const baseline = deployment ? yield* getVersionRow(identity, deployment.active_candidate_id) : undefined
          if (deployment && !baseline)
            return yield* new SkillStoreError({ reason: "active Skill deployment points to a missing version" })
          if (baseline) {
            yield* Effect.try({
              try: () => ensureNoPermissionExpansion(decodeSkill(baseline.skill_record), artifact.skill),
              catch: storeFailure,
            })
          } else if (
            !humanActor(identity.actor) &&
            (artifact.skill.allowedTools.length > 0 || artifact.skill.allowedCapabilities.length > 0)
          ) {
            return yield* new SkillStoreError({
              reason: "automatic Skill creation cannot establish new tools or capabilities",
            })
          }
          const sourceEvidenceIDs = provenance.evidence
            .map((item) => item.id)
            .toSorted((a, b) => String(a).localeCompare(String(b)))
          const candidateID = `skc_${artifact.skill.digest.slice(0, 24)}`
          const revision = 1
          const recordDigest = versionDigest({
            candidateID,
            skill: artifact.skill,
            baselineCandidateID: baseline?.id,
            sourceEvidenceIDs,
            revision,
            createdBy: identity.actor,
          })
          const inserted = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .insert(SkillVersionTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    id: candidateID,
                    skill_id: artifact.skill.skillID,
                    version: artifact.skill.version,
                    digest: artifact.skill.digest,
                    skill_record: encodeSkill(artifact.skill),
                    manifest: artifact.manifest,
                    artifact_files: artifact.files,
                    tests: artifact.tests,
                    scan: artifact.scan,
                    source_experience_ids: artifact.skill.sourceExperienceIDs,
                    source_evidence_ids: sourceEvidenceIDs,
                    evaluation_id: evaluationID,
                    baseline_version_id: baseline?.id ?? null,
                    status: "candidate",
                    revision,
                    policy_version: input.policyVersion,
                    created_by: identity.actor,
                    record_digest: recordDigest,
                  })
                  .returning()
                  .get()
                yield* appendAudit(tx, identity, {
                  aggregateID: candidateID,
                  action: "candidate_created",
                  actor: identity.actor,
                  reason: "verified Experience compiled into an immutable Skill candidate",
                  metadata: {
                    skillID,
                    version,
                    candidateDigest: artifact.skill.digest,
                    sourceExperienceIDs,
                    sourceEvidenceIDs,
                    baselineCandidateID: baseline?.id ?? null,
                    evaluationID,
                    scanDigest: artifact.scan.digest,
                  },
                })
                return row
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return toProjection(inserted)
        }).pipe(Effect.mapError(storeFailure)),
      )

    const recordEvaluation: Interface["recordEvaluation"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const row = yield* getVersionRow(identity, input.candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          if (row.status !== "candidate")
            return yield* new SkillStoreConflictError({ id: row.id, reason: "only candidate Skills may be evaluated" })
          const tests = decodeTests(row.tests)
          const expectedCases = tests.map((test) => test.testID).toSorted()
          const actualCases = input.observations.map((item) => item.caseID).toSorted()
          if (expectedCases.join("\u0000") !== actualCases.join("\u0000"))
            return yield* new SkillStoreError({
              reason: "Skill evaluation must cover every deterministic test exactly once",
            })
          const allowedEvidence = new Set(row.source_evidence_ids.map(String))
          if (
            input.observations.some(
              (observation) =>
                observation.evidenceIDs.length === 0 || observation.evidenceIDs.some((id) => !allowedEvidence.has(id)),
            )
          )
            return yield* new SkillStoreError({
              reason: "Skill evaluation Evidence is not canonical source provenance",
            })
          const candidate = decodeSkill(row.skill_record)
          const baselineRow = row.baseline_version_id
            ? yield* getVersionRow(identity, row.baseline_version_id)
            : undefined
          if (row.baseline_version_id && !baselineRow)
            return yield* new SkillStoreError({ reason: "Skill evaluation baseline is unavailable" })
          const baseline = baselineRow
            ? decodeSkill(baselineRow.skill_record)
            : SkillContract.Skill.make({
                ...candidate,
                version: "0.0.0",
                digest: SkillContract.Digest.make("0".repeat(64)),
                allowedTools: [],
                allowedCapabilities: [],
                status: "candidate",
              })
          const report = yield* Effect.try({
            try: () =>
              evaluateSkill({ baselineSkill: baseline, candidateSkill: candidate, observations: input.observations }),
            catch: storeFailure,
          })
          const reportDigest = canonicalHash(report)
          if (!reportDigest) return yield* new SkillStoreError({ reason: "Skill evaluation is not canonicalizable" })
          const replay = yield* db
            .select()
            .from(SkillEvaluationTable)
            .where(and(ownership(SkillEvaluationTable, identity), eq(SkillEvaluationTable.candidate_id, row.id)))
            .get()
            .pipe(Effect.orDie)
          if (replay) {
            if (replay.report_digest !== reportDigest)
              return yield* new SkillStoreConflictError({
                id: row.id,
                reason: "Skill candidate already has a different canonical evaluation",
              })
            return { candidate: toProjection(row), report: decodeReport(replay.report) }
          }
          if (row.revision !== input.expectedRevision)
            return yield* new SkillStoreConflictError({ id: row.id, reason: "Skill candidate revision changed" })
          const revision = row.revision + 1
          const recordDigest = versionDigest({
            ...toProjection(row),
            evaluationDigest: reportDigest,
            evaluationPassed: report.passed,
            revision,
          })
          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(SkillEvaluationTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    id: row.evaluation_id,
                    candidate_id: row.id,
                    report_digest: reportDigest,
                    report,
                    passed: report.passed,
                    created_by: identity.actor,
                  })
                  .run()
                const next = yield* tx
                  .update(SkillVersionTable)
                  .set({
                    evaluation_digest: reportDigest,
                    evaluation_passed: report.passed,
                    revision,
                    record_digest: recordDigest,
                    time_updated: Date.now(),
                  })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, row.id),
                      eq(SkillVersionTable.revision, row.revision),
                    ),
                  )
                  .returning()
                  .get()
                if (!next) throw new Error("Skill candidate revision changed during evaluation")
                yield* appendAudit(tx, identity, {
                  aggregateID: row.id,
                  action: "evaluation_recorded",
                  actor: identity.actor,
                  reason: report.passed ? "independent Skill evaluation passed" : "independent Skill evaluation failed",
                  metadata: { evaluationID: row.evaluation_id, reportDigest, checks: report.checks },
                })
                return next
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return { candidate: toProjection(updated), report }
        }).pipe(Effect.mapError(storeFailure)),
      )

    const startCanary: Interface["startCanary"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          if (!humanActor(identity.actor))
            return yield* new SkillStoreError({ reason: "Skill canary approval requires a trusted human actor" })
          if (!Number.isInteger(input.trafficPercent) || input.trafficPercent < 1 || input.trafficPercent > 100)
            return yield* new SkillStoreError({ reason: "trafficPercent must be an integer in [1, 100]" })
          const reason = bounded(input.reason, "review reason", 500)
          const row = yield* getVersionRow(identity, input.candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          if (
            row.status === "canary" &&
            row.traffic_percent === input.trafficPercent &&
            row.review_actor === identity.actor &&
            row.review_reason === reason
          )
            return toProjection(row)
          if (row.status !== "candidate" || row.revision !== input.expectedRevision)
            return yield* new SkillStoreConflictError({
              id: row.id,
              reason: "Skill is not the expected candidate revision",
            })
          if (!row.evaluation_passed || !row.evaluation_digest)
            return yield* new SkillStoreError({ reason: "Skill canary requires a passed independent evaluation" })
          const evaluation = yield* db
            .select()
            .from(SkillEvaluationTable)
            .where(
              and(
                ownership(SkillEvaluationTable, identity),
                eq(SkillEvaluationTable.id, row.evaluation_id),
                eq(SkillEvaluationTable.candidate_id, row.id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!evaluation || !evaluation.passed || evaluation.report_digest !== row.evaluation_digest)
            return yield* new SkillStoreError({ reason: "canonical Skill evaluation is unavailable" })
          const report = decodeReport(evaluation.report)
          const now = input.now ?? Date.now()
          const candidate = decodeSkill(row.skill_record)
          const reviewed = SkillContract.Skill.make({
            ...candidate,
            securityReview: {
              status: "passed",
              evidenceIDs: report.evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
              reviewerID: identity.actor,
              policyVersion: row.policy_version,
              reviewedAt: DateTime.makeUnsafe(now),
            },
            updatedAt: DateTime.makeUnsafe(now),
          })
          const canary = yield* Effect.try({
            try: () => transition(reviewed, "canary", { now }),
            catch: storeFailure,
          })
          const canaryDigest = canonicalHash({
            candidateDigest: canary.digest,
            evaluationDigest: row.evaluation_digest,
            trafficPercent: input.trafficPercent,
            policyVersion: row.policy_version,
            startedAt: now,
          })
          if (!canaryDigest) return yield* new SkillStoreError({ reason: "Skill canary is not canonicalizable" })
          const revision = row.revision + 1
          const recordDigest = versionDigest({
            ...toProjection(row),
            skill: canary,
            revision,
            reviewActor: identity.actor,
            reviewReason: reason,
            trafficPercent: input.trafficPercent,
            canaryDigest,
          })
          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const next = yield* tx
                  .update(SkillVersionTable)
                  .set({
                    skill_record: encodeSkill(canary),
                    status: "canary",
                    review_actor: identity.actor,
                    review_reason: reason,
                    traffic_percent: input.trafficPercent,
                    canary_digest: canaryDigest,
                    revision,
                    record_digest: recordDigest,
                    time_updated: now,
                  })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, row.id),
                      eq(SkillVersionTable.revision, row.revision),
                      eq(SkillVersionTable.status, "candidate"),
                    ),
                  )
                  .returning()
                  .get()
                if (!next) throw new Error("Skill candidate changed during canary approval")
                yield* appendAudit(tx, identity, {
                  aggregateID: row.id,
                  action: "canary_started",
                  actor: identity.actor,
                  reason,
                  metadata: {
                    trafficPercent: input.trafficPercent,
                    canaryDigest,
                    evaluationDigest: row.evaluation_digest,
                  },
                })
                return next
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return toProjection(updated)
        }).pipe(Effect.mapError(storeFailure)),
      )

    const recordCanaryObservation: Interface["recordCanaryObservation"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const idempotencyKey = bounded(input.idempotencyKey, "idempotency key", 200)
          const cohortKey = bounded(input.cohortKey, "cohort key", 500)
          const row = yield* getVersionRow(identity, input.candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          if (row.status !== "canary" || !row.traffic_percent)
            return yield* new SkillStoreConflictError({ id: row.id, reason: "Skill is not in canary" })
          if (!assignCohort(row.digest, cohortKey, row.traffic_percent))
            return yield* new SkillStoreError({ reason: "cohort is outside the deterministic Skill canary" })
          const run = yield* runs
            .load(input.runID)
            .pipe(
              Effect.mapError(
                (error) => new SkillStoreError({ reason: `canary Run is unavailable: ${String(error)}` }),
              ),
            )
          if (run.run.status !== "completed" && run.run.status !== "failed" && run.run.status !== "cancelled")
            return yield* new SkillStoreError({ reason: "canary observation requires a terminal durable Run" })
          const evaluation = yield* evaluations.get(input.evaluationID)
          if (!evaluation)
            return yield* new SkillStoreError({ reason: "canary observation has no canonical Run evaluation" })
          const evaluationFailures = [
            evaluation.runID === input.runID ? undefined : "run",
            evaluation.passed === input.success ? undefined : "result",
            evaluation.approvalStatus === "approved" ? undefined : "approval",
            evaluation.candidateArtifactDigest === row.digest ? undefined : "candidate-artifact",
            evaluation.environmentDigest === row.canary_digest ? undefined : "canary-binding",
          ].filter((value): value is string => value !== undefined)
          if (evaluationFailures.length > 0)
            return yield* new SkillStoreError({
              reason: `canary observation does not match canonical Run evaluation: ${evaluationFailures.join(", ")}`,
            })
          const derivedSafetyIncident = ["safety_incidents", "new_secret_findings", "new_egress_attempts"].some(
            (key) => (evaluation.metrics[key] ?? 0) > 0,
          )
          if (input.safetyIncident !== derivedSafetyIncident)
            return yield* new SkillStoreError({
              reason: "canary safety result does not match canonical evaluation metrics",
            })
          const evidenceIDs = [...new Set(input.evidenceIDs.map(String))].toSorted()
          if (evidenceIDs.length === 0)
            return yield* new SkillStoreError({ reason: "canary observation requires verified Evidence" })
          if (evaluation.evidenceIDs.map(String).toSorted().join("\u0000") !== evidenceIDs.join("\u0000"))
            return yield* new SkillStoreError({ reason: "canary Evidence does not match canonical Run evaluation" })
          const evidenceRows = yield* db
            .select()
            .from(ExperienceEvidenceTable)
            .where(
              and(
                ownership(ExperienceEvidenceTable, identity),
                inArray(
                  ExperienceEvidenceTable.id,
                  evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
                ),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          if (evidenceRows.length !== evidenceIDs.length)
            return yield* new SkillStoreError({ reason: "canary Evidence is not durably stored" })
          for (const evidenceRow of evidenceRows) {
            const evidence = decodeEvidence(evidenceRow.record)
            if (
              evidence.runID !== input.runID ||
              evidence.verificationStatus !== "verified" ||
              (evidence.trust !== "verified" && evidence.trust !== "trusted") ||
              evidence.instructionAllowed
            )
              return yield* new SkillStoreError({ reason: "canary Evidence is not trusted verifier output" })
          }
          const cohortKeyDigest = canonicalHash({ candidateDigest: row.digest, cohortKey })
          if (!cohortKeyDigest) return yield* new SkillStoreError({ reason: "canary cohort is not canonicalizable" })
          const record = {
            candidateID: row.id,
            idempotencyKey,
            runID: input.runID,
            evaluationID: input.evaluationID,
            cohortKeyDigest,
            success: input.success,
            safetyIncident: input.safetyIncident,
            evidenceIDs,
          }
          const recordDigest = canonicalHash(record)
          if (!recordDigest) return yield* new SkillStoreError({ reason: "canary observation is not canonicalizable" })
          const replay = yield* db
            .select()
            .from(SkillCanaryObservationTable)
            .where(
              and(
                ownership(SkillCanaryObservationTable, identity),
                eq(SkillCanaryObservationTable.candidate_id, row.id),
                eq(SkillCanaryObservationTable.idempotency_key, idempotencyKey),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (replay) {
            if (replay.record_digest !== recordDigest)
              return yield* new SkillStoreConflictError({
                id: idempotencyKey,
                reason: "canary idempotency key belongs to a different observation",
              })
            return { candidate: toProjection(row), observationID: replay.id, replayed: true }
          }
          if (row.revision !== input.expectedRevision)
            return yield* new SkillStoreConflictError({ id: row.id, reason: "Skill canary revision changed" })
          const observationID = `sko_${recordDigest.slice(0, 24)}`
          const revision = row.revision + 1
          const lifecycleDigest = versionDigest({ ...toProjection(row), revision })
          const updated = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(SkillCanaryObservationTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    id: observationID,
                    candidate_id: row.id,
                    idempotency_key: idempotencyKey,
                    run_id: input.runID,
                    evaluation_id: input.evaluationID,
                    cohort_key_digest: cohortKeyDigest,
                    success: input.success,
                    safety_incident: input.safetyIncident,
                    evidence_ids: evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
                    record_digest: recordDigest,
                    record,
                  })
                  .run()
                const next = yield* tx
                  .update(SkillVersionTable)
                  .set({ revision, record_digest: lifecycleDigest, time_updated: Date.now() })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, row.id),
                      eq(SkillVersionTable.revision, row.revision),
                      eq(SkillVersionTable.status, "canary"),
                    ),
                  )
                  .returning()
                  .get()
                if (!next) throw new Error("Skill canary changed while recording observation")
                yield* appendAudit(tx, identity, {
                  aggregateID: row.id,
                  action: "canary_observation_recorded",
                  actor: identity.actor,
                  reason: input.safetyIncident ? "canary safety incident observed" : "canary observation recorded",
                  metadata: { observationID, recordDigest, runID: input.runID, evaluationID: input.evaluationID },
                })
                return next
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          return { candidate: toProjection(updated), observationID, replayed: false }
        }).pipe(Effect.mapError(storeFailure)),
      )

    const promote: Interface["promote"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          if (!humanActor(identity.actor))
            return yield* new SkillStoreError({ reason: "Skill promotion requires a trusted human actor" })
          const reason = bounded(input.reason, "promotion reason", 500)
          const row = yield* getVersionRow(identity, input.candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          const existingDeployment = yield* getDeploymentRow(identity, row.skill_id)
          if (row.status === "active" && existingDeployment?.active_candidate_id === row.id) {
            const latestAudit = yield* db
              .select()
              .from(SkillAuditTable)
              .where(and(ownership(SkillAuditTable, identity), eq(SkillAuditTable.aggregate_id, row.id)))
              .orderBy(desc(SkillAuditTable.sequence))
              .get()
              .pipe(Effect.orDie)
            if (
              row.revision !== input.expectedRevision + 1 ||
              latestAudit?.action !== "promoted" ||
              latestAudit.actor !== identity.actor ||
              latestAudit.reason !== reason
            )
              return yield* new SkillStoreConflictError({
                id: row.id,
                reason: "Skill promotion replay does not match the canonical approval",
              })
            const receiptDigest = canonicalHash({
              action: "skill_promoted",
              candidateID: row.id,
              deploymentDigest: existingDeployment.deployment_digest,
            })!
            return { candidate: toProjection(row), deployment: toDeployment(existingDeployment), receiptDigest }
          }
          if (row.status !== "canary" || row.revision !== input.expectedRevision)
            return yield* new SkillStoreConflictError({
              id: row.id,
              reason: "Skill is not the expected canary revision",
            })
          const observations = yield* db
            .select()
            .from(SkillCanaryObservationTable)
            .where(
              and(
                ownership(SkillCanaryObservationTable, identity),
                eq(SkillCanaryObservationTable.candidate_id, row.id),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const canary = yield* Effect.try({
            try: () => summarizeCanary(row.id, row.status, observations),
            catch: storeFailure,
          })
          if (!canary.promotionReady)
            return yield* new SkillStoreError({ reason: "Skill canary promotion gate failed" })
          if ((existingDeployment?.active_candidate_id ?? null) !== (row.baseline_version_id ?? null))
            return yield* new SkillStoreConflictError({ id: row.id, reason: "active Skill baseline changed" })
          const baseline = existingDeployment
            ? yield* getVersionRow(identity, existingDeployment.active_candidate_id)
            : undefined
          if (existingDeployment && (!baseline || baseline.status !== "active"))
            return yield* new SkillStoreError({ reason: "active Skill baseline is unavailable" })
          const candidate = decodeSkill(row.skill_record)
          if (baseline)
            yield* Effect.try({
              try: () => ensureNoPermissionExpansion(decodeSkill(baseline.skill_record), candidate),
              catch: storeFailure,
            })
          const now = input.now ?? Date.now()
          const active = yield* Effect.try({ try: () => transition(candidate, "active", { now }), catch: storeFailure })
          const revision = row.revision + 1
          const activeRecordDigest = versionDigest({ ...toProjection(row), skill: active, revision })
          const generation = (existingDeployment?.generation ?? 0) + 1
          const deploymentDigest = canonicalHash({
            skillID: row.skill_id,
            activeCandidateID: row.id,
            previousCandidateID: baseline?.id ?? null,
            generation,
          })
          if (!deploymentDigest)
            return yield* new SkillStoreError({ reason: "Skill deployment is not canonicalizable" })
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (baseline) {
                  const baselineSkill = decodeSkill(baseline.skill_record)
                  const retired = transition(baselineSkill, "retired", { now })
                  const baselineRevision = baseline.revision + 1
                  const baselineDigest = versionDigest({
                    ...toProjection(baseline),
                    skill: retired,
                    revision: baselineRevision,
                  })
                  const retiredRow = yield* tx
                    .update(SkillVersionTable)
                    .set({
                      skill_record: encodeSkill(retired),
                      status: "retired",
                      revision: baselineRevision,
                      record_digest: baselineDigest,
                      time_updated: now,
                    })
                    .where(
                      and(
                        ownership(SkillVersionTable, identity),
                        eq(SkillVersionTable.id, baseline.id),
                        eq(SkillVersionTable.revision, baseline.revision),
                        eq(SkillVersionTable.status, "active"),
                      ),
                    )
                    .returning()
                    .get()
                  if (!retiredRow) throw new Error("Skill baseline changed during promotion")
                  yield* appendAudit(tx, identity, {
                    aggregateID: baseline.id,
                    action: "retired_for_successor",
                    actor: identity.actor,
                    reason,
                    metadata: { successorCandidateID: row.id },
                  })
                }
                const next = yield* tx
                  .update(SkillVersionTable)
                  .set({
                    skill_record: encodeSkill(active),
                    status: "active",
                    revision,
                    record_digest: activeRecordDigest,
                    time_updated: now,
                  })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, row.id),
                      eq(SkillVersionTable.revision, row.revision),
                      eq(SkillVersionTable.status, "canary"),
                    ),
                  )
                  .returning()
                  .get()
                if (!next) throw new Error("Skill canary changed during promotion")
                const deployment = yield* tx
                  .insert(SkillDeploymentTable)
                  .values({
                    tenant_id: identity.tenantID,
                    owner_user_id: identity.userID,
                    skill_id: row.skill_id,
                    active_candidate_id: row.id,
                    previous_candidate_id: baseline?.id ?? null,
                    generation,
                    deployment_digest: deploymentDigest,
                    time_updated: now,
                  })
                  .onConflictDoUpdate({
                    target: [
                      SkillDeploymentTable.tenant_id,
                      SkillDeploymentTable.owner_user_id,
                      SkillDeploymentTable.skill_id,
                    ],
                    set: {
                      active_candidate_id: row.id,
                      previous_candidate_id: baseline?.id ?? null,
                      generation,
                      deployment_digest: deploymentDigest,
                      time_updated: now,
                    },
                  })
                  .returning()
                  .get()
                yield* appendAudit(tx, identity, {
                  aggregateID: row.id,
                  action: "promoted",
                  actor: identity.actor,
                  reason,
                  metadata: {
                    deploymentDigest,
                    generation,
                    observations: observations.length,
                    successRate: canary.successRate,
                  },
                })
                return { next, deployment }
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          const receiptDigest = canonicalHash({
            action: "skill_promoted",
            candidateID: row.id,
            deploymentDigest,
          })!
          return { candidate: toProjection(result.next), deployment: toDeployment(result.deployment), receiptDigest }
        }).pipe(Effect.mapError(storeFailure)),
      )

    const rollback: Interface["rollback"] = (input) =>
      asPrincipal(input.identity, (identity) =>
        Effect.gen(function* () {
          const reason = bounded(input.reason, "rollback reason", 500)
          const row = yield* getVersionRow(identity, input.candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: input.candidateID })
          const deployment = yield* getDeploymentRow(identity, row.skill_id)
          if (
            row.status === "retired" &&
            row.rollback_version &&
            deployment &&
            deployment.active_candidate_id !== row.id
          ) {
            const latestAudit = yield* db
              .select()
              .from(SkillAuditTable)
              .where(and(ownership(SkillAuditTable, identity), eq(SkillAuditTable.aggregate_id, row.id)))
              .orderBy(desc(SkillAuditTable.sequence))
              .get()
              .pipe(Effect.orDie)
            if (
              row.revision !== input.expectedRevision + 1 ||
              latestAudit?.action !== "rolled_back" ||
              latestAudit.actor !== identity.actor ||
              latestAudit.reason !== reason
            )
              return yield* new SkillStoreConflictError({
                id: row.id,
                reason: "Skill rollback replay does not match the canonical request",
              })
            const restored = yield* getVersionRow(identity, deployment.active_candidate_id)
            if (!restored) return yield* new SkillStoreError({ reason: "restored Skill version is unavailable" })
            const receiptDigest = canonicalHash({
              action: "skill_rolled_back",
              candidateID: row.id,
              restoredCandidateID: restored.id,
              deploymentDigest: deployment.deployment_digest,
            })!
            return {
              rolledBack: toProjection(row),
              restored: toProjection(restored),
              deployment: toDeployment(deployment),
              receiptDigest,
            }
          }
          if (!deployment || deployment.active_candidate_id !== row.id || row.status !== "active")
            return yield* new SkillStoreConflictError({ id: row.id, reason: "Skill is not the active deployment" })
          if (row.revision !== input.expectedRevision)
            return yield* new SkillStoreConflictError({ id: row.id, reason: "Skill revision changed before rollback" })
          if (!deployment.previous_candidate_id)
            return yield* new SkillStoreError({ reason: "Skill deployment has no rollback version" })
          const previous = yield* getVersionRow(identity, deployment.previous_candidate_id)
          if (!previous || previous.status !== "retired")
            return yield* new SkillStoreError({ reason: "Skill rollback version is unavailable" })
          const now = input.now ?? Date.now()
          const currentSkill = decodeSkill(row.skill_record)
          const previousSkill = decodeSkill(previous.skill_record)
          const retired = transition(currentSkill, "retired", { now, rollbackVersion: previousSkill.version })
          const restored = SkillContract.Skill.make({
            ...previousSkill,
            status: "active",
            rollbackVersion: undefined,
            updatedAt: DateTime.makeUnsafe(now),
          })
          const currentRevision = row.revision + 1
          const previousRevision = previous.revision + 1
          const currentDigest = versionDigest({
            ...toProjection(row),
            skill: retired,
            revision: currentRevision,
            rollbackVersion: previousSkill.version,
          })
          const previousDigest = versionDigest({
            ...toProjection(previous),
            skill: restored,
            revision: previousRevision,
            rollbackVersion: undefined,
          })
          const generation = deployment.generation + 1
          const deploymentDigest = canonicalHash({
            skillID: row.skill_id,
            activeCandidateID: previous.id,
            previousCandidateID: row.id,
            generation,
          })
          if (!deploymentDigest) return yield* new SkillStoreError({ reason: "Skill rollback is not canonicalizable" })
          const result = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const rolledBack = yield* tx
                  .update(SkillVersionTable)
                  .set({
                    skill_record: encodeSkill(retired),
                    status: "retired",
                    rollback_version: previousSkill.version,
                    revision: currentRevision,
                    record_digest: currentDigest,
                    time_updated: now,
                  })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, row.id),
                      eq(SkillVersionTable.revision, row.revision),
                      eq(SkillVersionTable.status, "active"),
                    ),
                  )
                  .returning()
                  .get()
                const restoredRow = yield* tx
                  .update(SkillVersionTable)
                  .set({
                    skill_record: encodeSkill(restored),
                    status: "active",
                    rollback_version: null,
                    revision: previousRevision,
                    record_digest: previousDigest,
                    time_updated: now,
                  })
                  .where(
                    and(
                      ownership(SkillVersionTable, identity),
                      eq(SkillVersionTable.id, previous.id),
                      eq(SkillVersionTable.revision, previous.revision),
                      eq(SkillVersionTable.status, "retired"),
                    ),
                  )
                  .returning()
                  .get()
                if (!rolledBack || !restoredRow) throw new Error("Skill deployment changed during rollback")
                const nextDeployment = yield* tx
                  .update(SkillDeploymentTable)
                  .set({
                    active_candidate_id: previous.id,
                    previous_candidate_id: row.id,
                    generation,
                    deployment_digest: deploymentDigest,
                    time_updated: now,
                  })
                  .where(
                    and(
                      ownership(SkillDeploymentTable, identity),
                      eq(SkillDeploymentTable.skill_id, row.skill_id),
                      eq(SkillDeploymentTable.generation, deployment.generation),
                      eq(SkillDeploymentTable.active_candidate_id, row.id),
                    ),
                  )
                  .returning()
                  .get()
                if (!nextDeployment) throw new Error("Skill deployment changed during rollback")
                yield* appendAudit(tx, identity, {
                  aggregateID: row.id,
                  action: "rolled_back",
                  actor: identity.actor,
                  reason,
                  metadata: { restoredCandidateID: previous.id, deploymentDigest, generation },
                })
                yield* appendAudit(tx, identity, {
                  aggregateID: previous.id,
                  action: "restored",
                  actor: identity.actor,
                  reason,
                  metadata: { rolledBackCandidateID: row.id, deploymentDigest, generation },
                })
                return { rolledBack, restoredRow, nextDeployment }
              }),
            )
            .pipe(Effect.mapError(storeFailure))
          const receiptDigest = canonicalHash({
            action: "skill_rolled_back",
            candidateID: row.id,
            restoredCandidateID: previous.id,
            deploymentDigest,
          })!
          return {
            rolledBack: toProjection(result.rolledBack),
            restored: toProjection(result.restoredRow),
            deployment: toDeployment(result.nextDeployment),
            receiptDigest,
          }
        }).pipe(Effect.mapError(storeFailure)),
      )

    const getCandidate: Interface["getCandidate"] = (identity, candidateID) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const row = yield* getVersionRow(normalized, candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: candidateID })
          return toProjection(row)
        }),
      )

    const getCandidateDetail: Interface["getCandidateDetail"] = (identity, candidateID) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const row = yield* getVersionRow(normalized, candidateID)
          if (!row) return yield* new SkillStoreNotFoundError({ kind: "candidate", id: candidateID })
          const [evaluationRow, observations] = yield* Effect.all([
            db
              .select()
              .from(SkillEvaluationTable)
              .where(
                and(ownership(SkillEvaluationTable, normalized), eq(SkillEvaluationTable.candidate_id, candidateID)),
              )
              .get()
              .pipe(Effect.orDie),
            db
              .select()
              .from(SkillCanaryObservationTable)
              .where(
                and(
                  ownership(SkillCanaryObservationTable, normalized),
                  eq(SkillCanaryObservationTable.candidate_id, candidateID),
                ),
              )
              .orderBy(asc(SkillCanaryObservationTable.time_created))
              .all()
              .pipe(Effect.orDie),
          ])
          const evaluation = yield* Effect.try({
            try: () => {
              if (!evaluationRow) {
                if (row.evaluation_digest || row.evaluation_passed !== null)
                  throw new Error("canonical Skill evaluation is unavailable")
                return undefined
              }
              const report = decodeReport(evaluationRow.report)
              if (
                row.evaluation_digest !== evaluationRow.report_digest ||
                row.evaluation_passed !== evaluationRow.passed ||
                canonicalHash(report) !== evaluationRow.report_digest
              )
                throw new Error("stored Skill evaluation failed integrity verification")
              return report
            },
            catch: storeFailure,
          })
          const canary = yield* Effect.try({
            try: () => summarizeCanary(row.id, row.status, observations),
            catch: storeFailure,
          })
          return { candidate: toProjection(row), evaluation, canary }
        }),
      )

    const listCandidates: Interface["listCandidates"] = (identity, input = {}) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
          const rows = yield* db
            .select()
            .from(SkillVersionTable)
            .where(
              and(
                ownership(SkillVersionTable, normalized),
                input.skillID ? eq(SkillVersionTable.skill_id, SkillContract.SkillID.make(input.skillID)) : undefined,
                input.status ? eq(SkillVersionTable.status, input.status) : undefined,
              ),
            )
            .orderBy(desc(SkillVersionTable.time_updated))
            .limit(limit)
            .all()
            .pipe(Effect.orDie)
          return rows.map(toProjection)
        }),
      )

    const getDeployment: Interface["getDeployment"] = (identity, skillID) =>
      asPrincipal(identity, (normalized) =>
        getDeploymentRow(normalized, SkillContract.SkillID.make(skillID)).pipe(
          Effect.map((row) => (row ? toDeployment(row) : undefined)),
        ),
      )

    const verifyAudit: Interface["verifyAudit"] = (identity, candidateID) =>
      asPrincipal(identity, (normalized) =>
        Effect.gen(function* () {
          const rows: ReadonlyArray<AuditRow> = yield* db
            .select()
            .from(SkillAuditTable)
            .where(and(ownership(SkillAuditTable, normalized), eq(SkillAuditTable.aggregate_id, candidateID)))
            .orderBy(asc(SkillAuditTable.sequence))
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
            if (row.sequence !== index + 1 || row.previous_hash !== previous || expected !== row.record_hash)
              return { valid: false, events: rows.length, headHash: previous }
            previous = row.record_hash
          }
          return { valid: true, events: rows.length, headHash: previous }
        }),
      )

    return Service.of({
      createCandidate,
      recordEvaluation,
      startCanary,
      recordCanaryObservation,
      promote,
      rollback,
      getCandidate,
      getCandidateDetail,
      listCandidates,
      getDeployment,
      verifyAudit,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, ExperienceStoreV1.node, DurableRun.globalNode, RuntimeEvaluation.node],
})

export const Policy = Object.freeze({
  minimumCanaryObservations: MINIMUM_CANARY_OBSERVATIONS,
  minimumCanarySuccessRate: MINIMUM_CANARY_SUCCESS_RATE,
})

export type { CompilerFile, CompilerTestCase, SecurityScan }
