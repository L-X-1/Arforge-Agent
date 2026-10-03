import { Memory } from "@arforge-ai/schema/memory"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"
import * as MemoryClass from "@arforge-ai/schema/memory-class"
import * as MemoryRevision from "@arforge-ai/schema/memory-revision"
import * as MemoryRetention from "@arforge-ai/schema/memory-retention"
import * as Schema from "effect/Schema"
import { Context, Effect, Layer } from "effect"
import * as DateTime from "effect/DateTime"
import { and, asc, eq, or } from "drizzle-orm"
import type { EffectDrizzleSqlite } from "@arforge-ai/effect-drizzle-sqlite"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { read as readCompatible } from "./memory/kernel-reader"
import {
  MemoryCandidateAuditTable,
  MemoryCandidateTable,
  MemoryCorrectionTable,
  MemoryRevisionTable,
  MemoryTable,
} from "./memory/sql"
import { digest } from "./memory-revision"
import { maintenanceDeleteDecision } from "./memory-retention"
import { redact } from "./redact"

export const POLICY_VERSION = "memory-v1"

export class GateError extends Schema.TaggedErrorClass<GateError>()("MemoryKernel.GateError", {
  reason: Schema.String,
}) {}

export type ProposalInput = {
  readonly content: Memory.Content
  readonly proposedClass: MemoryClass.MemoryClass
  readonly sourceEvidenceIDs: ReadonlyArray<string>
  readonly scope: Memory.Scope
  readonly sensitivity: MemoryCandidate.Sensitivity
  readonly confidence: MemoryCandidate.Confidence
  readonly dedup: MemoryCandidate.Dedup
  readonly retention: MemoryCandidate.RetentionProposal
  readonly proposer: MemoryCandidate.Proposer
  readonly policy: MemoryCandidate.PolicyDecision
  readonly reason: string
  readonly expiresAt?: number
}

export type PromoteInput = {
  readonly candidateID: MemoryCandidate.CandidateID
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
  readonly source?: Memory.Source
  readonly expectedUpdatedAt?: number
  readonly reason?: string
}

export type ApproveInput = {
  readonly candidateID: MemoryCandidate.CandidateID
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly expectedUpdatedAt?: number
  readonly reason?: string
}

export type RejectInput = {
  readonly candidateID: MemoryCandidate.CandidateID
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly expectedUpdatedAt: number
  readonly reason: string
}

export type CandidateReview = {
  readonly candidate: MemoryCandidate.Candidate
  readonly audit: ReadonlyArray<MemoryCandidate.ReviewAudit>
}

export type ForgetInput = MemoryRetention.ForgetRequest & {
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
}

export type MaintenanceDeleteInput = MemoryRetention.MaintenanceDeleteRequest & {
  readonly policyVersion: string
}

export type ActiveCreateInput = {
  readonly content: Memory.Content
  readonly type: Memory.Type
  readonly tags: Memory.Tags
  readonly importance: Memory.Importance
  readonly source: Memory.Source
  readonly scope: Memory.Scope
  readonly relatedTo?: Memory.ID
  readonly strength: Memory.Strength
  readonly reviewLevel: Memory.ReviewLevel
  readonly memoryClass?: MemoryClass.MemoryClass
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
  readonly reason: string
}

export type ActiveUpdateInput = {
  readonly memoryID: Memory.ID
  readonly content?: Memory.Content
  readonly type?: Memory.Type
  readonly tags?: Memory.Tags
  readonly source?: Memory.Source
  readonly importance?: Memory.Importance
  readonly strength?: Memory.Strength
  readonly reviewLevel?: Memory.ReviewLevel
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
  readonly reason: string
}

export type ActiveCorrectionInput = {
  readonly memoryID: Memory.ID
  readonly content: Memory.Content
  readonly reason: Memory.CorrectionReason
  readonly expectedUpdatedAt: number
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
}

export type UndoCorrectionInput = {
  readonly correctionID: Memory.CorrectionID
  readonly expectedSuccessorUpdatedAt: number
  readonly actor: MemoryRevision.Actor
  readonly policyVersion: string
  readonly evidenceIDs: ReadonlyArray<string>
}

export type KernelInterface = {
  readonly propose: (input: ProposalInput) => Effect.Effect<MemoryCandidate.Candidate, GateError>
  readonly reviewCandidate: (candidateID: MemoryCandidate.CandidateID) => Effect.Effect<CandidateReview, GateError>
  readonly approve: (input: ApproveInput) => Effect.Effect<MemoryCandidate.Candidate, GateError>
  readonly reject: (input: RejectInput) => Effect.Effect<MemoryCandidate.Candidate, GateError>
  readonly promote: (input: PromoteInput) => Effect.Effect<Memory.Info, GateError>
  readonly createActive: (input: ActiveCreateInput) => Effect.Effect<Memory.Info, GateError>
  readonly updateActive: (input: ActiveUpdateInput) => Effect.Effect<Memory.Info, GateError>
  readonly correctActive: (input: ActiveCorrectionInput) => Effect.Effect<Memory.CorrectionResult, GateError>
  readonly undoCorrection: (input: UndoCorrectionInput) => Effect.Effect<Memory.CorrectionResult, GateError>
  readonly read: (memoryID: Memory.ID) => Effect.Effect<ReturnType<typeof readCompatible>, GateError>
  readonly forget: (input: ForgetInput) => Effect.Effect<ReturnType<typeof readCompatible>, GateError>
  readonly maintenanceDelete: (input: MaintenanceDeleteInput) => Effect.Effect<{ readonly deleted: boolean }, GateError>
}

