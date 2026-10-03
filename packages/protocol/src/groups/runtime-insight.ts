import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from "effect/unstable/httpapi"
import { Context, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { Mcp } from "@arforge-ai/schema/mcp"

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

/** Payload-free admission metadata attached to a durable custom-agent child. */
export const CustomAgentAdmissionRecord = Schema.Struct({
  role: Schema.String,
  status: Schema.String,
  decision: Schema.Literals(["admitted", "blocked"]),
  reason: Schema.String,
  ready: Schema.Boolean,
  descriptorDigest: Schema.NullOr(Schema.String),
  checks: Schema.Struct({
    statusConsistent: Schema.Boolean,
    descriptorDigestConsistent: Schema.Boolean,
    toolProjectionConsistent: Schema.Boolean,
    payloadFree: Schema.Boolean,
  }),
  declaredToolCount: Schema.Number,
  canonicalToolCount: Schema.Number,
  unsupportedToolCount: Schema.Number,
  valid: Schema.Boolean,
  evidenceRefs: Schema.Array(Schema.String),
})

export const DurableRunRecord = Schema.Struct({
  runID: Schema.String,
  sessionID: Schema.String,
  status: Schema.String,
  initiator: Schema.String,
  authority: Schema.String,
  riskTier: Schema.String,
  reasonSummary: Schema.String,
  attemptsUsed: Schema.Number,
  maxAttempts: Schema.Number,
  durationMsUsed: Schema.Number,
  maxDurationMs: Schema.Number,
  costMicrosUsed: Schema.Number,
  maxCostMicros: Schema.Number,
  activeAttempt: Schema.NullOr(
    Schema.Struct({
      attempt: Schema.Number,
      startedAt: Schema.Number,
    }),
  ),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  startedAt: Schema.NullOr(Schema.Number),
  finishedAt: Schema.NullOr(Schema.Number),
  lastLeaseGeneration: Schema.NullOr(Schema.Number),
  lastTransition: Schema.NullOr(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      reason: Schema.String,
      changedAt: Schema.Number,
    }),
  ),
  lease: Schema.NullOr(
    Schema.Struct({
      leaseID: Schema.String,
      ownerID: Schema.String,
      generation: Schema.Number,
      acquiredAt: Schema.Number,
      heartbeatAt: Schema.Number,
      expiresAt: Schema.Number,
    }),
  ),
  checkpoint: Schema.NullOr(
    Schema.Struct({
      checkpointID: Schema.String,
      eventSequence: Schema.Number,
      stateDigest: Schema.String,
      createdAt: Schema.Number,
    }),
  ),
  /** Optional for legacy runs; populated only when a child carries admission evidence. */
  admission: Schema.NullOr(CustomAgentAdmissionRecord),
})

export const MutationPostProcessingRecord = Schema.Struct({
  sequence: Schema.Number,
  stage: Schema.String,
  status: Schema.String,
  target: Schema.String.pipe(Schema.optional),
})

export const MutationPostProcessingRecoveryRecord = Schema.Struct({
  status: Schema.String,
  stage: Schema.String.pipe(Schema.optional),
  target: Schema.String.pipe(Schema.optional),
  sequence: Schema.Number.pipe(Schema.optional),
  reason: Schema.String,
})

export const MutationRecoveryRecord = Schema.Struct({
  transactionID: Schema.String,
  phase: Schema.String,
  decision: Schema.String,
  automaticRetryAllowed: Schema.Literal(false),
  requiresReview: Schema.Boolean,
  /** Append-only semantic side-effect checkpoints; absent on legacy records. */
  postProcessing: Schema.Array(MutationPostProcessingRecord).pipe(Schema.optional),
  /** Deterministic restart classification; absent on legacy records. */
  postProcessingRecovery: MutationPostProcessingRecoveryRecord.pipe(Schema.optional),
  reason: Schema.String,
})

/** Bounded metadata-only progress from the durable Action aggregate. */
export const ActionProgressRecord = Schema.Struct({
  phase: Schema.String,
  completed: Schema.Number,
  total: Schema.Number,
  sequence: Schema.Number,
  updatedAt: Schema.Number,
  detail: Schema.String.pipe(Schema.optional),
})

