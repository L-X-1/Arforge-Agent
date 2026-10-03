export * as DurableEvolutionV1 from "./durable"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, desc, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { DurableRun } from "../runtime/durable-run"
import { EvaluationResultTable } from "../runtime/sql"
import { canonicalHash } from "../util/canonical-hash"
import { EvolutionLevels } from "./level"
import {
  canaryReportFor,
  parsePromotionEvaluationReport,
  PromotionGate,
  type PromotionGateReceipt,
} from "./promotion-gate"
import { verifySourceProvenance, type SourceProvenanceVerification } from "./source-provenance"
import { ConstitutionKernel, policyFromEnv } from "./runtime"
import {
  EvolutionArtifactTable,
  EvolutionAuditTable,
  EvolutionEvaluationTable,
  EvolutionObservationTable,
  EvolutionProposalTable,
} from "./sql"

const DIGEST = /^[a-f0-9]{64}$/i
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const PROPOSAL_ID = /^evo_[A-Za-z0-9_-]{4,255}$/
export interface TrustedEvolutionIdentity {
  readonly tenantID: string
  readonly userID: string
  /** Trusted server identity, never a renderer-provided product placeholder. */
  readonly actor: string
}

export interface ArtifactInput {
  readonly digest: string
  readonly kind: string
  readonly uri: string
  readonly content: string
}

export interface ProposalProjection {
  readonly proposalID: string
  readonly candidateID: string
  readonly artifactDigest: string
  readonly artifactRef: string
  readonly manifest: Record<string, unknown>
  readonly state: Record<string, unknown>
  readonly status: string
  readonly revision: number
  readonly evaluationID?: string
  readonly controlRunID?: string
  readonly createdBy: string
  readonly createdAt: number
  readonly updatedAt: number
}

export class DurableEvolutionError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "DurableEvolutionError"
  }
}

export class DurableEvolutionNotFoundError extends Schema.TaggedErrorClass<DurableEvolutionNotFoundError>()(
  "DurableEvolution.NotFound",
  { proposalID: Schema.String },
) {}

export class DurableEvolutionConflictError extends Schema.TaggedErrorClass<DurableEvolutionConflictError>()(
  "DurableEvolution.Conflict",
  { proposalID: Schema.String, expectedRevision: Schema.Number, actualRevision: Schema.Number },
) {}

export class DurableEvolutionArtifactConflictError extends Schema.TaggedErrorClass<DurableEvolutionArtifactConflictError>()(
  "DurableEvolution.ArtifactConflict",
  { digest: Schema.String },
) {}

export class DurableEvolutionIdentityError extends Schema.TaggedErrorClass<DurableEvolutionIdentityError>()(
  "DurableEvolution.Identity",
  { reason: Schema.String },
) {}

const normalizeIdentity = (identity: TrustedEvolutionIdentity): TrustedEvolutionIdentity => {
  const tenantID = identity.tenantID.trim()
  const userID = identity.userID.trim()
  const actor = identity.actor.trim()
  if (!ID.test(tenantID) || !ID.test(userID)) throw new DurableEvolutionError("tenantID and userID are invalid")
  if (!actor || actor === "user:product" || actor.toLowerCase().startsWith("runtime:"))
    throw new DurableEvolutionError("Evolution mutations require a trusted non-placeholder actor")
  return { tenantID, userID, actor }
}

const normalizeDigest = (digest: string, name: string) => {
  const normalized = digest.trim().toLowerCase()
  if (!DIGEST.test(normalized)) throw new DurableEvolutionError(`${name} must be a 64-character hex digest`)
  return normalized
}

const normalizeProposalID = (proposalID: string) => {
  const normalized = proposalID.trim()
  if (!PROPOSAL_ID.test(normalized)) throw new DurableEvolutionError("proposalID is invalid")
  return AgentRuntime.EvolutionProposalID.make(normalized)
}

const normalizeStatus = (status: string): AgentRuntime.EvolutionStatus => {
  switch (status) {
    case "signal":
    case "proposal":
    case "candidate":
    case "sandbox_evaluation":
    case "rejected":
    case "eligible":
    case "canary":
    case "promoted":
    case "monitoring":
    case "retained":
    case "rolled_back":
    case "archived":
      return status
    default:
      throw new DurableEvolutionError(`unsupported status: ${status}`)
  }
}

const validateConstitutionBinding = (
  proposal: AgentRuntime.EvolutionProposal,
  manifest: Record<string, unknown>,
): void => {
  let target: string
  try {
    target = ConstitutionKernel.validateTarget(proposal.target)
  } catch (error) {
    throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
  }
  if (manifest.target !== target)
    throw new DurableEvolutionError("proposal target is not bound to the candidate manifest")
  if (manifest.constitution_version !== proposal.constitutionVersion)
    throw new DurableEvolutionError("proposal Constitution version is not bound to the candidate manifest")
  if (proposal.evolutionLevel !== "L2" || manifest.evolution_level !== proposal.evolutionLevel)
    throw new DurableEvolutionError("candidate manifest must declare the bounded L2 Evolution level")
  try {
    EvolutionLevels.assert({
      level: "L2",
      operation: "create_candidate",
      candidateKind: proposal.candidateKind,
    })
  } catch (error) {
    throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
  }
  if (proposal.status !== "proposal" && proposal.status !== "candidate")
    throw new DurableEvolutionError("new Evolution candidates must start as an inert L2 proposal")
  const manifestExperienceIDs = Array.isArray(manifest.source_experience_ids)
    ? manifest.source_experience_ids.filter((item): item is string => typeof item === "string")
    : []
  if (canonicalHash(manifestExperienceIDs) !== canonicalHash(proposal.sourceExperienceIDs.map(String)))
    throw new DurableEvolutionError("proposal source Experience IDs are not bound to the candidate manifest")
}