export class Service extends Context.Service<Service, KernelInterface>()("@arforge/v1/MemoryKernel") {}

type DatabaseTransaction = Parameters<Parameters<EffectDrizzleSqlite.EffectSQLiteDatabase["transaction"]>[0]>[0]
type MemoryRow = typeof MemoryTable.$inferSelect
type CandidateRow = typeof MemoryCandidateTable.$inferSelect
type CandidateAuditRow = typeof MemoryCandidateAuditTable.$inferSelect

const evidenceIDs = (values: ReadonlyArray<string>) => values.map((value) => AgentRuntime.EvidenceID.make(value))

const candidateFromRow = (row: CandidateRow): MemoryCandidate.Candidate =>
  MemoryCandidate.Candidate.make({
    candidateID: row.id,
    proposedClass: row.proposed_class,
    content: row.content,
    sourceEvidenceIDs: evidenceIDs(row.source_evidence_ids),
    scope: row.scope,
    sensitivity: row.sensitivity,
    confidence: row.confidence,
    dedup: {
      status: row.dedup_status,
      comparedMemoryIDs: row.dedup_compared_memory_ids,
      ...(row.dedup_similarity === null ? {} : { similarity: row.dedup_similarity }),
    },
    retention: {
      mode: row.retention_mode,
      ...(row.retention_expires_at === null ? {} : { expiresAt: DateTime.makeUnsafe(row.retention_expires_at) }),
      reason: row.retention_reason,
    },
    proposer: {
      kind: row.proposer_kind,
      ...(row.principal_ref === null ? {} : { principalRef: AgentRuntime.ControlPrincipalRef.make(row.principal_ref) }),
      ...(row.run_id === null ? {} : { runID: AgentRuntime.RunID.make(row.run_id) }),
    },
    policy: { status: row.policy_status, policyVersion: row.policy_version, reason: row.policy_reason },
    status: row.status,
    reason: row.reason,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      ...(row.time_expires === null ? {} : { expires: DateTime.makeUnsafe(row.time_expires) }),
    },
  })

const candidateAuditFromRow = (row: CandidateAuditRow): MemoryCandidate.ReviewAudit =>
  MemoryCandidate.ReviewAudit.make({
    auditID: row.id,
    operation: row.operation,
    actorKind: row.actor_kind,
    reason: row.reason,
    policyVersion: row.policy_version,
    ...(row.status_from === null ? {} : { statusFrom: row.status_from }),
    statusTo: row.status_to,
    createdAt: DateTime.makeUnsafe(row.time_created),
  })

export const candidateApprovalBlocks = (
  candidate: MemoryCandidate.Candidate,
): ReadonlyArray<MemoryCandidate.ReviewBlockCode> => {
  const blocked: MemoryCandidate.ReviewBlockCode[] = []
  if (candidate.status !== "proposed") blocked.push("status_not_proposed")
  if (candidate.policy.status === "deny") blocked.push("policy_not_allow")
  if (candidate.sensitivity === "secret") blocked.push("secret_or_credential")
  if (candidate.dedup.status === "duplicate") blocked.push("duplicate")
  if (candidate.dedup.status === "conflict") blocked.push("conflict")
  if (candidate.proposedClass === "working") blocked.push("working_state")
  return blocked
}

const approvalBlockMessage = (code: MemoryCandidate.ReviewBlockCode): string =>
  ({
    status_not_proposed: "Only proposed candidates can be approved.",
    policy_not_allow: "Candidate policy explicitly denied activation.",
    secret_or_credential: "Secret or credential-like candidates cannot be approved.",
    duplicate: "Duplicate candidates cannot be approved.",
    conflict: "Conflicting candidates must be resolved before approval.",
    working_state: "Short-lived working state cannot become durable memory.",
  })[code]

const toInfo = (row: MemoryRow): Memory.Info =>
  Memory.Info.make({
    id: row.id,
    version: row.memory_version,
    content: row.content,
    type: row.type,
    tags: row.tags,
    importance: row.importance,
    source: row.source,
    scope: row.scope,
    ...(row.project_id ? { projectID: row.project_id } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.related_to ? { relatedTo: row.related_to } : {}),
    strength: row.strength,
    reviewLevel: row.review_level,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      ...(row.time_reviewed === null ? {} : { reviewed: DateTime.makeUnsafe(row.time_reviewed) }),
    },
  })

