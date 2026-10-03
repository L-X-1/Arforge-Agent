import { DateTime, Effect, Layer, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Mcp } from "@arforge-ai/schema/mcp"
import { Database } from "@arforge-ai/core/database/database"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { attachRuntimePersistence, RuntimeToolExecution } from "@arforge-ai/core/runtime"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as ChildSettlementAudit from "@arforge-ai/core/runtime/child-settlement-audit"
import * as ChildSettlementRecovery from "@arforge-ai/core/runtime/child-settlement-recovery"
import { ActionGateway } from "@arforge-ai/core/action-gateway"
import { FileMutation } from "@arforge-ai/core/file-mutation"
import { RollbackArtifact } from "@arforge-ai/core/runtime"
import * as ArtifactMaintenanceScan from "@arforge-ai/core/runtime/artifact-maintenance-scan"
import { Location } from "@arforge-ai/core/location"
import * as MutationIntentRuntime from "@arforge-ai/core/runtime/mutation-intent"
import { ForbiddenError, InvalidRequestError } from "@arforge-ai/protocol/errors"
import { IdentityContext } from "../identity-context"

const inspectionErrorMessage = "Current target fingerprints could not be read; manual inspection is required."
const ARTIFACT_SCAN_LIMIT = 100_000
const MCP_CHILD_ACTION_RESOURCE = Mcp.CHILD_ACTION_RESOURCE
type ArtifactHealthStatus = "not_required" | "available" | "missing" | "corrupt" | "quota_pressure" | "unavailable"
type ArtifactHealth = Readonly<{
  readonly status: ArtifactHealthStatus
  readonly referencedCount: number
  readonly missingReferenceCount: number
  readonly corruptCount: number
  readonly overQuota: boolean
  readonly reason: string
}>

/**
 * Project the minimum identity needed by the existing MCP reconciliation
 * route. This is intentionally null for ordinary actions; no generic
 * runtime-insight row should become an MCP maintenance target by name alone.
 */
export const mcpReconciliationHandle = (snapshot: DurableAction.Snapshot): Mcp.ReconciliationHandle | null => {
  const action = snapshot.action
  if (action.parentActionID === undefined || !action.resources.includes(MCP_CHILD_ACTION_RESOURCE)) return null
  if (action.intentDigest === undefined || action.idempotencyKey.length === 0) return null

  const durable = snapshot.reconciliation
  const observation = snapshot.observation
  const state =
    durable?.state ??
    (observation?.status === "succeeded" ? "known_success" : observation?.status === "failed" ? "known_failure" : null)
  const observedAt = durable
    ? DateTime.toEpochMillis(durable.observedAt)
    : observation
      ? DateTime.toEpochMillis(observation.observedAt)
      : null

  return {
    actionKind: "mcp",
    actionVersion: "1",
    intentDigest: action.intentDigest,
    idempotencyKey: action.idempotencyKey,
    state,
    evidenceDigest: durable?.evidenceDigest ?? null,
    source: durable?.source ?? null,
    observedAt,
    summary: durable?.summary ?? null,
    operatorRequired: true,
  }
}

const inspectArtifactHealth = (
  snapshot: DurableAction.Snapshot,
  store: RollbackArtifact.RollbackArtifactStore,
): Effect.Effect<ArtifactHealth> =>
  Effect.promise(async (): Promise<ArtifactHealth> => {
    let references: ReadonlyArray<RollbackArtifact.RollbackArtifactRef>
    try {
      references = RollbackArtifact.collectReferencedArtifacts([snapshot])
    } catch {
      return {
        status: "unavailable" as const,
        referencedCount: 0,
        missingReferenceCount: 0,
        corruptCount: 0,
        overQuota: false,
        reason: "Durable inverse-artifact metadata is invalid; manual recovery is required.",
      }
    }
    if (references.length === 0)
      return {
        status: "not_required" as const,
        referencedCount: 0,
        missingReferenceCount: 0,
        corruptCount: 0,
        overQuota: false,
        reason: "This mutation does not require a durable inverse artifact.",
      }

    let audit: RollbackArtifact.RollbackArtifactAudit
    try {
      audit = await store.audit({ referenced: references })
    } catch {
      return {
        status: "unavailable" as const,
        referencedCount: references.length,
        missingReferenceCount: 0,
        corruptCount: 0,
        overQuota: false,
        reason: "The profile artifact store could not be inspected; manual recovery is required.",
      }
    }

    let missingReferenceCount = 0
    let corruptCount = 0
    for (const reference of references) {
      try {
        await store.read(reference)
      } catch (error) {
        if (error instanceof RollbackArtifact.RollbackArtifactError && error.code === "not_found")
          missingReferenceCount += 1
        else corruptCount += 1
      }
    }
    const status: ArtifactHealthStatus =
      missingReferenceCount > 0
        ? "missing"
        : corruptCount > 0
          ? "corrupt"
          : audit.overQuota
            ? "quota_pressure"
            : "available"
    const reason =
      status === "missing"
        ? "An inverse artifact is missing; guarded rollback is blocked and manual recovery is required."
        : status === "corrupt"
          ? "An inverse artifact failed integrity or decryption checks; guarded rollback is blocked."
          : status === "quota_pressure"
            ? "Inverse artifacts are readable, but profile quota pressure should be handled by a maintainer."
            : "All inverse artifacts are present and integrity-checked."
    return {
      status,
      referencedCount: references.length,
      missingReferenceCount,
      corruptCount,
      overQuota: audit.overQuota,
      reason,
    }
  })

const maintenanceError = (message: string) =>
  new InvalidRequestError({ kind: "rollback-artifact-maintenance-failed", message })

const assertMaintenanceRole = Effect.fn("RuntimeInsight.assertMaintenanceRole")(function* () {
  const principal = yield* IdentityContext.Current
  if (principal.role === "member")
    return yield* new ForbiddenError({ message: "Artifact maintenance is available to profile administrators only." })
})

/**
 * Project the authenticated principal into recovery capabilities.  The
 * runtime-insight payload exposes only these bounded capabilities so Browser
 * and Desktop can explain a role boundary without receiving profile/tenant
 * identity.  Mutation review is evidence-only; guarded rollback and artifact
 * maintenance remain administrator operations.
 */
export const runtimeInsightAccess = (role: IdentityContext.Principal["role"]) => ({
  role,
  canReviewMutation: true,
  canRollbackMutation: role !== "member",
  canMaintainArtifacts: role !== "member",
  canRecordMcpEvidence: role !== "member",
})