const validateRollbackBinding = (
  proposal: AgentRuntime.EvolutionProposal,
  manifest: Record<string, unknown>,
  rollbackArtifact: ArtifactInput | undefined,
): void => {
  const rollback =
    typeof manifest.rollback_artifact === "object" &&
    manifest.rollback_artifact !== null &&
    !Array.isArray(manifest.rollback_artifact)
      ? Object.fromEntries(Object.entries(manifest.rollback_artifact))
      : undefined
  if (proposal.rollbackArtifactID === undefined) {
    if (rollback !== undefined || rollbackArtifact !== undefined)
      throw new DurableEvolutionError("rollback artifact must be bound to the canonical proposal")
    return
  }
  if (!rollback || !rollbackArtifact)
    throw new DurableEvolutionError("candidate rollback artifact and plan are required")
  const digest = normalizeDigest(rollbackArtifact.digest, "rollback artifact digest")
  if (
    rollback.artifact_id !== proposal.rollbackArtifactID ||
    rollback.digest !== digest ||
    rollback.operation !== "deactivate_strategy_overlay" ||
    typeof rollback.plan_digest !== "string" ||
    !DIGEST.test(rollback.plan_digest)
  )
    throw new DurableEvolutionError("rollback artifact is not bound to the candidate manifest")
}

const validateSourceProvenanceBinding = (
  proposal: AgentRuntime.EvolutionProposal,
  manifest: Record<string, unknown>,
  sourceProvenanceArtifact: ArtifactInput | undefined,
): void => {
  const sourceExperienceIDs = Array.isArray(manifest.source_experience_ids)
    ? manifest.source_experience_ids.filter((item): item is string => typeof item === "string")
    : []
  const sourceEvidenceIDs = Array.isArray(manifest.source_evidence_ids)
    ? manifest.source_evidence_ids.filter((item): item is string => typeof item === "string")
    : []
  const sourceEvaluationIDs = Array.isArray(manifest.source_evaluation_ids)
    ? manifest.source_evaluation_ids.filter((item): item is string => typeof item === "string")
    : []
  const binding = recordValue(manifest.source_provenance_artifact)
  if (sourceExperienceIDs.length === 0 && sourceEvidenceIDs.length === 0) {
    if (binding !== undefined || sourceProvenanceArtifact !== undefined)
      throw new DurableEvolutionError("empty source provenance must not bind an artifact")
    return
  }
  if (!binding || !sourceProvenanceArtifact)
    throw new DurableEvolutionError("source Experience/Evidence require an immutable provenance artifact")
  let verified
  try {
    verified = verifySourceProvenance({ manifest, artifact: sourceProvenanceArtifact })
  } catch (error) {
    throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
  }
  if (canonicalHash(verified.experienceIDs) !== canonicalHash(proposal.sourceExperienceIDs.map(String)))
    throw new DurableEvolutionError("source provenance is not bound to the canonical proposal")
  if (canonicalHash(verified.evidenceIDs) !== canonicalHash(sourceEvidenceIDs))
    throw new DurableEvolutionError("source Evidence is not bound to the candidate manifest")
  if (canonicalHash(verified.evaluationIDs) !== canonicalHash(sourceEvaluationIDs))
    throw new DurableEvolutionError("source EvaluationResult is not bound to the candidate manifest")
}

const validateStoredConstitution = (manifest: Record<string, unknown>): Record<string, unknown> => {
  if (typeof manifest.target !== "string") throw new DurableEvolutionError("candidate manifest target is missing")
  try {
    ConstitutionKernel.validateTarget(manifest.target)
  } catch (error) {
    throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
  }
  const level = manifest.evolution_level ?? "L2"
  if (level !== "L2") throw new DurableEvolutionError("stored candidate artifact escaped the L2 boundary")
  return manifest.evolution_level === "L2" ? manifest : { ...manifest, evolution_level: "L2" }
}

const stateAtLevel = (
  state: Record<string, unknown>,
  status: AgentRuntime.EvolutionStatus,
): Record<string, unknown> => ({ ...state, evolution_level: EvolutionLevels.forStatus(status) })

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const observationCohort = (value: string): "candidate" | "control" => {
  if (value === "candidate") return "candidate"
  if (value === "control") return "control"
  throw new DurableEvolutionError("stored canary observation cohort is invalid")
}

const validateTransitionLevel = (input: {
  readonly identity: TrustedEvolutionIdentity
  readonly from: AgentRuntime.EvolutionStatus
  readonly to: AgentRuntime.EvolutionStatus
  readonly currentState: Record<string, unknown>
  readonly nextState: Record<string, unknown>
}): void => {
  if (input.to === "canary") {
    if (input.from !== "eligible" || !recordValue(input.currentState.approval))
      throw new DurableEvolutionError("L3 canary requires an approved L2 candidate")
    try {
      ConstitutionKernel.requireHuman(input.identity.actor)
      EvolutionLevels.assert({
        level: "L3",
        operation: "start_canary",
        candidateKind: "skill",
        isolated: true,
        reversible: true,
      })
    } catch (error) {
      throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
    }
  }
  if (input.to === "promoted") {
    if (input.from !== "canary" || !recordValue(input.currentState.approval))
      throw new DurableEvolutionError("L4 promotion requires an approved L3 canary")
    const deployment = recordValue(input.nextState.deployment)
    if (deployment?.stage !== "promoted" || deployment.traffic_percent !== 100)
      throw new DurableEvolutionError("L4 promotion must be a controlled 100% deployment")
    try {
      ConstitutionKernel.requireHuman(input.identity.actor)
      EvolutionLevels.assert({
        level: "L4",
        operation: "promote",
        candidateKind: "skill",
        humanApproved: true,
        controlled: true,
        rollbackReady: true,
      })
    } catch (error) {
      throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
    }
  }
  if (input.to === "monitoring" || input.to === "retained")
    throw new DurableEvolutionError(`Evolution status ${input.to} has no enabled capability-level transition`)
}