const insertRevision = (
  tx: DatabaseTransaction,
  input: {
    readonly memoryID: Memory.ID
    readonly version: number
    readonly operation: MemoryRevision.Operation
    readonly actor: MemoryRevision.Actor
    readonly reason: string
    readonly policyVersion: string
    readonly evidenceIDs: ReadonlyArray<string>
    readonly priorDigest?: MemoryRevision.ContentDigest
    readonly contentDigest: MemoryRevision.ContentDigest
    readonly successorMemoryID?: Memory.ID
    readonly candidateID?: MemoryCandidate.CandidateID
    readonly principal?: Database.Principal
  },
) =>
  tx
    .insert(MemoryRevisionTable)
    .values({
      ...(input.principal ? { tenant_id: input.principal.tenantID, owner_user_id: input.principal.userID } : {}),
      id: MemoryRevision.RevisionID.make(`mrev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`),
      memory_id: input.memoryID,
      version: input.version,
      operation: input.operation,
      actor_kind: input.actor.kind,
      principal_ref: input.actor.principalRef,
      run_id: input.actor.runID,
      reason: input.reason,
      policy_version: input.policyVersion,
      evidence_ids: input.evidenceIDs,
      prior_digest: input.priorDigest,
      content_digest: input.contentDigest,
      successor_memory_id: input.successorMemoryID,
      candidate_id: input.candidateID,
      time_created: Date.now(),
    })
    .run()

const keepGate = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, GateError, R> =>
  Effect.catch(effect, (error) => (error instanceof GateError ? Effect.fail(error) : Effect.die(error)))

const explicitSources = new Set<Memory.Source>(["user", "user-corrected", "imported"])