export const recoveryRollbackPermission = (role: IdentityContext.Principal["role"]) =>
  runtimeInsightAccess(role).canRollbackMutation
    ? undefined
    : "Guarded mutation rollback requires an authenticated Owner or Admin."

const assertRecoveryRollbackRole = Effect.fn("RuntimeInsight.assertRecoveryRollbackRole")(function* () {
  const principal = yield* IdentityContext.Current
  const denial = recoveryRollbackPermission(principal.role)
  if (denial !== undefined) return yield* new ForbiddenError({ message: denial })
})

const assertSettlementRecoveryRole = Effect.fn("RuntimeInsight.assertSettlementRecoveryRole")(function* () {
  const principal = yield* IdentityContext.Current
  if (principal.role === "member")
    return yield* new ForbiddenError({ message: "Child settlement recovery requires an authenticated Owner or Admin." })
  return principal
})

const invalidSettlementRequest = (field: string, message: string) =>
  new InvalidRequestError({ kind: "child-settlement-recovery-invalid-request", field, message })

const parseSettlementRunID = (value: string, field: string): AgentRuntime.RunID => {
  if (typeof value !== "string" || !/^run_[A-Za-z0-9._:-]{1,255}$/.test(value))
    throw invalidSettlementRequest(field, "The settlement run identity is invalid or exceeds its bounded contract.")
  return AgentRuntime.RunID.make(value)
}

/**
 * Re-check the immutable run/location relationship at the route boundary.
 * DurableRun is the run owner; the location middleware is the request owner.
 * The recovery service is never allowed to use a caller-supplied path as an
 * authorization substitute.
 */
const settlementScope = Effect.fn("RuntimeInsight.settlementScope")(function* (
  parentRunID: AgentRuntime.RunID,
  childRunID: AgentRuntime.RunID,
) {
  const location = yield* Location.Service
  const runs = yield* DurableRun.Service
  const parent = yield* runs.load(parentRunID).pipe(
    Effect.catchTag("DurableRun.NotFoundError", () =>
      invalidSettlementRequest("parentRunID", "The parent durable run was not found."),
    ),
    Effect.catchTag("DurableRun.CorruptHistoryError", (error) =>
      invalidSettlementRequest("parentRunID", `The parent durable run history is corrupt: ${error.reason}`),
    ),
  )
  const child = yield* runs.load(childRunID).pipe(
    Effect.catchTag("DurableRun.NotFoundError", () =>
      invalidSettlementRequest("childRunID", "The child durable run was not found."),
    ),
    Effect.catchTag("DurableRun.CorruptHistoryError", (error) =>
      invalidSettlementRequest("childRunID", `The child durable run history is corrupt: ${error.reason}`),
    ),
  )
  if (
    !("sessionID" in parent.run) ||
    parent.run.location === undefined ||
    String(parent.run.location) !== String(location.directory)
  )
    return yield* invalidSettlementRequest(
      "parentRunID",
      "The parent durable run is outside the requested location scope.",
    )
  if (
    !("sessionID" in child.run) ||
    child.run.location === undefined ||
    String(child.run.location) !== String(location.directory) ||
    !("child" in child.run) ||
    child.run.child === undefined ||
    child.run.child.parentRunID !== parentRunID
  )
    return yield* invalidSettlementRequest(
      "childRunID",
      "The child durable run is not an immutable child of the requested parent/location.",
    )
  return { parentRunID, childRunID }
})

const projectChildSettlementAudit = (
  report: ChildSettlementAudit.SettlementAuditReport,
  access: ReturnType<typeof runtimeInsightAccess>,
) => ({
  parentRunID: String(report.parentRunID),
  childRunID: String(report.childRunID),
  status: report.status,
  deterministic: true as const,
  providerExecutionAllowed: false as const,
  intentID: report.intentID ?? null,
  decision:
    report.decision === undefined
      ? null
      : {
          next: [...report.decision.next],
          missing: [...report.decision.missing],
          conflicts: [...report.decision.conflicts],
          complete: report.decision.complete,
          reason: report.decision.reason,
        },
  reason: report.reason,
  access,
})

const projectChildSettlementRecoverySweep = (
  report: ChildSettlementRecovery.SettlementRecoverySweepReport,
  access: ReturnType<typeof runtimeInsightAccess>,
) => ({
  schemaVersion: 1 as const,
  status: report.status ?? null,
  limit: report.limit,
  scanned: report.scanned,
  committed: report.committed,
  pending: report.pending,
  recoveryRequired: report.recoveryRequired,
  failed: report.failed,
  hasMore: report.hasMore,
  items: report.items.map((item) => ({
    intentID: item.intentID,
    parentRunID: String(item.parentRunID),
    childRunID: String(item.childRunID),
    sourceStatus: item.sourceStatus,
    afterStatus: item.afterStatus ?? null,
    outcome: item.outcome,
    attempted: [...item.attempted],
    repaired: [...item.repaired],
    reason: item.reason,
  })),
  deterministic: true as const,
  providerExecutionAllowed: false as const,
  reason:
    report.failed > 0 || report.recoveryRequired > 0
      ? "部分 settlement recovery 项目仍需人工复核；未执行 Provider 或外部重试。"
      : report.scanned === 0
        ? "没有发现当前租户下待处理的 settlement recovery receipt。"
        : report.hasMore
          ? "本页已完成；仍有更多待处理 receipt，请在确认后继续下一页。"
          : "本页 settlement recovery 已完成；未执行 Provider 或外部重试。",
  access,
})

const artifactAudit = (
  store: RollbackArtifact.RollbackArtifactStore,
  references: ReadonlyArray<RollbackArtifact.RollbackArtifactRef>,
) =>
  Effect.tryPromise({
    try: () => store.audit({ referenced: references }),
    catch: () => maintenanceError("The profile artifact store could not be audited; no files were removed."),
  })

const maintenanceRecord = (input: {
  readonly operation: "audit" | "sweep"
  readonly scan: ArtifactMaintenanceScan.Scan
  readonly audit: RollbackArtifact.RollbackArtifactAudit | RollbackArtifact.RollbackArtifactSweepReport
  readonly removed: number
  readonly nextCursor?: string
}) => ({
  scope: "profile" as const,
  operation: input.operation,
  scanID: input.scan.scanID,
  scanStatus: input.scan.status,
  pageNumber: input.scan.pageCount,
  scannedActions: input.scan.scannedActions,
  scanLimit: input.scan.scanLimit,
  scanComplete: input.scan.status === "complete",
  scanExpiresAt: input.scan.expiresAt,
  sessionDigest: input.scan.sessionDigest,
  ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  referencedCount: input.scan.referencedCount,
  audit: {
    scannedEntries: input.audit.scannedEntries,
    artifactCount: input.audit.artifactCount,
    totalBytes: input.audit.totalBytes,
    referencedCount: input.audit.referencedCount,
    orphanCount: input.audit.orphanCount,
    expiredOrphanCount: input.audit.expiredOrphanCount,
    missingReferenceCount: input.audit.missingReferenceCount,
    invalidCount: input.audit.invalidCount,
    unsafeCount: input.audit.unsafeCount,
    corruptCount: input.audit.corruptCount,
    overQuota: input.audit.overQuota,
  },
  removed: input.removed,
})