const normalizeContent = (content: string) => {
  if (content.length > 4 * 1024 * 1024) throw new DurableEvolutionError("artifact content exceeds 4 MiB")
  return content
}

type OwnedTable =
  | typeof EvolutionArtifactTable
  | typeof EvolutionAuditTable
  | typeof EvolutionEvaluationTable
  | typeof EvolutionObservationTable
  | typeof EvolutionProposalTable

const ownership = (table: OwnedTable, identity: TrustedEvolutionIdentity) =>
  and(eq(table.tenant_id, identity.tenantID), eq(table.owner_user_id, identity.userID))

const proposalFromRow = (row: typeof EvolutionProposalTable.$inferSelect): ProposalProjection => {
  const manifest = validateStoredConstitution(row.manifest)
  const status = normalizeStatus(row.status)
  return {
    proposalID: row.id,
    candidateID: row.candidate_id,
    artifactDigest: row.artifact_digest,
    artifactRef: row.artifact_ref,
    manifest,
    state: stateAtLevel(row.state, status),
    status,
    revision: row.revision,
    ...(row.evaluation_id ? { evaluationID: row.evaluation_id } : {}),
    ...(row.control_run_id ? { controlRunID: row.control_run_id } : {}),
    createdBy: row.created_by,
    createdAt: row.time_created,
    updatedAt: row.time_updated,
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
  aggregateID: input.aggregateID,
  sequence: input.sequence,
  action: input.action,
  actor: input.actor,
  reason: input.reason,
  metadata: input.metadata,
  previousHash: input.previousHash,
})