const activeClass = (source: Memory.Source): MemoryClass.MemoryClass =>
  source === "user" || source === "user-corrected" ? "user" : "semantic"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const location = yield* Location.Service
    const projectID = String(location.project.id)
    const workspacePath = String(location.directory).replaceAll("\\", "/").replace(/\/+$/, "") || "/"
    const normalizedWorkspacePath =
      process.platform === "win32" ? workspacePath.toLocaleLowerCase("en-US") : workspacePath

    const principal = () => Effect.map(Database.CurrentPrincipal, (value) => value ?? Database.DefaultLocalPrincipal)
    const ownedCandidate = (identity: Database.Principal, candidateID: MemoryCandidate.CandidateID) =>
      and(
        eq(MemoryCandidateTable.tenant_id, identity.tenantID),
        eq(MemoryCandidateTable.owner_user_id, identity.userID),
        eq(MemoryCandidateTable.id, candidateID),
        or(
          eq(MemoryCandidateTable.scope, "global"),
          and(
            eq(MemoryCandidateTable.project_id, projectID),
            eq(MemoryCandidateTable.workspace_path, normalizedWorkspacePath),
          ),
        ),
      )
    const appendCandidateAudit = (
      tx: DatabaseTransaction,
      identity: Database.Principal,
      input: {
        candidateID: MemoryCandidate.CandidateID
        operation: MemoryCandidate.ReviewOperation
        actor: MemoryRevision.Actor
        reason: string
        policyVersion: string
        statusFrom?: MemoryCandidate.Status
        statusTo: MemoryCandidate.Status
        createdAt: number
      },
    ) =>
      tx
        .insert(MemoryCandidateAuditTable)
        .values({
          tenant_id: identity.tenantID,
          owner_user_id: identity.userID,
          id: `mcaud_${input.createdAt.toString(36)}_${Math.random().toString(36).slice(2)}`,
          candidate_id: input.candidateID,
          operation: input.operation,
          actor_kind: input.actor.kind,
          principal_ref: input.actor.principalRef,
          reason: input.reason,
          policy_version: input.policyVersion,
          status_from: input.statusFrom,
          status_to: input.statusTo,
          time_created: input.createdAt,
        })
        .run()

    const propose: KernelInterface["propose"] = Effect.fn("MemoryKernel.propose")(function* (input) {
      if (input.policy.status === "deny")
        return yield* new GateError({ reason: "Denied candidate cannot be persisted." })
      const identity = yield* principal()
      const now = Date.now()
      const candidateID = MemoryCandidate.CandidateID.create()
      const redactedContent = redact(input.content)
      const credentialLike = redactedContent !== input.content
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const created = yield* tx
              .insert(MemoryCandidateTable)
              .values({
                tenant_id: identity.tenantID,
                owner_user_id: identity.userID,
                id: candidateID,
                proposed_class: input.proposedClass,
                content: Memory.Content.make(redactedContent),
                source_evidence_ids: evidenceIDs(input.sourceEvidenceIDs),
                scope: input.scope,
                project_id: input.scope === "workspace" ? projectID : null,
                workspace_path: input.scope === "workspace" ? normalizedWorkspacePath : null,
                sensitivity: credentialLike ? "secret" : input.sensitivity,
                confidence: input.confidence,
                dedup_status: input.dedup.status,
                dedup_compared_memory_ids: input.dedup.comparedMemoryIDs,
                dedup_similarity: input.dedup.similarity,
                retention_mode: input.retention.mode,
                retention_expires_at:
                  input.retention.expiresAt === undefined
                    ? undefined
                    : DateTime.toEpochMillis(input.retention.expiresAt),
                retention_reason: input.retention.reason,
                proposer_kind: input.proposer.kind,
                principal_ref: input.proposer.principalRef,
                run_id: input.proposer.runID,
                policy_status: input.policy.status,
                policy_version: input.policy.policyVersion,
                policy_reason: input.policy.reason,
                status: "proposed",
                reason: input.reason,
                time_created: now,
                time_updated: now,
                time_expires: input.expiresAt,
              })
              .returning()
              .get()
            yield* appendCandidateAudit(tx, identity, {
              candidateID,
              operation: "proposed",
              actor: {
                kind: input.proposer.kind,
                principalRef: input.proposer.principalRef,
                runID: input.proposer.runID,
              },
              reason: input.reason,
              policyVersion: input.policy.policyVersion,
              statusTo: "proposed",
              createdAt: now,
            })
            return created
          }),
        )
        .pipe(Effect.orDie)
      return candidateFromRow(row)
    })

    const reviewCandidate: KernelInterface["reviewCandidate"] = Effect.fn("MemoryKernel.reviewCandidate")(
      function* (candidateID) {
        const identity = yield* principal()
        const row = yield* db
          .select()
          .from(MemoryCandidateTable)
          .where(ownedCandidate(identity, candidateID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new GateError({ reason: "Candidate does not exist in the current user scope." })
        const auditRows = yield* db
          .select()
          .from(MemoryCandidateAuditTable)
          .where(
            and(
              eq(MemoryCandidateAuditTable.tenant_id, identity.tenantID),
              eq(MemoryCandidateAuditTable.owner_user_id, identity.userID),
              eq(MemoryCandidateAuditTable.candidate_id, candidateID),
            ),
          )
          .orderBy(asc(MemoryCandidateAuditTable.time_created))
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        return { candidate: candidateFromRow(row), audit: auditRows.map(candidateAuditFromRow) }
      },
    )

    const approve: KernelInterface["approve"] = Effect.fn("MemoryKernel.approve")(function* (input) {
      if (input.actor.kind !== "user")
        return yield* new GateError({ reason: "Only a user can approve a memory candidate." })
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      const identity = yield* principal()
      const reason = input.reason?.trim() || "User approved memory candidate."
      const updated = yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(MemoryCandidateTable)
              .where(ownedCandidate(identity, input.candidateID))
              .get()
            if (!row) return yield* new GateError({ reason: "Candidate does not exist in the current user scope." })
            if (input.expectedUpdatedAt !== undefined && row.time_updated !== input.expectedUpdatedAt)
              return yield* new GateError({
                reason: "Candidate changed since it was reviewed. Refresh before approving.",
              })
            const contract = candidateFromRow(row)
            const blocked = candidateApprovalBlocks(contract)[0]
            if (blocked) return yield* new GateError({ reason: approvalBlockMessage(blocked) })
            const now = Date.now()
            const result = yield* tx
              .update(MemoryCandidateTable)
              .set({
                status: "approved",
                policy_status: "allow",
                policy_reason: reason,
                policy_version: input.policyVersion,
                reason,
                time_updated: now,
              })
              .where(
                and(
                  ownedCandidate(identity, input.candidateID),
                  eq(MemoryCandidateTable.status, "proposed"),
                  eq(MemoryCandidateTable.time_updated, row.time_updated),
                ),
              )
              .returning()
              .get()
            if (!result) return yield* new GateError({ reason: "Candidate changed during approval." })
            yield* appendCandidateAudit(tx, identity, {
              candidateID: input.candidateID,
              operation: "approved",
              actor: input.actor,
              reason,
              policyVersion: input.policyVersion,
              statusFrom: "proposed",
              statusTo: "approved",
              createdAt: now,
            })
            return result
          }),
        ),
      )
      return candidateFromRow(updated)
    })

    const reject: KernelInterface["reject"] = Effect.fn("MemoryKernel.reject")(function* (input) {
      if (input.actor.kind !== "user")
        return yield* new GateError({ reason: "Only a user can reject a memory candidate." })
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      const reason = input.reason.trim()
      if (!reason) return yield* new GateError({ reason: "A rejection reason is required." })
      const identity = yield* principal()
      const updated = yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(MemoryCandidateTable)
              .where(ownedCandidate(identity, input.candidateID))
              .get()
            if (!row) return yield* new GateError({ reason: "Candidate does not exist in the current user scope." })
            if (row.time_updated !== input.expectedUpdatedAt)
              return yield* new GateError({
                reason: "Candidate changed since it was reviewed. Refresh before rejecting.",
              })
            if (row.status !== "proposed" && row.status !== "approved")
              return yield* new GateError({ reason: "Only proposed or approved candidates can be rejected." })
            const now = Date.now()
            const result = yield* tx
              .update(MemoryCandidateTable)
              .set({ status: "rejected", reason, time_updated: now })
              .where(
                and(
                  ownedCandidate(identity, input.candidateID),
                  eq(MemoryCandidateTable.status, row.status),
                  eq(MemoryCandidateTable.time_updated, row.time_updated),
                ),
              )
              .returning()
              .get()
            if (!result) return yield* new GateError({ reason: "Candidate changed during rejection." })
            yield* appendCandidateAudit(tx, identity, {
              candidateID: input.candidateID,
              operation: "rejected",
              actor: input.actor,
              reason,
              policyVersion: input.policyVersion,
              statusFrom: row.status,
              statusTo: "rejected",
              createdAt: now,
            })
            return result
          }),
        ),
      )
      return candidateFromRow(updated)
    })

    const promote: KernelInterface["promote"] = Effect.fn("MemoryKernel.promote")(function* (input) {
      if (input.actor.kind !== "user")
        return yield* new GateError({ reason: "Only a user can activate a memory candidate." })
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      const source = input.source ?? "user"
      if (!explicitSources.has(source))
        return yield* new GateError({ reason: "Only explicit user/imported sources may activate memory." })
      const now = Date.now()
      const identity = yield* principal()
      const reviewReason = input.reason?.trim() || "User activated approved memory candidate."
      return yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const candidate = yield* tx
              .select()
              .from(MemoryCandidateTable)
              .where(ownedCandidate(identity, input.candidateID))
              .get()
            if (!candidate)
              return yield* new GateError({ reason: "Candidate does not exist in the current user scope." })
            if (input.expectedUpdatedAt !== undefined && candidate.time_updated !== input.expectedUpdatedAt)
              return yield* new GateError({
                reason: "Candidate changed since it was reviewed. Refresh before activating.",
              })
            const contract = candidateFromRow(candidate)
            if (!MemoryCandidate.isActivationEligible(contract))
              return yield* new GateError({ reason: "Candidate failed active-memory promotion gate." })
            if (
              contract.scope === "global" &&
              !new Set<Memory.Source>(["user", "user-corrected", "imported"]).has(source)
            )
              return yield* new GateError({
                reason: "Global active memory requires an explicit user/import authority source.",
              })
            const memoryID = Memory.ID.create()
            const contentDigest = digest({ memoryID, content: contract.content, version: 1 })
            const retentionMode =
              contract.retention.mode === "indefinite"
                ? "indefinite"
                : contract.retention.mode === "short" || contract.retention.mode === "long"
                  ? "decay"
                  : "ttl"
            const row = yield* tx
              .insert(MemoryTable)
              .values({
                tenant_id: identity.tenantID,
                owner_user_id: identity.userID,
                id: memoryID,
                content: contract.content,
                type: Memory.Type.make("fact"),
                tags: Memory.Tags.make([]),
                importance: Memory.Importance.make(1),
                source,
                scope: contract.scope,
                project_id: contract.scope === "workspace" ? projectID : null,
                workspace_path: contract.scope === "workspace" ? normalizedWorkspacePath : null,
                related_to: null,
                strength: Memory.Strength.make(0.5),
                review_level: Memory.ReviewLevel.make(0),
                time_created: now,
                time_updated: now,
                memory_class: contract.proposedClass,
                lifecycle: "active",
                memory_version: 1,
                provenance_status: "verified",
                content_digest: contentDigest,
                retention_mode: retentionMode,
                retention_expires_at:
                  contract.retention.expiresAt === undefined
                    ? undefined
                    : DateTime.toEpochMillis(contract.retention.expiresAt),
              })
              .returning()
              .get()
            yield* insertRevision(tx, {
              memoryID,
              version: 1,
              operation: "activate",
              actor: input.actor,
              reason: contract.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs.length ? input.evidenceIDs : contract.sourceEvidenceIDs,
              contentDigest,
              candidateID: contract.candidateID,
              principal: identity,
            })
            const promoted = yield* tx
              .update(MemoryCandidateTable)
              .set({ status: "promoted", reason: reviewReason, time_updated: now })
              .where(
                and(
                  ownedCandidate(identity, contract.candidateID),
                  eq(MemoryCandidateTable.status, "approved"),
                  eq(MemoryCandidateTable.time_updated, candidate.time_updated),
                ),
              )
              .returning({ id: MemoryCandidateTable.id })
              .get()
            if (!promoted) return yield* new GateError({ reason: "Candidate changed during activation." })
            yield* appendCandidateAudit(tx, identity, {
              candidateID: contract.candidateID,
              operation: "activated",
              actor: input.actor,
              reason: reviewReason,
              policyVersion: input.policyVersion,
              statusFrom: "approved",
              statusTo: "promoted",
              createdAt: now,
            })
            return toInfo(row)
          }),
        ),
      )
    })

    const createActive: KernelInterface["createActive"] = Effect.fn("MemoryKernel.createActive")(function* (input) {
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      if (!explicitSources.has(input.source))
        return yield* new GateError({ reason: "Only explicit user/imported sources may activate memory." })
      if (input.scope === "global" && input.source === "imported")
        return yield* new GateError({ reason: "Imported global memory requires an explicit user authority." })
      const memoryID = Memory.ID.create()
      const now = Date.now()
      const contentDigest = digest({ memoryID, content: input.content, version: 1 })
      return yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .insert(MemoryTable)
              .values({
                id: memoryID,
                content: input.content,
                type: input.type,
                tags: input.tags,
                importance: input.importance,
                source: input.source,
                scope: input.scope,
                project_id: input.scope === "workspace" ? projectID : null,
                workspace_path: input.scope === "workspace" ? normalizedWorkspacePath : null,
                related_to: input.relatedTo,
                strength: input.strength,
                review_level: input.reviewLevel,
                time_reviewed: input.reviewLevel > 0 ? now : null,
                time_created: now,
                time_updated: now,
                memory_class: input.memoryClass ?? activeClass(input.source),
                lifecycle: "active",
                memory_version: 1,
                provenance_status: "verified",
                content_digest: contentDigest,
                retention_mode: "indefinite",
              })
              .returning()
              .get()
            yield* insertRevision(tx, {
              memoryID,
              version: 1,
              operation: "create",
              actor: input.actor,
              reason: input.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs,
              contentDigest,
            })
            return toInfo(row)
          }),
        ),
      )
    })

    const updateActive: KernelInterface["updateActive"] = Effect.fn("MemoryKernel.updateActive")(function* (input) {
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      return yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.select().from(MemoryTable).where(eq(MemoryTable.id, input.memoryID)).get()
            if (!current) return yield* new GateError({ reason: "Memory does not exist." })
            if (current.lifecycle !== "active")
              return yield* new GateError({ reason: "Only active memory can be updated." })
            const source = input.source ?? current.source
            if (!explicitSources.has(source))
              return yield* new GateError({ reason: "Only explicit user/imported sources may update memory." })
            if (source === "imported" && current.scope === "global")
              return yield* new GateError({ reason: "Imported global memory requires an explicit user authority." })
            const nextVersion = current.memory_version + 1
            const content = input.content ?? current.content
            const contentDigest = digest({ memoryID: current.id, content, version: nextVersion })
            const now = Date.now()
            const updated = yield* tx
              .update(MemoryTable)
              .set({
                content: input.content,
                type: input.type,
                tags: input.tags,
                source: input.source,
                importance: input.importance,
                strength: input.strength,
                review_level: input.reviewLevel,
                time_reviewed: input.reviewLevel === undefined ? undefined : now,
                time_updated: now,
                memory_version: nextVersion,
                content_digest: contentDigest,
                provenance_status: "verified",
              })
              .where(and(eq(MemoryTable.id, input.memoryID), eq(MemoryTable.memory_version, current.memory_version)))
              .returning()
              .get()
            if (!updated) return yield* new GateError({ reason: "Memory changed during update." })
            yield* insertRevision(tx, {
              memoryID: current.id,
              version: nextVersion,
              operation: "update",
              actor: input.actor,
              reason: input.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs,
              priorDigest: current.content_digest ?? undefined,
              contentDigest,
            })
            return toInfo(updated)
          }),
        ),
      )
    })

    const correctActive: KernelInterface["correctActive"] = Effect.fn("MemoryKernel.correctActive")(function* (input) {
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      const now = Date.now()
      return yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const original = yield* tx.select().from(MemoryTable).where(eq(MemoryTable.id, input.memoryID)).get()
            if (!original) return yield* new GateError({ reason: "Memory does not exist." })
            if (original.lifecycle !== "active" || original.source.startsWith("quarantined"))
              return yield* new GateError({ reason: "Only active memory can be corrected." })
            if (original.time_updated !== input.expectedUpdatedAt)
              return yield* new GateError({ reason: "Memory changed after it was loaded." })
            const successorID = Memory.ID.create()
            const successorDigest = digest({ memoryID: successorID, content: input.content, version: 1 })
            const originalVersion = original.memory_version + 1
            const originalDigest = digest({
              memoryID: original.id,
              content: original.content,
              version: originalVersion,
            })
            const successor = yield* tx
              .insert(MemoryTable)
              .values({
                id: successorID,
                content: input.content,
                type: original.type,
                tags: original.tags,
                importance: original.importance,
                source: "user-corrected",
                scope: original.scope,
                project_id: original.project_id,
                workspace_path: original.workspace_path,
                related_to: original.id,
                strength: 1,
                review_level: Math.max(1, original.review_level),
                time_reviewed: now,
                time_created: now,
                time_updated: now,
                memory_class: original.memory_class ?? "user",
                lifecycle: "active",
                memory_version: 1,
                provenance_status: "verified",
                content_digest: successorDigest,
                retention_mode: original.retention_mode,
                retention_expires_at: original.retention_expires_at,
              })
              .returning()
              .get()
            const superseded = yield* tx
              .update(MemoryTable)
              .set({
                source: "quarantined",
                lifecycle: "superseded",
                memory_version: originalVersion,
                content_digest: originalDigest,
                time_updated: now,
              })
              .where(and(eq(MemoryTable.id, original.id), eq(MemoryTable.time_updated, input.expectedUpdatedAt)))
              .returning()
              .get()
            if (!superseded) return yield* new GateError({ reason: "Memory changed during correction." })
            const correction = yield* tx
              .insert(MemoryCorrectionTable)
              .values({
                id: Memory.CorrectionID.create(),
                original_memory_id: original.id,
                successor_memory_id: successor.id,
                original_source: original.source,
                reason: input.reason,
                status: "active",
                time_created: now,
              })
              .returning()
              .get()
            yield* insertRevision(tx, {
              memoryID: original.id,
              version: originalVersion,
              operation: "correct",
              actor: input.actor,
              reason: input.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs,
              priorDigest: original.content_digest ?? undefined,
              contentDigest: originalDigest,
              successorMemoryID: successor.id,
            })
            yield* insertRevision(tx, {
              memoryID: successor.id,
              version: 1,
              operation: "correct",
              actor: input.actor,
              reason: input.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs,
              contentDigest: successorDigest,
              successorMemoryID: successor.id,
            })
            return Memory.CorrectionResult.make({
              correction: Memory.CorrectionInfo.make({
                id: correction.id,
                originalMemoryID: correction.original_memory_id,
                successorMemoryID: correction.successor_memory_id,
                originalSource: correction.original_source,
                reason: correction.reason,
                status: correction.status,
                time: {
                  created: DateTime.makeUnsafe(correction.time_created),
                  ...(correction.time_undone === null ? {} : { undone: DateTime.makeUnsafe(correction.time_undone) }),
                },
              }),
              original: toInfo(superseded),
              successor: toInfo(successor),
            })
          }),
        ),
      )
    })

    const undoCorrection: KernelInterface["undoCorrection"] = Effect.fn("MemoryKernel.undoCorrection")(
      function* (input) {
        if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
        return yield* keepGate(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const correction = yield* tx
                .select()
                .from(MemoryCorrectionTable)
                .where(eq(MemoryCorrectionTable.id, input.correctionID))
                .get()
              if (!correction) return yield* new GateError({ reason: "Correction does not exist." })
              if (correction.status !== "active")
                return yield* new GateError({ reason: "This correction has already been undone." })
              const original = yield* tx
                .select()
                .from(MemoryTable)
                .where(eq(MemoryTable.id, correction.original_memory_id))
                .get()
              const successor = yield* tx
                .select()
                .from(MemoryTable)
                .where(eq(MemoryTable.id, correction.successor_memory_id))
                .get()
              if (!original || !successor) return yield* new GateError({ reason: "Correction lineage is incomplete." })
              if (
                original.source !== "quarantined" ||
                original.lifecycle !== "superseded" ||
                successor.source !== "user-corrected" ||
                successor.lifecycle !== "active" ||
                successor.time_updated !== input.expectedSuccessorUpdatedAt
              )
                return yield* new GateError({ reason: "Correction lineage changed after it was loaded." })
              const now = Date.now()
              const originalVersion = original.memory_version + 1
              const successorVersion = successor.memory_version + 1
              const originalDigest = digest({
                memoryID: original.id,
                content: original.content,
                version: originalVersion,
              })
              const successorDigest = digest({
                memoryID: successor.id,
                content: successor.content,
                version: successorVersion,
              })
              const restored = yield* tx
                .update(MemoryTable)
                .set({
                  source: correction.original_source,
                  lifecycle: "active",
                  memory_version: originalVersion,
                  content_digest: originalDigest,
                  time_updated: now,
                })
                .where(and(eq(MemoryTable.id, original.id), eq(MemoryTable.memory_version, original.memory_version)))
                .returning()
                .get()
              const retired = yield* tx
                .update(MemoryTable)
                .set({
                  source: "quarantined",
                  lifecycle: "superseded",
                  memory_version: successorVersion,
                  content_digest: successorDigest,
                  time_updated: now,
                })
                .where(and(eq(MemoryTable.id, successor.id), eq(MemoryTable.memory_version, successor.memory_version)))
                .returning()
                .get()
              const undone = yield* tx
                .update(MemoryCorrectionTable)
                .set({ status: "undone", time_undone: now })
                .where(and(eq(MemoryCorrectionTable.id, correction.id), eq(MemoryCorrectionTable.status, "active")))
                .returning()
                .get()
              if (!restored || !retired || !undone)
                return yield* new GateError({ reason: "Correction changed during undo." })
              yield* insertRevision(tx, {
                memoryID: original.id,
                version: originalVersion,
                operation: "restore",
                actor: input.actor,
                reason: "Undo memory correction",
                policyVersion: input.policyVersion,
                evidenceIDs: input.evidenceIDs,
                priorDigest: original.content_digest ?? undefined,
                contentDigest: originalDigest,
              })
              yield* insertRevision(tx, {
                memoryID: successor.id,
                version: successorVersion,
                operation: "quarantine",
                actor: input.actor,
                reason: "Retire corrected successor while undoing correction",
                policyVersion: input.policyVersion,
                evidenceIDs: input.evidenceIDs,
                priorDigest: successor.content_digest ?? undefined,
                contentDigest: successorDigest,
              })
              return Memory.CorrectionResult.make({
                correction: Memory.CorrectionInfo.make({
                  id: undone.id,
                  originalMemoryID: undone.original_memory_id,
                  successorMemoryID: undone.successor_memory_id,
                  originalSource: undone.original_source,
                  reason: undone.reason,
                  status: undone.status,
                  time: {
                    created: DateTime.makeUnsafe(undone.time_created),
                    ...(undone.time_undone === null ? {} : { undone: DateTime.makeUnsafe(undone.time_undone) }),
                  },
                }),
                original: toInfo(restored),
                successor: toInfo(retired),
              })
            }),
          ),
        )
      },
    )

    const read: KernelInterface["read"] = Effect.fn("MemoryKernel.read")(function* (memoryID) {
      const row = yield* db.select().from(MemoryTable).where(eq(MemoryTable.id, memoryID)).get().pipe(Effect.orDie)
      if (!row) return yield* new GateError({ reason: "Memory does not exist." })
      return readCompatible(row)
    })

    const forget: KernelInterface["forget"] = Effect.fn("MemoryKernel.forget")(function* (input) {
      if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
      return yield* keepGate(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx.select().from(MemoryTable).where(eq(MemoryTable.id, input.memoryID)).get()
            if (!current) return yield* new GateError({ reason: "Memory does not exist." })
            if (current.memory_version !== input.expectedVersion)
              return yield* new GateError({ reason: "Memory version does not match expectedVersion." })
            if (current.lifecycle === "deleted")
              return yield* new GateError({ reason: "Deleted memory cannot be forgotten." })
            const nextVersion = current.memory_version + 1
            const contentDigest =
              current.content_digest ?? digest({ memoryID: current.id, content: current.content, version: nextVersion })
            const updated = yield* tx
              .update(MemoryTable)
              .set({
                lifecycle: "forgotten",
                memory_version: nextVersion,
                content_digest: contentDigest,
                time_updated: Date.now(),
              })
              .where(and(eq(MemoryTable.id, input.memoryID), eq(MemoryTable.memory_version, input.expectedVersion)))
              .returning()
              .get()
            if (!updated) return yield* new GateError({ reason: "Memory changed during forget." })
            yield* insertRevision(tx, {
              memoryID: input.memoryID,
              version: nextVersion,
              operation: "forget",
              actor: { kind: input.actor },
              reason: input.reason,
              policyVersion: input.policyVersion,
              evidenceIDs: input.evidenceIDs,
              priorDigest: current.content_digest ?? undefined,
              contentDigest,
            })
            return readCompatible(updated)
          }),
        ),
      )
    })

    const maintenanceDelete: KernelInterface["maintenanceDelete"] = Effect.fn("MemoryKernel.maintenanceDelete")(
      function* (input) {
        const decision = maintenanceDeleteDecision(input)
        if (!decision.allowed) return yield* new GateError({ reason: decision.reason })
        if (!input.policyVersion.trim()) return yield* new GateError({ reason: "policyVersion is required." })
        const deleted = yield* keepGate(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const current = yield* tx.select().from(MemoryTable).where(eq(MemoryTable.id, input.memoryID)).get()
              if (!current) return false
              if (current.memory_version !== input.expectedVersion)
                return yield* new GateError({ reason: "Memory version does not match expectedVersion." })
              const result = yield* tx
                .delete(MemoryTable)
                .where(and(eq(MemoryTable.id, input.memoryID), eq(MemoryTable.memory_version, input.expectedVersion)))
                .returning({ id: MemoryTable.id })
                .get()
              return result !== undefined
            }),
          ),
        )
        return { deleted }
      },
    )

    return Service.of({
      propose,
      reviewCandidate,
      approve,
      reject,
      promote,
      createActive,
      updateActive,
      correctActive,
      undoCorrection,
      read,
      forget,
      maintenanceDelete,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, Location.node] })