export const DurableActionRecord = Schema.Struct({
  actionID: Schema.String,
  runID: Schema.NullOr(Schema.String),
  sessionID: Schema.String,
  name: Schema.String,
  status: Schema.String,
  authority: Schema.String,
  riskTier: Schema.String,
  reasonSummary: Schema.String,
  resourceCount: Schema.Number,
  observationStatus: Schema.NullOr(Schema.String),
  resultReplayable: Schema.Boolean,
  outputDigest: Schema.NullOr(Schema.String),
  outputByteLength: Schema.NullOr(Schema.Number),
  /** Latest operation progress; it never grants retry or mutation authority. */
  progress: Schema.NullOr(ActionProgressRecord).pipe(Schema.optional),
  attemptsUsed: Schema.Number,
  maxAttempts: Schema.Number,
  durationMsUsed: Schema.Number,
  maxDurationMs: Schema.Number,
  costMicrosUsed: Schema.Number,
  maxCostMicros: Schema.Number,
  /**
   * Present only for a marked MCP child action. The handle is metadata-only:
   * it lets a client invoke the existing identity-bound read-only
   * reconciliation endpoint without exposing arguments, credentials, or
   * protocol response bodies.
   */
  mcpReconciliation: Schema.NullOr(Mcp.ReconciliationHandle).pipe(Schema.optional),
  mutationRecovery: Schema.NullOr(MutationRecoveryRecord),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

export const MutationInspectionRecord = Schema.Struct({
  transactionID: Schema.String,
  phase: Schema.String,
  observationDigest: Schema.String,
  decision: Schema.String,
  automaticRetryAllowed: Schema.Literal(false),
  rollbackAvailable: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      target: Schema.String,
      operation: Schema.String,
      state: Schema.String,
    }),
  ),
  reason: Schema.String,
})

export const MutationReviewRequest = Schema.Struct({
  transactionID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
  expectedPhase: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)),
  observationDigest: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  decision: Schema.Literals(["settle_postimage", "require_rollback", "confirm_rolled_back", "block_rollback"]),
  inspectedDecision: Schema.Literals(["postimage_matches", "preimage_matches", "manual_review"]),
})

/** Explicit human approval for a guarded artifact-backed rollback. */
export const MutationRollbackRequest = Schema.Struct({
  transactionID: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(256)),
  expectedPhase: Schema.Literal("rollback_required"),
  observationDigest: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(64)),
  inspectedDecision: Schema.Literal("postimage_matches"),
  approval: Schema.Literal("execute_rollback"),
})

/** Metadata-only health projection for profile-owned inverse artifacts. */
export const RollbackArtifactHealthRecord = Schema.Struct({
  status: Schema.Literals(["not_required", "available", "missing", "corrupt", "quota_pressure", "unavailable"]),
  referencedCount: Schema.Number,
  missingReferenceCount: Schema.Number,
  corruptCount: Schema.Number,
  overQuota: Schema.Boolean,
  reason: Schema.String,
})

export const RollbackArtifactAuditRecord = Schema.Struct({
  scannedEntries: Schema.Number,
  artifactCount: Schema.Number,
  totalBytes: Schema.Number,
  referencedCount: Schema.Number,
  orphanCount: Schema.Number,
  expiredOrphanCount: Schema.Number,
  missingReferenceCount: Schema.Number,
  invalidCount: Schema.Number,
  unsafeCount: Schema.Number,
  corruptCount: Schema.Number,
  overQuota: Schema.Boolean,
})

/** Read-only audit or explicitly confirmed profile maintenance result. */
export const RollbackArtifactMaintenanceQuery = Schema.Struct({
  ...LocationQuery.fields,
  /** Durable maintenance scan to resume; absent starts a new profile-owned scan. */
  scanID: Schema.String.pipe(Schema.optional),
  /** Backward-compatible seed cursor; it is captured into a new scan session. */
  cursor: Schema.String.pipe(Schema.optional),
})

export const RollbackArtifactMaintenanceRecord = Schema.Struct({
  scope: Schema.Literal("profile"),
  operation: Schema.Literals(["audit", "sweep"]),
  scanID: Schema.String,
  scanStatus: Schema.Literals(["active", "complete", "expired"]),
  pageNumber: Schema.Number,
  scannedActions: Schema.Number,
  scanLimit: Schema.Number,
  scanComplete: Schema.Boolean,
  scanExpiresAt: Schema.Number,
  sessionDigest: Schema.String,
  /** Present when another page must be requested before the scan is complete. */
  nextCursor: Schema.String.pipe(Schema.optional),
  referencedCount: Schema.Number,
  audit: RollbackArtifactAuditRecord,
  removed: Schema.Number,
})

/** The destructive operation is impossible to submit without a literal approval. */
export const RollbackArtifactMaintenanceRequest = Schema.Struct({
  scanID: Schema.String,
  approval: Schema.Literal("execute_sweep"),
  maxAgeMs: Schema.Number.pipe(Schema.optional),
  enforceQuota: Schema.Boolean.pipe(Schema.optional),
})

/**
 * Request-scoped recovery capabilities.  This is deliberately a capability
 * projection rather than a user identity: clients need to know which
 * recovery controls they may render, but must not receive tenant/profile
 * identifiers as part of the runtime-insight payload.
 */