const audit = (
  db: Database.Interface["db"],
  identity: TrustedEvolutionIdentity,
  input: Parameters<typeof auditPayload>[0],
) =>
  Effect.gen(function* () {
    const previous = yield* db
      .select({ recordHash: EvolutionAuditTable.record_hash })
      .from(EvolutionAuditTable)
      .where(and(ownership(EvolutionAuditTable, identity), eq(EvolutionAuditTable.aggregate_id, input.aggregateID)))
      .orderBy(desc(EvolutionAuditTable.sequence))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const previousHash = previous?.recordHash ?? input.previousHash
    const payload = auditPayload({ ...input, previousHash })
    const recordHash = canonicalHash(payload)
    if (!recordHash) return yield* Effect.die(new DurableEvolutionError("audit payload is not canonicalizable"))
    yield* db
      .insert(EvolutionAuditTable)
      .values({
        tenant_id: identity.tenantID,
        owner_user_id: identity.userID,
        aggregate_id: input.aggregateID,
        sequence: input.sequence,
        action: input.action,
        actor: input.actor,
        reason: input.reason,
        metadata: input.metadata,
        previous_hash: previousHash,
        record_hash: recordHash,
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

export interface Interface {
  readonly registerArtifact: (
    identity: TrustedEvolutionIdentity,
    input: ArtifactInput,
  ) => Effect.Effect<void, DurableEvolutionArtifactConflictError | DurableEvolutionIdentityError>
  readonly createProposal: (input: {
    readonly identity: TrustedEvolutionIdentity
    readonly proposal: AgentRuntime.EvolutionProposal
    readonly candidateID: string
    readonly artifact: ArtifactInput
    readonly rollbackArtifact?: ArtifactInput
    readonly sourceProvenanceArtifact?: ArtifactInput
    readonly manifest: Record<string, unknown>
    readonly state: Record<string, unknown>
    readonly artifactRef: string
  }) => Effect.Effect<ProposalProjection, DurableEvolutionError | DurableEvolutionArtifactConflictError>
  readonly getProposal: (
    identity: TrustedEvolutionIdentity,
    proposalID: string,
  ) => Effect.Effect<ProposalProjection, DurableEvolutionNotFoundError | DurableEvolutionIdentityError>
  readonly getProposalByCandidate: (
    identity: TrustedEvolutionIdentity,
    candidateID: string,
  ) => Effect.Effect<ProposalProjection, DurableEvolutionNotFoundError | DurableEvolutionIdentityError>
  readonly listProposals: (
    identity: TrustedEvolutionIdentity,
    input?: { readonly status?: string; readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<ProposalProjection>, DurableEvolutionIdentityError>
  /** Rebuilds every promotion prerequisite from durable rows and returns a digest-bound receipt. */
  readonly preparePromotionGate: (input: {
    readonly identity: TrustedEvolutionIdentity
    readonly proposalID: string
    readonly actor: string
  }) => Effect.Effect<PromotionGateReceipt, DurableEvolutionError | DurableEvolutionNotFoundError>
  readonly transition: (input: {
    readonly identity: TrustedEvolutionIdentity
    readonly proposalID: string
    readonly expectedRevision: number
    readonly from: AgentRuntime.EvolutionStatus
    readonly to: AgentRuntime.EvolutionStatus
    readonly state: Record<string, unknown>
    readonly reason: string
    readonly metadata?: Record<string, unknown>
  }) => Effect.Effect<
    ProposalProjection,
    | DurableEvolutionError
    | DurableEvolutionConflictError
    | DurableEvolutionNotFoundError
    | DurableEvolutionIdentityError
  >
  readonly recordEvaluation: (input: {
    readonly identity: TrustedEvolutionIdentity
    readonly proposalID: string
    readonly expectedRevision: number
    readonly evaluation: AgentRuntime.EvaluationResult
    readonly report: Record<string, unknown>
    readonly reason: string
  }) => Effect.Effect<
    ProposalProjection,
    | DurableEvolutionError
    | DurableEvolutionConflictError
    | DurableEvolutionNotFoundError
    | DurableEvolutionIdentityError
  >
  readonly verifyAudit: (
    identity: TrustedEvolutionIdentity,
    aggregateID: string,
  ) => Effect.Effect<
    { readonly valid: boolean; readonly events: number; readonly headHash: string },
    DurableEvolutionIdentityError
  >
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/DurableEvolution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const runs = yield* DurableRun.Service

    const withIdentity = <A, E>(
      identity: TrustedEvolutionIdentity,
      effect: (normalized: TrustedEvolutionIdentity) => Effect.Effect<A, E>,
    ) => {
      let normalized: TrustedEvolutionIdentity
      try {
        normalized = normalizeIdentity(identity)
      } catch (error) {
        return Effect.fail(
          new DurableEvolutionIdentityError({ reason: error instanceof Error ? error.message : String(error) }),
        )
      }
      return database.runAsPrincipal(normalized, effect(normalized))
    }

    const getRow = (identity: TrustedEvolutionIdentity, proposalID: string) =>
      db
        .select()
        .from(EvolutionProposalTable)
        .where(and(ownership(EvolutionProposalTable, identity), eq(EvolutionProposalTable.id, proposalID)))
        .get()
        .pipe(Effect.orDie)

    const preparePromotionGateUnsafe = Effect.fn("DurableEvolution.preparePromotionGate")(function* (input: {
      readonly identity: TrustedEvolutionIdentity
      readonly proposalID: string
      readonly actor: string
    }) {
      const proposalID = normalizeProposalID(input.proposalID)
      const current = yield* getRow(input.identity, proposalID)
      if (!current) return yield* new DurableEvolutionNotFoundError({ proposalID })
      if (current.status !== "canary" && current.status !== "promoted")
        throw new DurableEvolutionError("promotion gate can only be evaluated for a canary")
      const manifest = validateStoredConstitution(current.manifest)

      const candidateArtifact = yield* db
        .select()
        .from(EvolutionArtifactTable)
        .where(
          and(
            ownership(EvolutionArtifactTable, input.identity),
            eq(EvolutionArtifactTable.digest, current.artifact_digest),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      let artifactVerified = false
      if (candidateArtifact) {
        let content: unknown
        try {
          content = JSON.parse(candidateArtifact.content)
        } catch {
          content = undefined
        }
        const contentRecord = recordValue(content)
        const manifestCore = Object.fromEntries(
          Object.entries(manifest).filter(([key]) => key !== "candidate_id" && key !== "artifact_digest"),
        )
        artifactVerified =
          manifest.candidate_id === current.candidate_id &&
          manifest.artifact_digest === current.artifact_digest &&
          contentRecord !== undefined &&
          canonicalHash(contentRecord) === canonicalHash(manifestCore) &&
          canonicalHash({
            kind: candidateArtifact.kind,
            uri: candidateArtifact.uri,
            content: candidateArtifact.content,
          }) === current.artifact_digest
      }

      const rollback = recordValue(manifest.rollback_artifact)
      const rollbackDigest = typeof rollback?.digest === "string" ? rollback.digest : ""
      const rollbackArtifact = DIGEST.test(rollbackDigest)
        ? yield* db
            .select()
            .from(EvolutionArtifactTable)
            .where(
              and(ownership(EvolutionArtifactTable, input.identity), eq(EvolutionArtifactTable.digest, rollbackDigest)),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      let rollbackArtifactVerified = false
      if (rollback && rollbackArtifact) {
        let plan: unknown
        try {
          plan = JSON.parse(rollbackArtifact.content)
        } catch {
          plan = undefined
        }
        const planRecord = recordValue(plan)
        rollbackArtifactVerified =
          rollback.artifact_id === `art_${rollbackDigest.slice(0, 32)}` &&
          rollback.operation === "deactivate_strategy_overlay" &&
          typeof rollback.plan_digest === "string" &&
          planRecord?.operation === rollback.operation &&
          canonicalHash(planRecord) === rollback.plan_digest &&
          canonicalHash({
            kind: rollbackArtifact.kind,
            uri: rollbackArtifact.uri,
            content: rollbackArtifact.content,
          }) === rollbackDigest
      }

      const sourceBinding = recordValue(manifest.source_provenance_artifact)
      const sourceArtifactDigest = typeof sourceBinding?.digest === "string" ? sourceBinding.digest : ""
      const sourceProvenanceArtifact = DIGEST.test(sourceArtifactDigest)
        ? yield* db
            .select()
            .from(EvolutionArtifactTable)
            .where(
              and(
                ownership(EvolutionArtifactTable, input.identity),
                eq(EvolutionArtifactTable.digest, sourceArtifactDigest),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      let sourceProvenanceVerified = false
      let sourceProvenance: SourceProvenanceVerification | undefined
      if (sourceProvenanceArtifact) {
        try {
          sourceProvenance = verifySourceProvenance({
            manifest,
            artifact: sourceProvenanceArtifact,
          })
          sourceProvenanceVerified = sourceProvenance.verified
        } catch (error) {
          throw new DurableEvolutionError(
            `source provenance artifact verification failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (sourceProvenanceVerified && sourceProvenance) {
        for (const runID of sourceProvenance.runIDs) {
          const loaded = yield* runs.load(AgentRuntime.RunID.make(runID)).pipe(Effect.exit)
          if (Exit.isFailure(loaded) || loaded.value.run.status !== "completed") {
            throw new DurableEvolutionError(`source provenance Run is missing, corrupt, or non-terminal: ${runID}`)
          }
        }
      }
      if (sourceProvenanceVerified && sourceProvenance) {
        for (const sourceEvaluation of sourceProvenance.evaluations) {
          const row = yield* db
            .select()
            .from(EvaluationResultTable)
            .where(
              and(
                eq(EvaluationResultTable.tenant_id, input.identity.tenantID),
                eq(EvaluationResultTable.owner_user_id, input.identity.userID),
                eq(EvaluationResultTable.id, sourceEvaluation.result.id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row || row.run_id !== sourceEvaluation.runID || row.passed !== true) {
            throw new DurableEvolutionError(
              `source provenance EvaluationResult is missing, failed, or bound to another Run: ${sourceEvaluation.result.id}`,
            )
          }
          const storedResult = AgentRuntime.EvaluationResult.make({
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
          })
          const storedEncoded = Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(storedResult)
          const sourceEncoded = Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(sourceEvaluation.result)
          if (canonicalHash(storedEncoded) !== canonicalHash(sourceEncoded)) {
            throw new DurableEvolutionError(
              `source provenance EvaluationResult differs from its durable record: ${sourceEvaluation.result.id}`,
            )
          }
        }
      }

      const evaluationRow = current.evaluation_id
        ? yield* db
            .select()
            .from(EvolutionEvaluationTable)
            .where(
              and(
                ownership(EvolutionEvaluationTable, input.identity),
                eq(EvolutionEvaluationTable.id, current.evaluation_id),
                eq(EvolutionEvaluationTable.proposal_id, current.id),
              ),
            )
            .get()
            .pipe(Effect.orDie)
        : undefined
      const envelope = recordValue(evaluationRow?.report)
      const evaluation = recordValue(envelope?.result)
      const reportValue = envelope?.report
      if (!evaluationRow || !envelope || !evaluation || reportValue === undefined)
        throw new DurableEvolutionError("promotion requires a durable baseline/candidate EvaluationResult")
      let evaluationReport
      try {
        evaluationReport = parsePromotionEvaluationReport(reportValue)
      } catch (error) {
        throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
      }
      const evaluationStorageVerified =
        evaluationRow.candidate_digest === current.artifact_digest &&
        evaluationRow.report_digest === canonicalHash(envelope) &&
        canonicalHash(current.state.evaluation) === canonicalHash(reportValue) &&
        canonicalHash(current.state.evaluation_result) === canonicalHash(evaluation)

      const observationRows = yield* db
        .select()
        .from(EvolutionObservationTable)
        .where(
          and(
            ownership(EvolutionObservationTable, input.identity),
            eq(EvolutionObservationTable.proposal_id, current.id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const observations = observationRows.map((item) => {
        return {
          id: item.id,
          candidateDigest: item.candidate_digest,
          cohort: observationCohort(item.cohort),
          success: item.success,
          score: item.score,
          safetyIncident: item.safety_incident,
          evidenceRef: item.evidence_ref,
          recordHash: item.record_hash,
        }
      })
      const policy = policyFromEnv()
      let canaryReport
      try {
        canaryReport = canaryReportFor({
          candidateID: current.candidate_id,
          candidateDigest: current.artifact_digest,
          observations,
          policy,
        })
      } catch (error) {
        throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
      }
      try {
        return PromotionGate.assert({
          actor: input.actor,
          candidateID: current.candidate_id,
          candidateDigest: current.artifact_digest,
          artifactVerified,
          sourceProvenanceVerified,
          manifest,
          evaluation,
          evaluationReport,
          evaluationStorageVerified,
          approval: recordValue(current.state.approval) ?? {},
          canaryReport,
          rollbackArtifactVerified,
          policy,
        })
      } catch (error) {
        throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
      }
    })

    const registerArtifactUnsafe = Effect.fn("DurableEvolution.registerArtifact")(function* (identity, input) {
      const normalized = identity
      const digest = normalizeDigest(input.digest, "artifact digest")
      const kind = input.kind.trim()
      const uri = input.uri.trim()
      const content = normalizeContent(input.content)
      if (!kind || !uri) return yield* new DurableEvolutionArtifactConflictError({ digest })
      const computed = canonicalHash({ kind, uri, content })
      if (computed !== digest) return yield* new DurableEvolutionArtifactConflictError({ digest })
      const existing = yield* db
        .select()
        .from(EvolutionArtifactTable)
        .where(and(ownership(EvolutionArtifactTable, normalized), eq(EvolutionArtifactTable.digest, digest)))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.kind !== kind || existing.uri !== uri || existing.content !== content)
          return yield* new DurableEvolutionArtifactConflictError({ digest })
        return undefined
      }
      const inserted = yield* db
        .insert(EvolutionArtifactTable)
        .values({
          tenant_id: normalized.tenantID,
          owner_user_id: normalized.userID,
          digest,
          kind,
          uri,
          byte_length: Buffer.byteLength(content, "utf8"),
          content,
          created_by: normalized.actor,
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!inserted) {
        const raced = yield* db
          .select()
          .from(EvolutionArtifactTable)
          .where(and(ownership(EvolutionArtifactTable, normalized), eq(EvolutionArtifactTable.digest, digest)))
          .get()
          .pipe(Effect.orDie)
        if (!raced || raced.content !== content || raced.uri !== uri || raced.kind !== kind)
          return yield* new DurableEvolutionArtifactConflictError({ digest })
      }
      return undefined
    })

    const getProposalUnsafe = Effect.fn("DurableEvolution.getProposal")(function* (identity, proposalID) {
      const normalized = identity
      const cleanID = normalizeProposalID(proposalID)
      const row = yield* getRow(normalized, cleanID)
      if (!row) return yield* new DurableEvolutionNotFoundError({ proposalID: cleanID })
      return proposalFromRow(row)
    })

    const createProposalUnsafe = Effect.fn("DurableEvolution.createProposal")(function* (input) {
      const identity = input.identity
      const proposalID = normalizeProposalID(input.proposal.id)
      const candidateID = input.candidateID.trim()
      if (!candidateID || !ID.test(candidateID)) throw new DurableEvolutionError("candidateID is invalid")
      const artifactDigest = normalizeDigest(input.artifact.digest, "artifact digest")
      if (input.proposal.id !== proposalID || input.proposal.candidateDigest !== artifactDigest)
        throw new DurableEvolutionError("proposal identity is not bound to the artifact digest")
      normalizeStatus(input.proposal.status)
      validateConstitutionBinding(input.proposal, input.manifest)
      validateRollbackBinding(input.proposal, input.manifest, input.rollbackArtifact)
      validateSourceProvenanceBinding(input.proposal, input.manifest, input.sourceProvenanceArtifact)
      yield* registerArtifactUnsafe(identity, input.artifact)
      if (input.rollbackArtifact) yield* registerArtifactUnsafe(identity, input.rollbackArtifact)
      if (input.sourceProvenanceArtifact) yield* registerArtifactUnsafe(identity, input.sourceProvenanceArtifact)
      const existing = yield* getRow(identity, proposalID)
      if (existing) {
        if (existing.artifact_digest !== artifactDigest) throw new DurableEvolutionError("proposal digest collision")
        return proposalFromRow(existing)
      }
      const now = Date.now()
      const state = stateAtLevel({ ...input.state, revision: 1 }, normalizeStatus(input.proposal.status))
      yield* events.publish(
        AgentRuntime.Event.EvolutionProposalCreated,
        {
          proposalID,
          candidateID,
          artifactDigest,
          actor: identity.actor,
          proposal: input.proposal,
        },
        {
          expectedSequence: -1,
          commit: (sequence) =>
            Effect.gen(function* () {
              yield* db
                .insert(EvolutionProposalTable)
                .values({
                  tenant_id: identity.tenantID,
                  owner_user_id: identity.userID,
                  id: proposalID,
                  candidate_id: candidateID,
                  artifact_digest: artifactDigest,
                  artifact_ref: input.artifactRef.trim(),
                  manifest: input.manifest,
                  state,
                  status: input.proposal.status,
                  revision: 1,
                  evaluation_id: input.proposal.evaluationID ?? null,
                  control_run_id: null,
                  created_by: identity.actor,
                  time_created: now,
                  time_updated: now,
                })
                .run()
                .pipe(Effect.orDie)
              yield* audit(db, identity, {
                aggregateID: proposalID,
                sequence: sequence + 1,
                action: "proposal_created",
                actor: identity.actor,
                reason: "durable Evolution proposal created",
                metadata: {
                  candidateID,
                  artifactDigest,
                  ...(input.rollbackArtifact ? { rollbackArtifactDigest: input.rollbackArtifact.digest } : {}),
                  ...(input.sourceProvenanceArtifact
                    ? { sourceProvenanceArtifactDigest: input.sourceProvenanceArtifact.digest }
                    : {}),
                },
                previousHash: "genesis",
              })
            }),
        },
      )
      const row = yield* getRow(identity, proposalID)
      if (!row) throw new DurableEvolutionError("durable proposal commit was not observable")
      return proposalFromRow(row)
    })

    const listProposalsUnsafe = Effect.fn("DurableEvolution.listProposals")(function* (identity, input = {}) {
      const normalized = identity
      const limit = input.limit ?? 100
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        throw new DurableEvolutionError("limit must be in [1, 500]")
      const rows = yield* db
        .select()
        .from(EvolutionProposalTable)
        .where(
          and(
            ownership(EvolutionProposalTable, normalized),
            input.status ? eq(EvolutionProposalTable.status, input.status) : undefined,
          ),
        )
        .orderBy(desc(EvolutionProposalTable.time_updated))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      return rows.map(proposalFromRow)
    })

    const transitionUnsafe = Effect.fn("DurableEvolution.transition")(function* (input) {
      const identity = input.identity
      const proposalID = normalizeProposalID(input.proposalID)
      const from = normalizeStatus(input.from)
      const to = normalizeStatus(input.to)
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
        throw new DurableEvolutionError("expectedRevision must be a positive integer")
      const current = yield* getRow(identity, proposalID)
      if (!current) return yield* new DurableEvolutionNotFoundError({ proposalID })
      const currentState = stateAtLevel(current.state, normalizeStatus(current.status))
      const replayState = stateAtLevel({ ...input.state, status: to, revision: input.expectedRevision + 1 }, to)
      validateTransitionLevel({ identity, from, to, currentState, nextState: replayState })
      const exactReplay =
        current.revision === input.expectedRevision + 1 &&
        current.status === to &&
        canonicalHash(currentState) === canonicalHash(replayState)
      if (exactReplay) {
        if (to === "promoted") {
          let receipt
          try {
            receipt = PromotionGate.assertIntegrity(currentState.promotion_gate)
          } catch (error) {
            throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
          }
          if (input.metadata?.promotionGateDigest !== receipt.gate_digest)
            throw new DurableEvolutionError("promotion replay metadata is not bound to the stored gate receipt")
        }
        return proposalFromRow(current)
      }
      if (to === "promoted") {
        const expectedGate = yield* preparePromotionGateUnsafe({ identity, proposalID, actor: identity.actor })
        try {
          PromotionGate.assertExpected(expectedGate, replayState.promotion_gate)
        } catch (error) {
          throw new DurableEvolutionError(error instanceof Error ? error.message : String(error))
        }
        if (input.metadata?.promotionGateDigest !== expectedGate.gate_digest)
          throw new DurableEvolutionError("promotion audit metadata is not bound to the current gate receipt")
      }
      if (current.revision !== input.expectedRevision || current.status !== from)
        return yield* new DurableEvolutionConflictError({
          proposalID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      const sequence = yield* EventV2.latestSequence(db, proposalID)
      yield* events.publish(
        AgentRuntime.Event.EvolutionStatusChanged,
        {
          proposalID,
          from,
          to,
          revision: input.expectedRevision + 1,
          actor: identity.actor,
          reason: input.reason.trim().slice(0, 500),
          metadata: input.metadata ?? {},
        },
        {
          expectedSequence: sequence,
          commit: (eventSequence) =>
            Effect.gen(function* () {
              const updated = yield* db
                .update(EvolutionProposalTable)
                .set({
                  state: replayState,
                  status: to,
                  revision: input.expectedRevision + 1,
                  evaluation_id: current.evaluation_id,
                  control_run_id: current.control_run_id,
                  time_updated: Date.now(),
                })
                .where(
                  and(
                    ownership(EvolutionProposalTable, identity),
                    eq(EvolutionProposalTable.id, proposalID),
                    eq(EvolutionProposalTable.status, from),
                    eq(EvolutionProposalTable.revision, input.expectedRevision),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated)
                return yield* Effect.die(
                  new DurableEvolutionConflictError({
                    proposalID,
                    expectedRevision: input.expectedRevision,
                    actualRevision: input.expectedRevision + 1,
                  }),
                )
              yield* audit(db, identity, {
                aggregateID: proposalID,
                sequence: eventSequence + 1,
                action: "proposal_status_changed",
                actor: identity.actor,
                reason: input.reason.trim().slice(0, 500),
                metadata: Object.assign({ from, to, revision: input.expectedRevision + 1 }, input.metadata),
                previousHash: "genesis",
              })
              return undefined
            }),
        },
      )
      const updated = yield* getRow(identity, proposalID)
      if (!updated) throw new DurableEvolutionError("durable transition was not observable")
      return proposalFromRow(updated)
    })

    const recordEvaluationUnsafe = Effect.fn("DurableEvolution.recordEvaluation")(function* (input) {
      const identity = input.identity
      const proposalID = normalizeProposalID(input.proposalID)
      const current = yield* getRow(identity, proposalID)
      if (!current) return yield* new DurableEvolutionNotFoundError({ proposalID })
      if (input.evaluation.candidate !== current.artifact_digest)
        throw new DurableEvolutionError("evaluation candidate digest does not match proposal")
      const encodedEvaluation = Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(input.evaluation)
      const storedEvaluation = { schema_version: 1, result: encodedEvaluation, report: input.report }
      const reportDigest = canonicalHash(storedEvaluation)
      if (!reportDigest) throw new DurableEvolutionError("evaluation report is not canonicalizable")
      if (current.evaluation_id === input.evaluation.id) {
        const stored = yield* db
          .select()
          .from(EvolutionEvaluationTable)
          .where(
            and(
              ownership(EvolutionEvaluationTable, identity),
              eq(EvolutionEvaluationTable.id, input.evaluation.id),
              eq(EvolutionEvaluationTable.proposal_id, proposalID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        const exactReplay =
          stored !== undefined &&
          current.status === "sandbox_evaluation" &&
          current.revision === input.expectedRevision + 1 &&
          stored.candidate_digest === current.artifact_digest &&
          stored.report_digest === reportDigest &&
          canonicalHash(stored.report) === canonicalHash(storedEvaluation) &&
          canonicalHash(current.state.evaluation) === canonicalHash(input.report) &&
          canonicalHash(current.state.evaluation_result) === canonicalHash(encodedEvaluation)
        if (!exactReplay)
          throw new DurableEvolutionError("evaluation replay differs from the immutable durable EvaluationResult")
        return proposalFromRow(current)
      }
      if (current.revision !== input.expectedRevision)
        return yield* new DurableEvolutionConflictError({
          proposalID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      const sequence = yield* EventV2.latestSequence(db, proposalID)
      yield* events.publish(
        AgentRuntime.Event.EvolutionEvaluationRecorded,
        { proposalID, evaluation: input.evaluation, actor: identity.actor },
        {
          expectedSequence: sequence,
          commit: (eventSequence) =>
            Effect.gen(function* () {
              const inserted = yield* db
                .insert(EvolutionEvaluationTable)
                .values({
                  tenant_id: identity.tenantID,
                  owner_user_id: identity.userID,
                  id: input.evaluation.id,
                  proposal_id: proposalID,
                  candidate_digest: input.evaluation.candidate,
                  report_digest: reportDigest,
                  report: storedEvaluation,
                  run_id: undefined,
                  created_by: identity.actor,
                  time_created: Date.now(),
                  time_updated: Date.now(),
                })
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!inserted)
                return yield* Effect.die(
                  new DurableEvolutionError("evaluation identity already belongs to another immutable record"),
                )
              const updated = yield* db
                .update(EvolutionProposalTable)
                .set({
                  evaluation_id: input.evaluation.id,
                  state: {
                    ...stateAtLevel(current.state, normalizeStatus(current.status)),
                    status: "sandbox_evaluation",
                    revision: input.expectedRevision + 1,
                    evaluation_id: input.evaluation.id,
                    evaluation: input.report,
                    evaluation_result: encodedEvaluation,
                    evolution_level: "L2",
                  },
                  status: "sandbox_evaluation",
                  revision: input.expectedRevision + 1,
                  time_updated: Date.now(),
                })
                .where(
                  and(
                    ownership(EvolutionProposalTable, identity),
                    eq(EvolutionProposalTable.id, proposalID),
                    eq(EvolutionProposalTable.revision, input.expectedRevision),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (!updated)
                return yield* Effect.die(
                  new DurableEvolutionConflictError({
                    proposalID,
                    expectedRevision: input.expectedRevision,
                    actualRevision: input.expectedRevision + 1,
                  }),
                )
              yield* audit(db, identity, {
                aggregateID: proposalID,
                sequence: eventSequence + 1,
                action: "evaluation_recorded",
                actor: identity.actor,
                reason: input.reason.trim().slice(0, 500),
                metadata: { evaluationID: input.evaluation.id, reportDigest },
                previousHash: "genesis",
              })
              return undefined
            }),
        },
      )
      const updated = yield* getRow(identity, proposalID)
      if (!updated) throw new DurableEvolutionError("durable evaluation was not observable")
      return proposalFromRow(updated)
    })

    const verifyAuditUnsafe = Effect.fn("DurableEvolution.verifyAudit")(function* (identity, aggregateID) {
      const normalized = identity
      const rows = yield* db
        .select()
        .from(EvolutionAuditTable)
        .where(and(ownership(EvolutionAuditTable, normalized), eq(EvolutionAuditTable.aggregate_id, aggregateID)))
        .orderBy(EvolutionAuditTable.sequence)
        .all()
        .pipe(Effect.orDie)
      let previous = "genesis"
      for (const [index, row] of rows.entries()) {
        const payload = auditPayload({
          aggregateID: row.aggregate_id,
          sequence: row.sequence,
          action: row.action,
          actor: row.actor,
          reason: row.reason,
          metadata: row.metadata,
          previousHash: row.previous_hash,
        })
        if (row.sequence !== index + 1 || row.previous_hash !== previous || canonicalHash(payload) !== row.record_hash)
          return { valid: false, events: index, headHash: previous }
        previous = row.record_hash
      }
      return { valid: true, events: rows.length, headHash: previous }
    })

    const registerArtifact: Interface["registerArtifact"] = (identity, input) =>
      withIdentity(identity, (normalized) => registerArtifactUnsafe(normalized, input))
    const createProposal: Interface["createProposal"] = (input) =>
      withIdentity(input.identity, (normalized) => createProposalUnsafe({ ...input, identity: normalized }))
    const getProposal: Interface["getProposal"] = (identity, proposalID) =>
      withIdentity(identity, (normalized) => getProposalUnsafe(normalized, proposalID))
    const getProposalByCandidate: Interface["getProposalByCandidate"] = (identity, candidateID) =>
      withIdentity(
        identity,
        Effect.fn("DurableEvolution.getProposalByCandidate")(function* (normalized) {
          const cleanCandidateID = candidateID.trim()
          if (!ID.test(cleanCandidateID)) throw new DurableEvolutionError("candidateID is invalid")
          const row = yield* db
            .select()
            .from(EvolutionProposalTable)
            .where(
              and(
                ownership(EvolutionProposalTable, normalized),
                eq(EvolutionProposalTable.candidate_id, cleanCandidateID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new DurableEvolutionNotFoundError({ proposalID: cleanCandidateID })
          return proposalFromRow(row)
        }),
      )
    const listProposals: Interface["listProposals"] = (identity, input) =>
      withIdentity(identity, (normalized) => listProposalsUnsafe(normalized, input))
    const preparePromotionGate: Interface["preparePromotionGate"] = (input) =>
      withIdentity(input.identity, (normalized) => preparePromotionGateUnsafe({ ...input, identity: normalized }))
    const transition: Interface["transition"] = (input) =>
      withIdentity(input.identity, (normalized) => transitionUnsafe({ ...input, identity: normalized }))
    const recordEvaluation: Interface["recordEvaluation"] = (input) =>
      withIdentity(input.identity, (normalized) => recordEvaluationUnsafe({ ...input, identity: normalized }))
    const verifyAudit: Interface["verifyAudit"] = (identity, aggregateID) =>
      withIdentity(identity, (normalized) => verifyAuditUnsafe(normalized, aggregateID))

    return Service.of({
      registerArtifact,
      createProposal,
      getProposal,
      getProposalByCandidate,
      listProposals,
      preparePromotionGate,
      transition,
      recordEvaluation,
      verifyAudit,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, DurableRun.globalNode],
})