const maintenanceScanError = (error: unknown) => {
  if (error instanceof ArtifactMaintenanceScan.NotFoundError)
    return maintenanceError("The maintenance scan was not found in the current profile.")
  if (error instanceof ArtifactMaintenanceScan.ExpiredError)
    return maintenanceError("The maintenance scan expired; start a new audit before continuing.")
  if (error instanceof ArtifactMaintenanceScan.CorruptError)
    return maintenanceError("The maintenance scan ledger failed integrity validation; no artifacts were changed.")
  if (error instanceof ArtifactMaintenanceScan.StaleRevisionError)
    return maintenanceError("The maintenance scan changed while this page was being recorded; refresh and continue.")
  if (error instanceof ArtifactMaintenanceScan.InvalidInputError) return maintenanceError(error.reason)
  return maintenanceError("The maintenance scan failed closed; no artifacts were changed.")
}

type CompleteMaintenanceScan = Readonly<{
  readonly scan: ArtifactMaintenanceScan.Scan
  readonly pages: ReadonlyArray<ArtifactMaintenanceScan.Page>
  readonly snapshots: ReadonlyArray<DurableAction.Snapshot>
  readonly references: ReadonlyArray<RollbackArtifact.RollbackArtifactRef>
}>

const collectCompleteMaintenanceScan = (
  actions: DurableAction.Interface,
  scans: ArtifactMaintenanceScan.Interface,
  scan: ArtifactMaintenanceScan.Scan,
): Effect.Effect<CompleteMaintenanceScan, InvalidRequestError> =>
  Effect.gen(function* () {
    if (scan.status !== "complete")
      return yield* Effect.fail(maintenanceError("Complete every audit page before using it for artifact cleanup."))
    const pages = yield* scans.pages(scan.scanID)
    const snapshots: DurableAction.Snapshot[] = []
    let cursor = scan.startCursor
    for (const [index, expected] of pages.entries()) {
      const page = yield* actions.listPage({
        limit: scan.scanLimit,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (
        expected.pageNumber !== index + 1 ||
        expected.cursorBefore !== cursor ||
        expected.cursorAfter !== page.nextCursor ||
        expected.scannedActions !== page.items.length
      )
        return yield* Effect.fail(
          maintenanceError(
            "Durable action history changed since the audit; restart the maintenance scan before cleanup.",
          ),
        )
      snapshots.push(...page.items)
      cursor = page.nextCursor
    }
    if (cursor !== undefined || pages.length !== scan.pageCount)
      return yield* Effect.fail(
        maintenanceError(
          "The completed maintenance scan no longer matches the durable action history; no artifacts were removed.",
        ),
      )
    let references: ReadonlyArray<RollbackArtifact.RollbackArtifactRef>
    try {
      references = RollbackArtifact.collectReferencedArtifacts(snapshots)
    } catch {
      return yield* Effect.fail(
        maintenanceError("Durable inverse-artifact references are invalid; maintenance was not run."),
      )
    }
    if (references.length !== scan.referencedCount)
      return yield* Effect.fail(
        maintenanceError(
          "Durable artifact references changed since the audit; restart the maintenance scan before cleanup.",
        ),
      )
    return { scan, pages, snapshots, references } satisfies CompleteMaintenanceScan
  }).pipe(
    Effect.catchTag("DurableAction.InvalidListCursorError", () =>
      Effect.fail(maintenanceError("The maintenance scan cursor is invalid; restart the audit from the beginning.")),
    ),
    Effect.catchTag("DurableAction.CorruptHistoryError", () =>
      Effect.fail(maintenanceError("Durable action history could not be verified; no artifacts were removed.")),
    ),
    Effect.catchTag("ArtifactMaintenanceScan.NotFoundError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.CorruptError", (error) => Effect.fail(maintenanceScanError(error))),
  )

const artifactMaintenanceReport = (
  actions: DurableAction.Interface,
  store: RollbackArtifact.RollbackArtifactStore,
  scans: ArtifactMaintenanceScan.Interface,
  operation: "audit" | "sweep",
  options?: { readonly maxAgeMs?: number; readonly enforceQuota?: boolean },
  input?: { readonly scanID?: string; readonly cursor?: string },
): Effect.Effect<ReturnType<typeof maintenanceRecord>, InvalidRequestError> =>
  Effect.gen(function* () {
    if (input?.cursor !== undefined && !ArtifactMaintenanceScan.isCursor(input.cursor))
      return yield* Effect.fail(
        maintenanceError("The maintenance scan cursor is invalid; restart the audit from the beginning."),
      )
    if (input?.scanID !== undefined && !ArtifactMaintenanceScan.isScanID(input.scanID))
      return yield* Effect.fail(
        maintenanceError("The maintenance scan ID is invalid; restart the audit from the beginning."),
      )
    // Profile lifecycle callers share one explicit maintenance tick. It
    // expires abandoned sessions before a new/resumed page can be admitted;
    // no background worker is started by an HTTP request.
    yield* scans.tick()
    let scan: ArtifactMaintenanceScan.Scan
    try {
      if (input?.scanID !== undefined) {
        scan = yield* scans.get(ArtifactMaintenanceScan.ScanID.make(input.scanID))
        if (input.cursor !== undefined && input.cursor !== scan.cursor)
          return yield* Effect.fail(
            maintenanceError("The supplied cursor does not match this durable maintenance scan."),
          )
      } else {
        scan = yield* scans.create({ startCursor: input?.cursor })
      }
    } catch (error) {
      return yield* Effect.fail(maintenanceScanError(error))
    }

    if (operation === "sweep") {
      return yield* scans.withLease(
        scan.scanID,
        Effect.gen(function* () {
          const current = yield* scans.get(scan.scanID)
          const complete = yield* collectCompleteMaintenanceScan(actions, scans, current)
          const swept = yield* Effect.tryPromise({
            try: () =>
              store.sweepDetailed({
                referenced: complete.references,
                ...(options?.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
                enforceQuota: options?.enforceQuota === true,
              }),
            catch: () =>
              maintenanceError("The profile artifact sweep failed closed; inspect the store before retrying."),
          })
          return maintenanceRecord({ operation, scan: complete.scan, audit: swept, removed: swept.removed })
        }),
        { timeoutMs: 5_000, staleMs: 30_000 },
      )
    }

    if (scan.status === "expired")
      return yield* Effect.fail(maintenanceError("The maintenance scan expired; start a new audit."))
    if (scan.status === "complete") {
      const complete = yield* collectCompleteMaintenanceScan(actions, scans, scan)
      const audit = yield* artifactAudit(store, complete.references)
      return maintenanceRecord({ operation, scan: complete.scan, audit, removed: 0 })
    }

    return yield* scans.withLease(
      scan.scanID,
      Effect.gen(function* () {
        const current = yield* scans.get(scan.scanID)
        if (current.status === "expired")
          return yield* Effect.fail(maintenanceError("The maintenance scan expired; start a new audit."))
        if (current.status === "complete") {
          const complete = yield* collectCompleteMaintenanceScan(actions, scans, current)
          const audit = yield* artifactAudit(store, complete.references)
          return maintenanceRecord({ operation, scan: complete.scan, audit, removed: 0 })
        }

        const durablePage = yield* actions.listPage({
          limit: current.scanLimit,
          ...(current.cursor === undefined ? {} : { cursor: current.cursor }),
        })
        let references: ReadonlyArray<RollbackArtifact.RollbackArtifactRef>
        try {
          references = RollbackArtifact.collectReferencedArtifacts(durablePage.items)
        } catch {
          return yield* Effect.fail(
            maintenanceError("Durable inverse-artifact references are invalid; maintenance was not run."),
          )
        }
        const audit = yield* artifactAudit(store, references)
        const nextScan = yield* scans.recordPage({
          scanID: current.scanID,
          expectedRevision: current.revision,
          cursorBefore: current.cursor,
          cursorAfter: durablePage.nextCursor,
          scannedActions: durablePage.items.length,
          referencedCount: references.length,
          audit,
        })
        const page = (yield* scans.pages(current.scanID)).at(-1)
        if (page === undefined)
          return yield* Effect.fail(maintenanceError("The maintenance page ledger was not written."))
        if (nextScan.status === "complete") {
          const complete = yield* collectCompleteMaintenanceScan(actions, scans, nextScan)
          const finalAudit = yield* artifactAudit(store, complete.references)
          return maintenanceRecord({ operation, scan: complete.scan, audit: finalAudit, removed: 0 })
        }
        return maintenanceRecord({ operation, scan: nextScan, audit, removed: 0, nextCursor: durablePage.nextCursor })
      }),
      { timeoutMs: 5_000, staleMs: 30_000 },
    )
  }).pipe(
    Effect.catchTag("DurableAction.InvalidListCursorError", () =>
      Effect.fail(maintenanceError("The maintenance scan cursor is invalid; restart the audit from the beginning.")),
    ),
    Effect.catchTag("DurableAction.CorruptHistoryError", () =>
      Effect.fail(maintenanceError("Durable action history could not be verified; no artifacts were removed.")),
    ),
    Effect.catchTag("ArtifactMaintenanceScan.NotFoundError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.ExpiredError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.StaleRevisionError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.InvalidInputError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.CorruptError", (error) => Effect.fail(maintenanceScanError(error))),
    Effect.catchTag("ArtifactMaintenanceScan.LeaseUnavailableError", () =>
      Effect.fail(maintenanceError("Another maintenance worker is using this profile; retry shortly.")),
    ),
  )

const buildRecoveryView = (
  snapshot: DurableAction.Snapshot,
  worktree: string,
  files: Pick<FileMutation.Interface, "fingerprint">,
  store: RollbackArtifact.RollbackArtifactStore,
  access: ReturnType<typeof runtimeInsightAccess>,
) =>
  Effect.gen(function* () {
    const projection = RuntimeToolExecution.project(snapshot, "recovery")
    const mutation = projection.mutationRecovery
    const requiresReview =
      mutation !== undefined &&
      mutation.phase !== "rolled_back" &&
      !(mutation.phase === "settled" && projection.state === "settled" && projection.outcome !== undefined)

    let inspection: MutationIntentRuntime.MutationInspectionProjection | null = null
    let inspectionError: string | null = null
    if (projection.mutationIntent !== undefined) {
      const inspected = yield* FileMutation.inspectIntent({
        files,
        worktree,
        intent: projection.mutationIntent,
      }).pipe(
        Effect.map((value) => ({ value, error: null as string | null })),
        Effect.catch(() => Effect.succeed({ value: null, error: inspectionErrorMessage })),
      )
      inspection = inspected.value
      inspectionError = inspected.error
    }

    const artifact = yield* inspectArtifactHealth(snapshot, store)
    const recordInspection =
      inspection === null
        ? null
        : {
            ...inspection,
            rollbackAvailable:
              inspection.rollbackAvailable &&
              (artifact.status === "not_required" ||
                artifact.status === "available" ||
                artifact.status === "quota_pressure"),
          }

    return {
      projection,
      mutation,
      inspection,
      inspectionError,
      artifact,
      record: {
        actionID: projection.actionID,
        actionStatus: projection.actionStatus,
        state: projection.state,
        outcome: projection.outcome ?? null,
        repair: {
          required: projection.repair.required,
          source: projection.repair.source,
          reason: projection.repair.reason ?? null,
        },
        mutationRecovery:
          mutation === undefined
            ? null
            : {
                transactionID: mutation.transactionID,
                phase: mutation.phase,
                decision: mutation.decision,
                automaticRetryAllowed: mutation.automaticRetryAllowed,
                requiresReview,
                postProcessing: mutation.postProcessing,
                postProcessingRecovery: mutation.postProcessingRecovery,
                reason: mutation.reason,
              },
        inspection: recordInspection,
        inspectionError,
        artifact,
        access,
      },
    }
  })

export const RuntimeInsightHandler = HttpApiBuilder.group(Api, "server.runtimeInsight", (handlers) =>
  handlers
    .handle(
      "runtimeInsight.snapshot",
      Effect.fn(function* (ctx) {
        const limit = Number(ctx.query.limit ?? "50")
        const bounded = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
        const audit = RuntimeInsight.auditList(bounded)
        const durableRuns = yield* DurableRun.Service.pipe(
          Effect.flatMap((service) => service.list({ limit: bounded })),
          Effect.catchTag(
            "DurableRun.CorruptHistoryError",
            (error) =>
              new InvalidRequestError({
                kind: "durable-run-history-corrupt",
                message: `Durable run history failed integrity validation: ${error.reason}`,
              }),
          ),
        )
        const durableActions = yield* DurableAction.Service.pipe(
          Effect.flatMap((service) => service.list({ limit: bounded })),
          Effect.catchTag(
            "DurableAction.CorruptHistoryError",
            (error) =>
              new InvalidRequestError({
                kind: "durable-action-history-corrupt",
                message: `Durable action history failed integrity validation: ${error.reason}`,
              }),
          ),
        )
        const access = runtimeInsightAccess((yield* IdentityContext.Current).role)
        return {
          access,
          contextLayers: RuntimeInsight.contextLayers(20),
          routing: RuntimeInsight.routingDecisions(bounded),
          verifications: RuntimeInsight.verifications(bounded),
          // Tenant ownership is persistence metadata, not a public snapshot
          // field. The access projection above contains only bounded
          // capabilities; it never exposes user, tenant, or profile IDs.
          audit: audit.entries.map((entry) => ({
            seq: entry.seq,
            recordedAt: entry.recordedAt,
            actor: entry.actor,
            action: entry.action,
            resource: entry.resource,
            reason: entry.reason ?? null,
            metadata: entry.metadata,
            previousHash: entry.previousHash,
            recordHash: entry.recordHash,
          })),
          auditDropped: audit.dropped,
          auditVerify: RuntimeInsight.auditVerify(),
          runs: RuntimeInsight.runs(bounded),
          // The current wire contract is session-shaped and requires a real
          // sessionID. Control runs are deliberately excluded until the
          // protocol exposes a subject-aware control-run record; never invent
          // a session identity for a control-plane operation.
          durableRuns: durableRuns
            .filter((snapshot): snapshot is DurableRun.SessionSnapshot => "sessionID" in snapshot.run)
            .map(({ run, checkpoint, lease, activeAttempt, lastLeaseGeneration, lastTransition }) => ({
              runID: run.id,
              sessionID: run.sessionID,
              status: run.status,
              initiator: run.initiator,
              authority: run.authority,
              riskTier: run.riskTier,
              reasonSummary: run.reasonSummary,
              attemptsUsed: run.budget.attemptsUsed,
              maxAttempts: run.budget.maxAttempts,
              durationMsUsed: run.budget.durationMsUsed,
              maxDurationMs: run.budget.maxDurationMs,
              costMicrosUsed: run.budget.costMicrosUsed,
              maxCostMicros: run.budget.maxCostMicros,
              activeAttempt: activeAttempt
                ? {
                    attempt: activeAttempt.attempt,
                    startedAt: DateTime.toEpochMillis(activeAttempt.startedAt),
                  }
                : null,
              createdAt: DateTime.toEpochMillis(run.time.created),
              updatedAt: DateTime.toEpochMillis(run.time.updated),
              startedAt: run.time.started ? DateTime.toEpochMillis(run.time.started) : null,
              finishedAt: run.time.finished ? DateTime.toEpochMillis(run.time.finished) : null,
              lastLeaseGeneration: lastLeaseGeneration ?? null,
              lastTransition: lastTransition
                ? {
                    from: lastTransition.from,
                    to: lastTransition.to,
                    reason: lastTransition.reason,
                    changedAt: DateTime.toEpochMillis(lastTransition.changedAt),
                  }
                : null,
              lease: lease
                ? {
                    leaseID: lease.id,
                    ownerID: lease.ownerID,
                    generation: lease.generation,
                    acquiredAt: DateTime.toEpochMillis(lease.acquiredAt),
                    heartbeatAt: DateTime.toEpochMillis(lease.heartbeatAt),
                    expiresAt: DateTime.toEpochMillis(lease.expiresAt),
                  }
                : null,
              checkpoint: checkpoint
                ? {
                    checkpointID: checkpoint.id,
                    eventSequence: checkpoint.eventSequence,
                    stateDigest: checkpoint.stateDigest,
                    createdAt: DateTime.toEpochMillis(checkpoint.createdAt),
                  }
                : null,
              admission:
                run.child?.runtimeAdmission === undefined
                  ? null
                  : {
                      role: run.child.runtimeAdmission.evidence.role,
                      status: run.child.runtimeAdmission.evidence.status,
                      decision: run.child.runtimeAdmission.evidence.decision,
                      reason: run.child.runtimeAdmission.evidence.reason,
                      ready: run.child.runtimeAdmission.evidence.ready,
                      descriptorDigest: run.child.runtimeAdmission.evidence.descriptor_digest ?? null,
                      checks: {
                        statusConsistent: run.child.runtimeAdmission.evidence.checks.status_consistent,
                        descriptorDigestConsistent:
                          run.child.runtimeAdmission.evidence.checks.descriptor_digest_consistent,
                        toolProjectionConsistent: run.child.runtimeAdmission.evidence.checks.tool_projection_consistent,
                        payloadFree: run.child.runtimeAdmission.evidence.checks.payload_free,
                      },
                      declaredToolCount: run.child.runtimeAdmission.evidence.declared_tool_count,
                      canonicalToolCount: run.child.runtimeAdmission.evidence.canonical_tool_count,
                      unsupportedToolCount: run.child.runtimeAdmission.evidence.unsupported_tool_count,
                      valid: run.child.runtimeAdmission.evidence.valid,
                      evidenceRefs: run.child.runtimeAdmission.evidenceRefs.map(String),
                    },
            })),
          // The runtime-insight wire contract is session-shaped: only real
          // session durable actions are reported. Control-plane actions are
          // excluded up front (never fabricated into a sessionID); a
          // subject-aware control-plane view belongs to a later batch.
          durableActions: durableActions
            .filter(
              (snapshot): snapshot is DurableAction.Snapshot & { action: AgentRuntime.SessionAction } =>
                "sessionID" in snapshot.action,
            )
            .map((snapshot) => {
              const { action, observation } = snapshot
              const projection = RuntimeToolExecution.project(snapshot, "recovery")
              const mutation = projection.mutationRecovery
              const requiresReview =
                mutation !== undefined &&
                mutation.phase !== "rolled_back" &&
                !(mutation.phase === "settled" && projection.state === "settled" && projection.outcome !== undefined)
              return {
                actionID: action.id,
                runID: action.runID ?? null,
                sessionID: action.sessionID,
                name: action.name,
                status: action.status,
                authority: action.authority,
                riskTier: action.riskTier,
                reasonSummary: action.reasonSummary,
                resourceCount: action.resources.length,
                observationStatus: observation?.status ?? null,
                resultReplayable: observation?.output !== undefined,
                outputDigest: observation?.output?.digest ?? null,
                outputByteLength: observation?.output?.byteLength ?? null,
                progress:
                  snapshot.progress === undefined
                    ? null
                    : {
                        phase: snapshot.progress.phase,
                        completed: snapshot.progress.completed,
                        total: snapshot.progress.total,
                        sequence: snapshot.progress.sequence,
                        updatedAt: DateTime.toEpochMillis(snapshot.progress.updatedAt),
                        ...(snapshot.progress.detail === undefined ? {} : { detail: snapshot.progress.detail }),
                      },
                attemptsUsed: action.budget.attemptsUsed,
                maxAttempts: action.budget.maxAttempts,
                durationMsUsed: action.budget.durationMsUsed,
                maxDurationMs: action.budget.maxDurationMs,
                costMicrosUsed: action.budget.costMicrosUsed,
                maxCostMicros: action.budget.maxCostMicros,
                mcpReconciliation: mcpReconciliationHandle(snapshot),
                mutationRecovery:
                  mutation === undefined
                    ? null
                    : {
                        transactionID: mutation.transactionID,
                        phase: mutation.phase,
                        decision: mutation.decision,
                        automaticRetryAllowed: mutation.automaticRetryAllowed,
                        requiresReview,
                        postProcessing: mutation.postProcessing,
                        postProcessingRecovery: mutation.postProcessingRecovery,
                        reason: mutation.reason,
                      },
                createdAt: DateTime.toEpochMillis(action.time.created),
                updatedAt: DateTime.toEpochMillis(action.time.updated),
              }
            }),
          recalls: RuntimeInsight.memoryRecalls(bounded),
        }
      }),
    )
    .handle(
      "runtimeInsight.actionRecovery",
      Effect.fn(function* (ctx) {
        const actions = yield* DurableAction.Service
        const snapshot = yield* actions.load(AgentRuntime.ActionID.make(ctx.params.actionID)).pipe(
          Effect.catchTag(
            "DurableAction.NotFoundError",
            () =>
              new InvalidRequestError({
                kind: "durable-action-not-found",
                field: "actionID",
                message: "The requested durable action was not found in this workspace.",
              }),
          ),
          Effect.catchTag(
            "DurableAction.CorruptHistoryError",
            (error) =>
              new InvalidRequestError({
                kind: "durable-action-history-corrupt",
                field: "actionID",
                message: `Durable action history failed integrity validation: ${error.reason}`,
              }),
          ),
        )
        if (!("sessionID" in snapshot.action))
          return yield* new InvalidRequestError({
            kind: "control-plane-action-not-supported",
            field: "actionID",
            message: "Recovery inspection is available only for session actions.",
          })

        const location = yield* Location.Service
        const files = yield* FileMutation.Service
        const artifacts = yield* RollbackArtifact.Service
        const access = runtimeInsightAccess((yield* IdentityContext.Current).role)
        return (yield* buildRecoveryView(snapshot, location.directory, files, artifacts.store, access)).record
      }),
    )
    .handle(
      "runtimeInsight.actionRecoveryReview",
      Effect.fn(function* (ctx) {
        const actions = yield* DurableAction.Service
        const actionID = AgentRuntime.ActionID.make(ctx.params.actionID)
        const snapshot = yield* actions.load(actionID).pipe(
          Effect.catchTag(
            "DurableAction.NotFoundError",
            () =>
              new InvalidRequestError({
                kind: "durable-action-not-found",
                field: "actionID",
                message: "The requested durable action was not found in this workspace.",
              }),
          ),
          Effect.catchTag(
            "DurableAction.CorruptHistoryError",
            (error) =>
              new InvalidRequestError({
                kind: "durable-action-history-corrupt",
                field: "actionID",
                message: `Durable action history failed integrity validation: ${error.reason}`,
              }),
          ),
        )
        if (!("sessionID" in snapshot.action))
          return yield* new InvalidRequestError({
            kind: "control-plane-action-not-supported",
            field: "actionID",
            message: "Mutation review is available only for session actions.",
          })

        const location = yield* Location.Service
        const files = yield* FileMutation.Service
        const artifacts = yield* RollbackArtifact.Service
        const access = runtimeInsightAccess((yield* IdentityContext.Current).role)
        const before = yield* buildRecoveryView(snapshot, location.directory, files, artifacts.store, access)
        if (before.mutation === undefined)
          return yield* new InvalidRequestError({
            kind: "mutation-review-not-found",
            field: "transactionID",
            message: "The durable action has no mutation intent to review.",
          })
        if (before.inspection === null || before.inspectionError !== null)
          return yield* new InvalidRequestError({
            kind: "mutation-review-inspection-unavailable",
            field: "inspectedDecision",
            message: "A fresh target fingerprint is required before recording a mutation review.",
          })
        if (before.inspection.decision !== ctx.payload.inspectedDecision)
          return yield* new InvalidRequestError({
            kind: "mutation-review-inspection-mismatch",
            field: "inspectedDecision",
            message: "The submitted review does not match the current target fingerprint inspection.",
          })
        if (before.inspection.observationDigest !== ctx.payload.observationDigest)
          return yield* new InvalidRequestError({
            kind: "mutation-review-observation-stale",
            field: "observationDigest",
            message: "The submitted review is based on a stale target fingerprint observation; inspect again.",
          })

        const expectedPhase = yield* Schema.decodeUnknownEffect(AgentRuntime.MutationIntentPhase)(
          ctx.payload.expectedPhase,
        ).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                kind: "mutation-review-invalid-phase",
                field: "expectedPhase",
                message: "The requested mutation review phase is invalid.",
              }),
          ),
        )
        const transactionID = yield* Schema.decodeUnknownEffect(AgentRuntime.MutationTransactionID)(
          ctx.payload.transactionID,
        ).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                kind: "mutation-review-invalid-transaction",
                field: "transactionID",
                message: "The requested mutation review transaction is invalid.",
              }),
          ),
        )
        const gateway = yield* ActionGateway.Service
        if (!gateway.reviewMutationIntent)
          return yield* new InvalidRequestError({
            kind: "mutation-review-unavailable",
            message: "Mutation review is not available in this runtime.",
          })
        const reviewedAt = yield* DateTime.now
        const reviewed = yield* gateway
          .reviewMutationIntent({
            actionID,
            transactionID,
            expectedPhase,
            decision: ctx.payload.decision,
            inspectedDecision: ctx.payload.inspectedDecision,
            observationDigest: ctx.payload.observationDigest,
            reviewedAt,
          })
          .pipe(
            Effect.catchTag(
              "DurableAction.NotFoundError",
              () =>
                new InvalidRequestError({
                  kind: "durable-action-not-found",
                  field: "actionID",
                  message: "The requested durable action was not found in this workspace.",
                }),
            ),
            Effect.catchTag(
              "DurableAction.CorruptHistoryError",
              (error) =>
                new InvalidRequestError({
                  kind: "durable-action-history-corrupt",
                  field: "actionID",
                  message: `Durable action history failed integrity validation: ${error.reason}`,
                }),
            ),
            Effect.catchTag(
              "DurableAction.MutationIntentMismatchError",
              (error) =>
                new InvalidRequestError({
                  kind: "mutation-review-rejected",
                  field: "payload",
                  message: error.reason,
                }),
            ),
          )
        return (yield* buildRecoveryView(reviewed, location.directory, files, artifacts.store, access)).record
      }),
    )
    .handle(
      "runtimeInsight.actionRecoveryRollback",
      Effect.fn(function* (ctx) {
        const actions = yield* DurableAction.Service
        const actionID = AgentRuntime.ActionID.make(ctx.params.actionID)
        const snapshot = yield* actions.load(actionID).pipe(
          Effect.catchTag(
            "DurableAction.NotFoundError",
            () =>
              new InvalidRequestError({
                kind: "durable-action-not-found",
                field: "actionID",
                message: "The requested durable action was not found in this workspace.",
              }),
          ),
          Effect.catchTag(
            "DurableAction.CorruptHistoryError",
            (error) =>
              new InvalidRequestError({
                kind: "durable-action-history-corrupt",
                field: "actionID",
                message: `Durable action history failed integrity validation: ${error.reason}`,
              }),
          ),
        )
        if (!("sessionID" in snapshot.action))
          return yield* new InvalidRequestError({
            kind: "control-plane-action-not-supported",
            field: "actionID",
            message: "Mutation rollback is available only for session actions.",
          })

        yield* assertRecoveryRollbackRole()

        const location = yield* Location.Service
        const files = yield* FileMutation.Service
        const artifacts = yield* RollbackArtifact.Service
        const access = runtimeInsightAccess((yield* IdentityContext.Current).role)
        const before = yield* buildRecoveryView(snapshot, location.directory, files, artifacts.store, access)
        const intent = before.projection.mutationIntent
        if (before.mutation === undefined || intent === undefined)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-not-found",
            field: "transactionID",
            message: "The durable action has no mutation intent to roll back.",
          })
        if (before.mutation.phase !== "rollback_required" || ctx.payload.expectedPhase !== "rollback_required")
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-invalid-phase",
            field: "expectedPhase",
            message: "Only a durable rollback_required mutation can be compensated.",
          })
        if (before.mutation.transactionID !== ctx.payload.transactionID)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-transaction-mismatch",
            field: "transactionID",
            message: "The requested rollback transaction does not match the durable action.",
          })
        if (before.inspection === null || before.inspectionError !== null)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-inspection-unavailable",
            field: "observationDigest",
            message: "A fresh postimage fingerprint is required before approving rollback.",
          })
        if (
          before.artifact.status !== "not_required" &&
          before.artifact.status !== "available" &&
          before.artifact.status !== "quota_pressure"
        )
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-artifact-unavailable",
            field: "approval",
            message: before.artifact.reason,
          })
        if (!before.inspection.rollbackAvailable)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-artifact-unavailable",
            field: "approval",
            message: "This mutation has no complete durable inverse artifact; manual recovery is required.",
          })
        if (before.inspection.decision !== ctx.payload.inspectedDecision)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-inspection-mismatch",
            field: "inspectedDecision",
            message: "Rollback approval requires every target to match its recorded postimage.",
          })
        if (before.inspection.observationDigest !== ctx.payload.observationDigest)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-observation-stale",
            field: "observationDigest",
            message: "The rollback approval is based on a stale fingerprint observation; inspect again.",
          })

        const receipt = yield* files
          .rollbackIntent({
            worktree: location.directory,
            intent,
            observationDigest: ctx.payload.observationDigest,
          })
          .pipe(
            Effect.catch((error: unknown) => {
              const message =
                error instanceof FileMutation.MutationRollbackError
                  ? error.reason
                  : error instanceof FileMutation.StaleContentError
                    ? "A target changed during rollback; no unsafe overwrite was performed. Inspect again."
                    : error instanceof RollbackArtifact.RollbackArtifactError
                      ? "A rollback artifact failed integrity or availability checks; manual recovery is required."
                      : "The rollback filesystem operation failed; inspect the workspace before trying again."
              return Effect.fail(
                new InvalidRequestError({
                  kind: "mutation-rollback-failed",
                  field: "approval",
                  message,
                }),
              )
            }),
          )
        const gateway = yield* ActionGateway.Service
        if (!gateway.reviewMutationIntent)
          return yield* new InvalidRequestError({
            kind: "mutation-rollback-unavailable",
            message: "Mutation rollback is not available in this runtime.",
          })
        const reviewedAt = yield* DateTime.now
        const reviewed = yield* gateway
          .reviewMutationIntent({
            actionID,
            transactionID: intent.transactionID,
            expectedPhase: "rollback_required",
            decision: "confirm_rolled_back",
            inspectedDecision: "preimage_matches",
            observationDigest: receipt.inspection.observationDigest,
            reviewedAt,
          })
          .pipe(
            Effect.catchTag(
              "DurableAction.NotFoundError",
              () =>
                new InvalidRequestError({
                  kind: "durable-action-not-found",
                  field: "actionID",
                  message: "The requested durable action was not found in this workspace.",
                }),
            ),
            Effect.catchTag(
              "DurableAction.CorruptHistoryError",
              (error) =>
                new InvalidRequestError({
                  kind: "durable-action-history-corrupt",
                  field: "actionID",
                  message: `Durable action history failed integrity validation: ${error.reason}`,
                }),
            ),
            Effect.catchTag(
              "DurableAction.MutationIntentMismatchError",
              (error) =>
                new InvalidRequestError({
                  kind: "mutation-rollback-rejected",
                  field: "approval",
                  message: error.reason,
                }),
            ),
          )
        return (yield* buildRecoveryView(reviewed, location.directory, files, artifacts.store, access)).record
      }),
    )
    .handle(
      "runtimeInsight.childSettlementAudit",
      Effect.fn(function* (ctx) {
        const principal = yield* assertSettlementRecoveryRole()
        let parentRunID: AgentRuntime.RunID
        let childRunID: AgentRuntime.RunID
        try {
          parentRunID = parseSettlementRunID(ctx.params.parentRunID, "parentRunID")
          childRunID = parseSettlementRunID(ctx.params.childRunID, "childRunID")
        } catch (error) {
          return yield* error instanceof InvalidRequestError
            ? error
            : invalidSettlementRequest("parentRunID", "The settlement run identity is invalid.")
        }
        yield* settlementScope(parentRunID, childRunID)
        const identity = {
          tenantID: principal.tenantID,
          userID: principal.userID,
          actor: `user:${principal.userID}`,
        }
        const report = yield* ChildSettlementAudit.Service.pipe(
          Effect.flatMap((audit) => audit.inspect({ identity, parentRunID, childRunID })),
          Effect.catch((error) =>
            invalidSettlementRequest(
              "childRunID",
              `Settlement audit failed closed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
        return projectChildSettlementAudit(report, runtimeInsightAccess(principal.role))
      }),
    )
    .handle(
      "runtimeInsight.childSettlementRecover",
      Effect.fn(function* (ctx) {
        const principal = yield* assertSettlementRecoveryRole()
        if (ctx.payload.approval !== "recover_settlement")
          return yield* invalidSettlementRequest(
            "approval",
            "Settlement recovery requires the explicit recover_settlement confirmation.",
          )
        let parentRunID: AgentRuntime.RunID
        let childRunID: AgentRuntime.RunID
        try {
          parentRunID = parseSettlementRunID(ctx.params.parentRunID, "parentRunID")
          childRunID = parseSettlementRunID(ctx.params.childRunID, "childRunID")
        } catch (error) {
          return yield* error instanceof InvalidRequestError
            ? error
            : invalidSettlementRequest("parentRunID", "The settlement run identity is invalid.")
        }
        yield* settlementScope(parentRunID, childRunID)
        const identity = {
          tenantID: principal.tenantID,
          userID: principal.userID,
          actor: `user:${principal.userID}`,
        }
        const result = yield* ChildSettlementRecovery.Service.pipe(
          Effect.flatMap((recovery) => recovery.recover({ identity, parentRunID, childRunID })),
          Effect.catch((error) =>
            invalidSettlementRequest(
              "childRunID",
              `Settlement recovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
        const access = runtimeInsightAccess(principal.role)
        return {
          before: projectChildSettlementAudit(result.before, access),
          after: projectChildSettlementAudit(result.after, access),
          attempted: [...result.attempted],
          repaired: [...result.repaired],
          deterministic: true as const,
          providerExecutionAllowed: false as const,
          reason: result.reason,
          access,
        }
      }),
    )
    .handle(
      "runtimeInsight.childSettlementRecoverySweep",
      Effect.fn(function* (ctx) {
        const principal = yield* assertSettlementRecoveryRole()
        if (ctx.payload.approval !== "recover_settlements")
          return yield* invalidSettlementRequest(
            "approval",
            "Settlement recovery sweep requires the explicit recover_settlements confirmation.",
          )
        const identity = {
          tenantID: principal.tenantID,
          userID: principal.userID,
          actor: `user:${principal.userID}`,
        }
        const result = yield* ChildSettlementRecovery.Service.pipe(
          Effect.flatMap((recovery) =>
            recovery.recoverPending({
              identity,
              ...(ctx.payload.status === undefined ? {} : { status: ctx.payload.status }),
              ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
            }),
          ),
          Effect.catch((error) =>
            invalidSettlementRequest(
              "approval",
              `Settlement recovery sweep failed closed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
        return projectChildSettlementRecoverySweep(result, runtimeInsightAccess(principal.role))
      }),
    )
    .handle(
      "runtimeInsight.artifactMaintenance",
      Effect.fn(function* (ctx) {
        yield* assertMaintenanceRole()
        const actions = yield* DurableAction.Service
        const artifacts = yield* RollbackArtifact.Service
        const scans = yield* ArtifactMaintenanceScan.Service
        return yield* artifactMaintenanceReport(actions, artifacts.store, scans, "audit", undefined, {
          ...(ctx.query.scanID === undefined ? {} : { scanID: ctx.query.scanID }),
          ...(ctx.query.cursor === undefined ? {} : { cursor: ctx.query.cursor }),
        })
      }),
    )
    .handle(
      "runtimeInsight.artifactMaintenanceSweep",
      Effect.fn(function* (ctx) {
        yield* assertMaintenanceRole()
        if (
          ctx.payload.maxAgeMs !== undefined &&
          (!Number.isFinite(ctx.payload.maxAgeMs) ||
            ctx.payload.maxAgeMs < 0 ||
            !Number.isSafeInteger(ctx.payload.maxAgeMs))
        )
          return yield* new InvalidRequestError({
            kind: "rollback-artifact-maintenance-invalid-retention",
            field: "maxAgeMs",
            message: "Artifact retention age must be a non-negative safe integer.",
          })
        const actions = yield* DurableAction.Service
        const artifacts = yield* RollbackArtifact.Service
        const scans = yield* ArtifactMaintenanceScan.Service
        return yield* artifactMaintenanceReport(
          actions,
          artifacts.store,
          scans,
          "sweep",
          {
            ...(ctx.payload.maxAgeMs === undefined ? {} : { maxAgeMs: ctx.payload.maxAgeMs }),
            enforceQuota: ctx.payload.enforceQuota === true,
          },
          { scanID: ctx.payload.scanID },
        )
      }),
    )
    .handle(
      "runtimeInsight.auditVerify",
      Effect.fn(function* () {
        return RuntimeInsight.auditVerify()
      }),
    ),
)

export const RuntimeInsightPersistence = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database.Service
    const client = db.db as {
      insert(table: unknown): {
        values(value: Record<string, unknown>): { run(): Effect.Effect<unknown, unknown, never> }
      }
      select(): {
        from(table: unknown): {
          orderBy(column: unknown): {
            limit(count: number): { all(): Effect.Effect<unknown[], unknown, never> }
          }
        }
      }
    }
    // Effect Drizzle query builders return Effects; run them at this boundary
    // so the best-effort persistence actually executes.
    const adapter = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          run: () => Effect.runPromise(client.insert(table).values(value).run()),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          orderBy: (column: unknown) => ({
            limit: (count: number) => ({
              all: () => Effect.runPromise(client.select().from(table).orderBy(column).limit(count).all()),
            }),
          }),
        }),
      }),
    }
    yield* Effect.sync(() => attachRuntimePersistence(adapter))
  }),
)