export const RuntimeInsightAccess = Schema.Struct({
  role: Schema.Literals(["owner", "admin", "member"]),
  canReviewMutation: Schema.Boolean,
  canRollbackMutation: Schema.Boolean,
  canMaintainArtifacts: Schema.Boolean,
  canRecordMcpEvidence: Schema.Boolean,
})

/** Metadata-only view of one cross-owner child settlement reconciliation. */
export const ChildSettlementAuditRecord = Schema.Struct({
  parentRunID: Schema.String,
  childRunID: Schema.String,
  status: Schema.Literals(["complete", "repairable", "manual-review", "missing-intent"]),
  deterministic: Schema.Literal(true),
  providerExecutionAllowed: Schema.Literal(false),
  intentID: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(
    Schema.Struct({
      next: Schema.Array(Schema.String),
      missing: Schema.Array(Schema.String),
      conflicts: Schema.Array(Schema.String),
      complete: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
  reason: Schema.String,
  access: RuntimeInsightAccess,
})

/** Recovery requires an explicit human confirmation literal. */
export const ChildSettlementRecoveryRequest = Schema.Struct({
  approval: Schema.Literal("recover_settlement"),
})

/**
 * Explicit confirmation for the bounded owner-scoped recovery sweep.  The
 * sweep is intentionally separate from the single parent/child recovery
 * endpoint so an operator cannot accidentally turn an audit request into a
 * bulk write.  `limit` is bounded at the protocol edge as well as in Core.
 */
export const ChildSettlementRecoverySweepRequest = Schema.Struct({
  approval: Schema.Literal("recover_settlements"),
  status: Schema.Literals(["prepared", "recovery-required"]).pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(Schema.optional),
})

export const ChildSettlementRecoveryRecord = Schema.Struct({
  before: ChildSettlementAuditRecord,
  after: ChildSettlementAuditRecord,
  attempted: Schema.Array(Schema.String),
  repaired: Schema.Array(Schema.String),
  deterministic: Schema.Literal(true),
  providerExecutionAllowed: Schema.Literal(false),
  reason: Schema.String,
  access: RuntimeInsightAccess,
})

/** Metadata-only result for one item in the bounded settlement sweep. */
export const ChildSettlementRecoverySweepItemRecord = Schema.Struct({
  intentID: Schema.String,
  parentRunID: Schema.String,
  childRunID: Schema.String,
  sourceStatus: Schema.Literals(["prepared", "recovery-required"]),
  afterStatus: Schema.NullOr(Schema.Literals(["prepared", "committed", "recovery-required"])),
  outcome: Schema.Literals(["committed", "pending", "recovery-required", "failed"]),
  attempted: Schema.Array(Schema.String),
  repaired: Schema.Array(Schema.String),
  reason: Schema.String,
})

/**
 * Bounded, payload-free projection used by CLI/API/Desktop recovery surfaces.
 * Tenant and user identity remain server-side; only the request-scoped access
 * capabilities cross the wire.
 */
export const ChildSettlementRecoverySweepRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  status: Schema.NullOr(Schema.Literals(["prepared", "recovery-required"])),
  limit: Schema.Int,
  scanned: Schema.Int,
  committed: Schema.Int,
  pending: Schema.Int,
  recoveryRequired: Schema.Int,
  failed: Schema.Int,
  hasMore: Schema.Boolean,
  items: Schema.Array(ChildSettlementRecoverySweepItemRecord),
  deterministic: Schema.Literal(true),
  providerExecutionAllowed: Schema.Literal(false),
  reason: Schema.String,
  access: RuntimeInsightAccess,
})

export const ActionRecoveryRecord = Schema.Struct({
  actionID: Schema.String,
  actionStatus: Schema.String,
  state: Schema.String,
  outcome: Schema.NullOr(Schema.String),
  repair: Schema.Struct({
    required: Schema.Boolean,
    source: Schema.String,
    reason: Schema.NullOr(Schema.String),
  }),
  mutationRecovery: Schema.NullOr(MutationRecoveryRecord),
  inspection: Schema.NullOr(MutationInspectionRecord),
  inspectionError: Schema.NullOr(Schema.String),
  artifact: Schema.NullOr(RollbackArtifactHealthRecord),
  access: RuntimeInsightAccess,
})

export const MemoryRecallHit = Schema.Struct({
  memoryID: Schema.String,
  score: Schema.Number,
  source: Schema.String,
})

export const MemoryRecallRecord = Schema.Struct({
  timestamp: Schema.Number,
  sessionID: Schema.String,
  scopeHash: Schema.String,
  queryFingerprint: Schema.String,
  algorithm: Schema.String,
  algorithmRevision: Schema.String,
  latencyMs: Schema.Number,
  hits: Schema.Array(MemoryRecallHit),
})

export const RuntimeInsightPage = Schema.Struct({
  /** Request-scoped capabilities; no tenant/profile identity is projected. */
  access: RuntimeInsightAccess,
  contextLayers: Schema.Array(ContextLayersReport),
  routing: Schema.Array(RoutingDecision),
  verifications: Schema.Array(VerificationRecord),
  audit: Schema.Array(AuditEntry),
  auditDropped: Schema.Number,
  auditVerify: AuditVerify,
  runs: Schema.Array(RunRecord),
  durableRuns: Schema.Array(DurableRunRecord),
  durableActions: Schema.Array(DurableActionRecord),
  recalls: Schema.Array(MemoryRecallRecord),
})

export const makeRuntimeInsightGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
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
      HttpApiEndpoint.get("runtimeInsight.actionRecovery", `${root}/actions/:actionID/recovery`, {
        params: { actionID: Schema.String },
        query: LocationQuery,
        success: ActionRecoveryRecord,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.actionRecovery",
            summary: "Inspect durable action recovery state",
            description:
              "Read-only digest/fingerprint inspection of a mutation recovery record; it never retries, rolls back, or settles an action.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("runtimeInsight.actionRecoveryReview", `${root}/actions/:actionID/recovery/review`, {
        params: { actionID: Schema.String },
        query: LocationQuery,
        payload: MutationReviewRequest,
        success: ActionRecoveryRecord,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.actionRecoveryReview",
            summary: "Record an evidence-bound mutation review",
            description:
              "Records a human mutation phase review only after a fresh digest/fingerprint inspection; it never writes files, changes Action status, or enables automatic retry.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("runtimeInsight.actionRecoveryRollback", `${root}/actions/:actionID/recovery/rollback`, {
        params: { actionID: Schema.String },
        query: LocationQuery,
        payload: MutationRollbackRequest,
        success: ActionRecoveryRecord,
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.actionRecoveryRollback",
            summary: "Execute an evidence-bound mutation rollback",
            description:
              "After a fresh postimage inspection and explicit human approval, restores durable inverse artifacts with per-file CAS checks and records the rolled-back phase through ActionGateway; it never retries automatically.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("runtimeInsight.artifactMaintenance", `${root}/artifacts/maintenance`, {
        query: RollbackArtifactMaintenanceQuery,
        success: RollbackArtifactMaintenanceRecord,
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.artifactMaintenance",
            summary: "Audit profile-owned rollback artifacts",
            description:
              "Collects live references from durable actions and returns metadata-only artifact health. It never removes files.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("runtimeInsight.artifactMaintenanceSweep", `${root}/artifacts/maintenance`, {
        query: LocationQuery,
        payload: RollbackArtifactMaintenanceRequest,
        success: RollbackArtifactMaintenanceRecord,
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.artifactMaintenanceSweep",
            summary: "Sweep unreferenced rollback artifacts",
            description:
              "Performs an explicitly approved metadata-only retention/quota sweep after a complete durable-reference scan; referenced or corrupt artifacts are never removed.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("runtimeInsight.auditVerify", `${root}/audit/verify`, {
        query: LocationQuery,
        success: AuditVerify,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("runtimeInsight.childSettlementAudit", `${root}/settlements/:parentRunID/:childRunID`, {
        params: { parentRunID: Schema.String, childRunID: Schema.String },
        query: LocationQuery,
        success: ChildSettlementAuditRecord,
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.childSettlementAudit",
            summary: "Inspect child settlement recovery state",
            description:
              "Returns a bounded, payload-free cross-owner settlement audit. It never executes a provider or schedules a retry.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "runtimeInsight.childSettlementRecover",
        `${root}/settlements/:parentRunID/:childRunID/recover`,
        {
          params: { parentRunID: Schema.String, childRunID: Schema.String },
          query: LocationQuery,
          payload: ChildSettlementRecoveryRequest,
          success: ChildSettlementRecoveryRecord,
          error: [ForbiddenError, InvalidRequestError],
        },
      )
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.childSettlementRecover",
            summary: "Recover a child settlement after explicit confirmation",
            description:
              "Replays only deterministic idempotent owner writes through the durable recovery outbox. Provider execution and automatic retry are forbidden.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("runtimeInsight.childSettlementRecoverySweep", `${root}/settlements/recover-pending`, {
        query: LocationQuery,
        payload: ChildSettlementRecoverySweepRequest,
        success: ChildSettlementRecoverySweepRecord,
        error: [ForbiddenError, InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.runtimeInsight.childSettlementRecoverySweep",
            summary: "Recover a bounded page of pending child settlements",
            description:
              "With explicit owner/admin confirmation, scans and recovers a bounded tenant-scoped page of prepared or recovery-required settlement receipts. It never accepts payloads, calls a provider, or retries external work.",
          }),
        ),
    )
