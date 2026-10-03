import { Show, createEffect, createMemo, on, For } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { OperationsApi } from "@/utils/server"
import {
  actionNameText,
  actionStatusText,
  canCancelPendingAction,
  auditActionText,
  authorityText,
  costText,
  durationText,
  formatRuntimeTime,
  mcpRecoveryEvidenceSummaryText,
  mcpRecoveryReasonText,
  modelText,
  observationStatusText,
  riskTierText,
  recoveryReviewOptions,
  postProcessingCheckpointText,
  postProcessingRecoveryText,
  type RecoveryReviewDecision,
  runtimeModelText,
  runtimeReasonText,
  runStatus,
  runtimeInsightCopy,
} from "./runtime-insight-presentation"
import { ArtifactEvidenceWorkbench } from "./artifact-evidence-workbench"
import { shortArtifactIdentifier } from "./artifact-evidence"
import { createScopeRequestGuard } from "@/utils/scope-request"

type Snapshot = Awaited<ReturnType<OperationsApi["runtimeInsight"]["snapshot"]>>
type ActionRecovery = Awaited<ReturnType<OperationsApi["runtimeInsight"]["actionRecovery"]>>
type SettlementRecoverySweep = Awaited<ReturnType<OperationsApi["runtimeInsight"]["childSettlementRecoverySweep"]>>
type McpReconciliation = Awaited<ReturnType<OperationsApi["mcp"]["actionReconciliation"]>>["data"]
type McpReconciliationHandle = NonNullable<Snapshot["durableActions"][number]["mcpReconciliation"]>

function mcpPublicError(error: unknown, permissionDenied: string, unavailable: string) {
  const message = String(error instanceof Error ? error.message : error)
  return /403|forbidden|owner\/admin|只能.*查看|权限/i.test(message) ? permissionDenied : unavailable
}

function reviewOptionsFor(detail: ActionRecovery, locale: Parameters<typeof recoveryReviewOptions>[2]) {
  if (!detail.mutationRecovery || !detail.inspection) return []
  return recoveryReviewOptions(detail.mutationRecovery.phase, detail.inspection.decision, locale)
}

function postProcessingFor(detail: ActionRecovery) {
  return detail.mutationRecovery?.postProcessing ?? []
}

function guardedRollbackAvailable(detail: ActionRecovery) {
  return (
    detail.access?.canRollbackMutation === true &&
    detail.mutationRecovery?.phase === "rollback_required" &&
    detail.inspection?.decision === "postimage_matches" &&
    detail.inspection.rollbackAvailable &&
    (detail.artifact?.status === "not_required" ||
      detail.artifact?.status === "available" ||
      detail.artifact?.status === "quota_pressure")
  )
}

function badge(kind: string, tone: "green" | "blue" | "gray" = "green") {
  const background =
    tone === "green" ? "rgba(34,197,94,0.14)" : tone === "blue" ? "rgba(99,102,241,0.14)" : "rgba(139,139,139,0.14)"
  const color = tone === "green" ? "#22c55e" : tone === "blue" ? "#818cf8" : "#8b8b8b"
  return (
    <span
      style={`display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:${background};color:${color};font-weight:600;margin-left:8px`}
    >
      {kind}
    </span>
  )
}

function barWidth(tokens: number, total: number): string {
  if (total <= 0) return "0%"
  return `${Math.max(2, Math.round((tokens / total) * 100))}%`
}

function card(style: string) {
  return (
    "padding:12px 14px;border-radius:10px;background:var(--arforge-material-main);" +
    "box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);" +
    style
  )
}

function title(text: string) {
  return <h4 style="margin:0 0 2px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px">{text}</h4>
}

function hint(text: string) {
  return <p style="margin:0 0 10px;font-size:12px;color:var(--v2-text-text-muted);line-height:1.5">{text}</p>
}

export function RuntimeInsightWorkbench(props: {
  api: () => OperationsApi
  location: () => { location: { directory: string; workspace?: string } }
  sessionID?: string
  ready: () => boolean
}) {
  const language = useLanguage()
  const copy = () => runtimeInsightCopy(language.locale())
  const [state, setState] = createStore({
    loading: false,
    verifying: false,
    artifactLoading: false,
    artifactSweeping: false,
    artifactSweepArmed: false,
    settlementRecoveryLoading: false,
    settlementRecoveryArmed: false,
    inspectionActionID: "",
    cancellingActionID: "",
    reviewActionID: "",
    rollbackActionID: "",
    mcpInspectionActionID: "",
    mcpRecordingActionID: "",
    error: "",
    data: undefined as Snapshot | undefined,
    verifyResult: undefined as Awaited<ReturnType<OperationsApi["runtimeInsight"]["auditVerify"]>> | undefined,
    artifactMaintenance: undefined as
      | Awaited<ReturnType<OperationsApi["runtimeInsight"]["artifactMaintenance"]>>
      | undefined,
    settlementRecovery: undefined as SettlementRecoverySweep | undefined,
    recoveries: {} as Record<string, ActionRecovery | undefined>,
    mcpReconciliations: {} as Record<string, McpReconciliation | undefined>,
  })
  const locationScopeKey = () => {
    const value = props.location().location
    return `${value.directory}\u0000${value.workspace ?? ""}`
  }
  const scopeGuard = createScopeRequestGuard(locationScopeKey)
  let refreshQueued = false
  const refresh = async () => {
    if (!props.ready()) return
    scopeGuard.current()
    if (state.loading) {
      refreshQueued = true
      return
    }
    const requestedScope = locationScopeKey()
    const requestedLocation = props.location()
    const request = scopeGuard.capture()
    refreshQueued = false
    setState("loading", true)
    try {
      const data = await props.api().runtimeInsight.snapshot({ ...requestedLocation, limit: "100" })
      if (scopeGuard.isCurrent(request) && locationScopeKey() === requestedScope) setState({ data, error: "" })
      else refreshQueued = true
    } catch (error) {
      if (scopeGuard.isCurrent(request) && locationScopeKey() === requestedScope)
        setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      setState("loading", false)
      if (refreshQueued && props.ready()) {
        refreshQueued = false
        void refresh()
      }
    }
  }
  const verify = async () => {
    if (!props.ready() || state.verifying) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState("verifying", true)
    try {
      const result = await props.api().runtimeInsight.auditVerify(requestedLocation)
      if (scopeGuard.isCurrent(request)) setState("verifyResult", result)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("verifying", false)
    }
  }
  const auditArtifacts = async (scanID?: string, cursor?: string) => {
    if (!props.ready() || state.artifactLoading) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ artifactLoading: true, error: "", artifactSweepArmed: false })
    try {
      const result = await props.api().runtimeInsight.artifactMaintenance({
        ...requestedLocation,
        ...(scanID === undefined ? {} : { scanID }),
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (scopeGuard.isCurrent(request)) setState("artifactMaintenance", result)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("artifactLoading", false)
    }
  }
  const sweepArtifacts = async () => {
    if (!props.ready() || state.artifactSweeping || !state.artifactSweepArmed) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    const scanID = state.artifactMaintenance?.scanID ?? ""
    setState({ artifactSweeping: true, error: "" })
    try {
      const result = await props.api().runtimeInsight.artifactMaintenanceSweep({
        ...requestedLocation,
        scanID,
        approval: "execute_sweep",
        enforceQuota: true,
      })
      if (scopeGuard.isCurrent(request)) {
        setState("artifactMaintenance", result)
        setState("artifactSweepArmed", false)
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("artifactSweeping", false)
    }
  }
  const recoverSettlements = async () => {
    if (
      !props.ready() ||
      state.settlementRecoveryLoading ||
      !state.settlementRecoveryArmed ||
      state.data?.access.role === "member"
    )
      return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ settlementRecoveryLoading: true, error: "" })
    try {
      const result = await props.api().runtimeInsight.childSettlementRecoverySweep({
        ...requestedLocation,
        approval: "recover_settlements",
        limit: 100,
      })
      if (scopeGuard.isCurrent(request)) {
        setState({ settlementRecovery: result, settlementRecoveryArmed: false })
        await refresh()
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("settlementRecoveryLoading", false)
    }
  }
  const inspectAction = async (actionID: string) => {
    if (!props.ready() || state.inspectionActionID === actionID) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ inspectionActionID: actionID, error: "" })
    try {
      const value = await props.api().runtimeInsight.actionRecovery({ actionID, ...requestedLocation })
      if (scopeGuard.isCurrent(request)) setState("recoveries", actionID, value)
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("inspectionActionID", "")
    }
  }
  const cancelPendingAction = async (action: Snapshot["durableActions"][number]) => {
    if (
      !props.ready() ||
      state.cancellingActionID === action.actionID ||
      !canCancelPendingAction(action.sessionID, action.status, props.sessionID)
    )
      return
    const request = scopeGuard.capture()
    setState({ cancellingActionID: action.actionID, error: "" })
    try {
      // The server routes this through SessionExecution, which first asks the
      // same ActionGateway to cancel the originating session's pending
      // actions. A stale snapshot therefore remains fail-closed and is
      // reflected by the subsequent durable refresh.
      await props.api().sessions.interrupt({ sessionID: action.sessionID })
      if (scopeGuard.isCurrent(request)) await refresh()
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("cancellingActionID", "")
    }
  }
  const reviewAction = async (actionID: string, detail: ActionRecovery, decision: RecoveryReviewDecision) => {
    const mutation = detail.mutationRecovery
    const inspection = detail.inspection
    if (!props.ready() || state.reviewActionID === actionID || !mutation || !inspection) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ reviewActionID: actionID, error: "" })
    try {
      const value = await props.api().runtimeInsight.actionRecoveryReview({
        actionID,
        ...requestedLocation,
        transactionID: mutation.transactionID,
        expectedPhase: mutation.phase,
        observationDigest: inspection.observationDigest,
        decision,
        inspectedDecision: inspection.decision as "postimage_matches" | "preimage_matches" | "manual_review",
      })
      if (scopeGuard.isCurrent(request)) {
        setState("recoveries", actionID, value)
        await refresh()
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("reviewActionID", "")
    }
  }
  const rollbackAction = async (actionID: string, detail: ActionRecovery) => {
    const mutation = detail.mutationRecovery
    const inspection = detail.inspection
    if (
      !props.ready() ||
      state.rollbackActionID === actionID ||
      !mutation ||
      !inspection ||
      !guardedRollbackAvailable(detail)
    )
      return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ rollbackActionID: actionID, error: "" })
    try {
      const value = await props.api().runtimeInsight.actionRecoveryRollback({
        actionID,
        ...requestedLocation,
        transactionID: mutation.transactionID,
        expectedPhase: "rollback_required",
        observationDigest: inspection.observationDigest,
        inspectedDecision: "postimage_matches",
        approval: "execute_rollback",
      })
      if (scopeGuard.isCurrent(request)) {
        setState("recoveries", actionID, value)
        await refresh()
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request)) setState("error", String(error instanceof Error ? error.message : error))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("rollbackActionID", "")
    }
  }
  const inspectMcpAction = async (actionID: string, handle: McpReconciliationHandle) => {
    if (!props.ready() || state.mcpInspectionActionID === actionID) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    setState({ mcpInspectionActionID: actionID, error: "" })
    try {
      const value = await props.api().mcp.actionReconciliation({
        actionID,
        intentDigest: handle.intentDigest,
        idempotencyKey: handle.idempotencyKey,
        ...requestedLocation,
      })
      if (scopeGuard.isCurrent(request)) setState("mcpReconciliations", actionID, value.data)
    } catch (error) {
      if (scopeGuard.isCurrent(request))
        setState("error", mcpPublicError(error, copy().mcpRecoveryPermissionDenied, copy().mcpRecoveryUnavailable))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("mcpInspectionActionID", "")
    }
  }
  const recordMcpAction = async (actionID: string, handle: McpReconciliationHandle, detail: McpReconciliation) => {
    if (!props.ready() || state.mcpRecordingActionID === actionID) return
    const request = scopeGuard.capture()
    const requestedLocation = props.location()
    const expectedEvidenceDigest = detail.evidence.evidenceDigest
    setState({ mcpRecordingActionID: actionID, error: "" })
    try {
      const value = await props.api().mcp.recordReconciliation({
        actionID,
        intentDigest: handle.intentDigest,
        idempotencyKey: handle.idempotencyKey,
        expectedEvidenceDigest,
        approval: "record_evidence",
        ...requestedLocation,
      })
      if (scopeGuard.isCurrent(request)) {
        setState("mcpReconciliations", actionID, value.data)
        await refresh()
      }
    } catch (error) {
      if (scopeGuard.isCurrent(request))
        setState("error", mcpPublicError(error, copy().mcpRecoveryPermissionDenied, copy().mcpRecoveryUnavailable))
    } finally {
      if (scopeGuard.isCurrent(request)) setState("mcpRecordingActionID", "")
    }
  }
  let previousScopeKey: string | undefined
  createEffect(
    on(
      () => `${props.ready() ? "ready" : "not-ready"}\u0000${locationScopeKey()}`,
      (scopeKey) => {
        scopeGuard.current()
        const scopeChanged = previousScopeKey !== undefined && previousScopeKey !== scopeKey
        previousScopeKey = scopeKey
        if (!props.ready()) return
        if (scopeChanged)
          setState({
            data: undefined,
            error: "",
            verifying: false,
            artifactLoading: false,
            artifactSweeping: false,
            inspectionActionID: "",
            settlementRecoveryLoading: false,
            settlementRecoveryArmed: false,
            cancellingActionID: "",
            reviewActionID: "",
            rollbackActionID: "",
            mcpInspectionActionID: "",
            mcpRecordingActionID: "",
            verifyResult: undefined,
            artifactMaintenance: undefined,
            settlementRecovery: undefined,
            artifactSweepArmed: false,
            recoveries: {},
            mcpReconciliations: {},
          })
        void refresh()
      },
    ),
  )
  const latestContext = createMemo(() => state.data?.contextLayers[0])
  const totalLayers = createMemo(() => latestContext()?.layers.reduce((sum, layer) => sum + layer.tokens, 0) ?? 0)
  const hasRecords = createMemo(() => {
    const data = state.data
    if (!data) return false
    return [
      data.contextLayers,
      data.routing,
      data.verifications,
      data.audit,
      data.runs,
      data.durableRuns,
      data.durableActions,
      data.recalls,
    ].some((items) => items.length > 0)
  })

  return (
    <section
      class="arforge-control-center-body"
      style="display:grid;gap:14px"
      data-testid="runtime-insight-workbench"
      aria-busy={
        state.loading ||
        state.verifying ||
        state.artifactLoading ||
        state.artifactSweeping ||
        state.settlementRecoveryLoading ||
        state.inspectionActionID !== "" ||
        state.cancellingActionID !== "" ||
        state.rollbackActionID !== "" ||
        state.mcpInspectionActionID !== "" ||
        state.mcpRecordingActionID !== ""
      }
    >
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="arforge-btn" disabled={state.loading} onClick={() => void refresh()}>
          {state.loading ? copy().refreshing : copy().refresh}
        </button>
        <button class="arforge-btn" disabled={state.verifying} onClick={() => void verify()}>
          {state.verifying ? copy().verifyingAudit : copy().verifyAudit}
        </button>
        <button
          class="arforge-btn"
          disabled={state.artifactLoading || state.data?.access.canMaintainArtifacts === false}
          onClick={() => void auditArtifacts()}
        >
          {state.artifactLoading ? copy().auditingArtifacts : copy().auditArtifacts}
        </button>
        <Show when={!state.artifactSweepArmed}>
          <button
            class="arforge-btn"
            title={copy().sweepRequiresCompleteScan}
            aria-label={copy().sweepArtifacts}
            disabled={
              state.artifactLoading ||
              state.artifactSweeping ||
              state.artifactMaintenance?.scanComplete !== true ||
              state.data?.access.canMaintainArtifacts === false
            }
            onClick={() => setState("artifactSweepArmed", true)}
          >
            {copy().sweepArtifacts}
          </button>
        </Show>
        <Show when={state.artifactSweepArmed}>
          <button class="arforge-btn" disabled={state.artifactSweeping} onClick={() => void sweepArtifacts()}>
            {state.artifactSweeping ? copy().sweepingArtifacts : copy().confirmSweepArtifacts}
          </button>
          <button
            class="arforge-btn"
            disabled={state.artifactSweeping}
            onClick={() => setState("artifactSweepArmed", false)}
          >
            {copy().cancelSweep}
          </button>
        </Show>
        <Show when={state.data?.access.role !== undefined && state.data?.access.role !== "member"}>
          <Show when={!state.settlementRecoveryArmed}>
            <button
              class="arforge-btn"
              title={copy().settlementRecoveryHint}
              aria-label={copy().settlementRecoveryStart}
              disabled={state.settlementRecoveryLoading}
              onClick={() => setState("settlementRecoveryArmed", true)}
            >
              {copy().settlementRecoveryStart}
            </button>
          </Show>
          <Show when={state.settlementRecoveryArmed}>
            <button
              class="arforge-btn"
              disabled={state.settlementRecoveryLoading}
              onClick={() => void recoverSettlements()}
            >
              {state.settlementRecoveryLoading ? copy().settlementRecoveryRunning : copy().settlementRecoveryConfirm}
            </button>
            <button
              class="arforge-btn"
              disabled={state.settlementRecoveryLoading}
              onClick={() => setState("settlementRecoveryArmed", false)}
            >
              {copy().settlementRecoveryCancel}
            </button>
          </Show>
        </Show>
        <span style="font-size:12px;color:var(--v2-text-text-muted)">{copy().automaticNotice}</span>
        <Show when={state.data?.access}>
          {(access) => (
            <span data-testid="runtime-insight-access" style="font-size:12px;color:var(--v2-text-text-muted)">
              {copy().recoveryRoleNotice(access().role, access().canRollbackMutation, access().canMaintainArtifacts)}
            </span>
          )}
        </Show>
      </div>
      <Show when={state.error}>
        <p data-testid="runtime-insight-error" style="color:var(--color-danger,#ef4444);font-size:12px">
          {runtimeReasonText(state.error, language.locale())}
        </p>
      </Show>
      <Show when={state.verifyResult}>
        {(result) => (
          <p
            style={`font-size:12px;padding:8px 12px;border-radius:8px;${result().valid ? "background:rgba(34,197,94,0.10);color:#22c55e" : "background:rgba(239,68,68,0.10);color:#ef4444"}`}
          >
            {result().valid ? copy().auditVerified(result().count) : copy().auditFailed(result().issue ?? "")}
          </p>
        )}
      </Show>
      <Show when={state.artifactMaintenance}>
        {(maintenance) => (
          <article style={card("")} data-testid="rollback-artifact-maintenance">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().artifactMaintenanceTitle)}
              {badge(copy().auto)}
              {badge(copy().human, "blue")}
            </div>
            {hint(copy().artifactMaintenanceHint)}
            <div style="font-size:12px;display:grid;gap:4px">
              <b>
                {copy().artifactSummary(
                  maintenance().referencedCount,
                  maintenance().audit.artifactCount,
                  maintenance().audit.orphanCount,
                )}
              </b>
              <span style="color:var(--v2-text-text-muted)">
                {copy().artifactAuditLine(
                  maintenance().audit.totalBytes,
                  maintenance().audit.corruptCount,
                  maintenance().audit.missingReferenceCount,
                  maintenance().audit.overQuota,
                )}
              </span>
              <span style="color:var(--v2-text-text-muted)">
                {maintenance().scanComplete
                  ? copy().artifactScanProgress(maintenance().pageNumber, maintenance().scannedActions)
                  : `${copy().artifactScanIncomplete} ${copy().artifactScanProgress(maintenance().pageNumber, maintenance().scannedActions)}`}
              </span>
              <Show when={!maintenance().scanComplete}>
                <span style="color:#f59e0b">{copy().sweepRequiresCompleteScan}</span>
              </Show>
              <Show when={maintenance().nextCursor}>
                {(cursor) => (
                  <button
                    class="arforge-btn"
                    style="width:max-content"
                    disabled={state.artifactLoading}
                    onClick={() => void auditArtifacts(maintenance().scanID)}
                  >
                    {state.artifactLoading ? copy().auditingArtifacts : copy().continueArtifactScan}
                  </button>
                )}
              </Show>
              <Show when={maintenance().removed > 0}>
                <span style="color:#22c55e">{copy().artifactRemoved(maintenance().removed)}</span>
              </Show>
            </div>
          </article>
        )}
      </Show>
      <ArtifactEvidenceWorkbench api={props.api} sessionID={props.sessionID} ready={props.ready} />

      <Show when={state.settlementRecovery}>
        {(report) => (
          <article style={card("")} data-testid="settlement-recovery-sweep">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().settlementRecoveryTitle)}
              {badge(copy().auto)}
              {badge(copy().human, "blue")}
            </div>
            {hint(copy().settlementRecoveryHint)}
            <div style="font-size:12px;display:grid;gap:4px">
              <b>
                {copy().settlementRecoverySummary(
                  report().scanned,
                  report().committed,
                  report().pending,
                  report().failed,
                )}
              </b>
              <Show when={report().recoveryRequired > 0}>
                <span style="color:#f59e0b">{copy().settlementRecoveryReview(report().recoveryRequired)}</span>
              </Show>
              <Show when={report().hasMore}>
                <span style="color:#f59e0b">{copy().settlementRecoveryNextPage}</span>
              </Show>
              <For each={report().items}>
                {(item) => (
                  <div
                    data-testid="settlement-recovery-item"
                    style="display:grid;gap:2px;padding:6px 8px;border-radius:7px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline)"
                  >
                    <span>
                      <b>{item.outcome}</b> · {item.sourceStatus} → {item.afterStatus ?? "unknown"} · {item.intentID}
                    </span>
                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                      {item.parentRunID} → {item.childRunID} · {runtimeReasonText(item.reason, language.locale())}
                    </span>
                    <Show when={item.repaired.length > 0}>
                      <span style="font-size:11px;color:#22c55e">{item.repaired.join(", ")}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </Show>

      <Show when={!state.data && !state.error} fallback={null}>
        <p style="font-size:12px;color:var(--v2-text-text-muted)">{copy().noRecordsBefore}</p>
      </Show>
      <Show when={state.data && !hasRecords()}>
        <article style={card("")} data-testid="runtime-insight-empty-state">
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
            {title(copy().emptyTitle)}
            {badge(copy().auto, "gray")}
          </div>
          {hint(copy().emptyHint)}
          <p style="margin:0;font-size:12px;color:var(--v2-text-text-muted)">{copy().dataSource}</p>
        </article>
      </Show>

      {/* 持久任务、恢复点和工作进程租约全部来自追加式后端事件。 */}
      <Show when={state.data?.durableRuns.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")} data-testid="durable-runtime-card">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().durableTitle)}
              {badge(copy().auto)}
            </div>
            {hint(copy().durableHint)}
            <For each={value().durableRuns.slice(0, 12)}>
              {(run) => {
                const status = runStatus(run.status, language.locale())
                const leaseActive = Boolean(run.lease && run.lease.expiresAt > Date.now())
                return (
                  <div
                    data-testid="durable-run-record"
                    style="font-size:12px;padding:8px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:5px;display:grid;gap:4px"
                  >
                    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                      <i
                        style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${status.color}`}
                      />
                      <b>{status.text}</b>
                      <span style="color:var(--v2-text-text-muted)">
                        {authorityText(run.authority, language.locale())} ·{" "}
                        {riskTierText(run.riskTier, language.locale())}
                      </span>
                      <span style="margin-left:auto;color:var(--v2-text-text-muted)">
                        {copy().attempts(run.attemptsUsed, run.maxAttempts)}
                      </span>
                    </div>
                    <div style="color:var(--v2-text-text-muted)">
                      {runtimeReasonText(run.reasonSummary, language.locale())}
                    </div>
                    <div
                      data-testid="durable-run-budget"
                      style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--v2-text-text-muted);font-size:11px"
                    >
                      <span>
                        {copy().duration(
                          durationText(run.durationMsUsed, language.locale()),
                          durationText(run.maxDurationMs, language.locale()),
                        )}
                      </span>
                      <span>{copy().modelCost(costText(run.costMicrosUsed), costText(run.maxCostMicros))}</span>
                      <Show when={run.activeAttempt}>
                        {(attempt) => (
                          <span style="color:#22c55e;font-weight:600">
                            {copy().activeAttempt(
                              attempt().attempt,
                              formatRuntimeTime(attempt().startedAt, language.locale()),
                            )}
                          </span>
                        )}
                      </Show>
                    </div>
                    <Show when={run.lastTransition?.reason}>
                      {(reason) => (
                        <div
                          data-testid="durable-run-transition-reason"
                          style={`padding:6px 8px;border-radius:6px;background:${run.status === "failed" ? "rgba(239,68,68,0.08)" : "var(--arforge-material-main)"};color:${run.status === "failed" ? "#ef4444" : "var(--v2-text-text-muted)"}`}
                        >
                          {copy().latestReason}：{runtimeReasonText(reason(), language.locale())}
                        </div>
                      )}
                    </Show>
                    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px">
                      <Show
                        when={run.lease}
                        fallback={
                          <span>
                            {copy().noWorker}
                            {run.lastLeaseGeneration === null
                              ? ""
                              : ` · ${copy().recentTakeover(run.lastLeaseGeneration)}`}
                          </span>
                        }
                      >
                        {(lease) => (
                          <>
                            <span style={`font-weight:600;color:${leaseActive ? "#22c55e" : "#f59e0b"}`}>
                              {leaseActive ? copy().workerOnline : copy().leaseExpired}
                            </span>
                            <span title={lease().ownerID} style="color:var(--v2-text-text-muted)">
                              {copy().takeoverHeartbeat(
                                lease().generation,
                                formatRuntimeTime(lease().heartbeatAt, language.locale()),
                              )}
                            </span>
                          </>
                        )}
                      </Show>
                      <Show
                        when={run.checkpoint}
                        fallback={<span style="color:var(--v2-text-text-muted)">{copy().noCheckpoint}</span>}
                      >
                        {(checkpoint) => (
                          <span style="color:#818cf8" title={checkpoint().stateDigest}>
                            {copy().checkpointSaved(checkpoint().eventSequence)}
                          </span>
                        )}
                      </Show>
                    </div>
                    <Show when={run.admission}>
                      {(admission) => {
                        const checks = admission().checks
                        const descriptorDigest = admission().descriptorDigest
                        const passed = [
                          checks.statusConsistent,
                          checks.descriptorDigestConsistent,
                          checks.toolProjectionConsistent,
                          checks.payloadFree,
                        ].filter(Boolean).length
                        return (
                          <div
                            data-testid="custom-agent-admission-runtime-card"
                            style="display:grid;gap:4px;padding:7px 9px;border-radius:7px;background:rgba(99,102,241,0.08);font-size:11px"
                          >
                            <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                              <b>{copy().admissionTitle}</b>
                              <span>{admission().role}</span>
                              <span>{copy().admissionStatus(admission().status)}</span>
                              <span>{copy().admissionDecision(admission().decision)}</span>
                            </div>
                            <span style="color:var(--v2-text-text-muted)">
                              {copy().admissionChecks(passed, 4)} ·{" "}
                              {copy().admissionTools(
                                admission().declaredToolCount,
                                admission().canonicalToolCount,
                                admission().unsupportedToolCount,
                              )}
                            </span>
                            <span style="color:var(--v2-text-text-muted)">
                              {runtimeReasonText(admission().reason, language.locale())} ·{" "}
                              {copy().admissionEvidenceRefs(admission().evidenceRefs.length)}
                              {descriptorDigest ? ` · digest ${descriptorDigest.slice(0, 12)}…` : ""}
                            </span>
                            <span style="color:var(--v2-text-text-muted)">{copy().admissionHint}</span>
                          </div>
                        )
                      }}
                    </Show>
                  </div>
                )
              }}
            </For>
          </article>
        )}
      </Show>

      <Show when={state.data?.durableActions.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")} data-testid="durable-actions-card">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().actionsTitle)}
              {badge(copy().auto)}
              {badge(copy().human, "blue")}
            </div>
            {hint(copy().actionsHint)}
            <For each={value().durableActions.slice(0, 16)}>
              {(action) => (
                <div
                  data-testid="durable-action-record"
                  data-action-id={action.actionID}
                  style="font-size:12px;padding:7px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:5px;display:grid;gap:3px"
                >
                  <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
                    <b title={action.name}>{actionNameText(action.name, language.locale())}</b>
                    <span style="color:var(--v2-text-text-muted)">
                      {authorityText(action.authority, language.locale())} ·{" "}
                      {riskTierText(action.riskTier, language.locale())}
                    </span>
                    <span style="margin-left:auto">{actionStatusText(action.status, language.locale())}</span>
                  </div>
                  <div style="color:var(--v2-text-text-muted)">
                    {runtimeReasonText(action.reasonSummary, language.locale())} · {copy().impact}{" "}
                    {action.resourceCount} {copy().items} · {copy().resultLabel}{" "}
                    {observationStatusText(action.observationStatus, language.locale())}
                    {action.resultReplayable
                      ? ` · ${copy().persistedResult(action.outputByteLength ?? 0)}`
                      : ` · ${copy().notPersistedResult}`}
                  </div>
                  <Show when={action.progress}>
                    {(progress) => (
                      <div
                        data-testid="durable-action-progress"
                        data-action-id={action.actionID}
                        aria-live="polite"
                        style="padding:6px 8px;border-radius:6px;background:rgba(99,102,241,0.08);display:grid;gap:3px"
                      >
                        <b>{action.name === "asset-localization" ? copy().assetProgressTitle : copy().progressTitle}</b>
                        <span>
                          {copy().progressPhase(progress().phase)} ·{" "}
                          {copy().progressCount(progress().completed, progress().total)}
                        </span>
                        <Show when={progress().detail}>
                          {(detail) => (
                            <span style="font-size:11px;color:var(--v2-text-text-muted)">
                              {copy().progressDetail(runtimeReasonText(detail(), language.locale()))}
                            </span>
                          )}
                        </Show>
                        <span style="font-size:11px;color:var(--v2-text-text-muted)">{copy().progressReadOnly}</span>
                      </div>
                    )}
                  </Show>
                  <Show when={canCancelPendingAction(action.sessionID, action.status, props.sessionID)}>
                    <div
                      data-testid="durable-action-cancel"
                      data-action-id={action.actionID}
                      style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0"
                    >
                      <button
                        class="arforge-btn"
                        data-testid="durable-action-cancel-button"
                        data-action-id={action.actionID}
                        aria-label={copy().cancelPendingAction}
                        disabled={state.cancellingActionID === action.actionID}
                        onClick={() => void cancelPendingAction(action)}
                      >
                        {state.cancellingActionID === action.actionID
                          ? copy().cancellingPendingAction
                          : copy().cancelPendingAction}
                      </button>
                      <span style="font-size:11px;color:var(--v2-text-text-muted)">
                        {copy().cancelPendingActionHint}
                      </span>
                    </div>
                  </Show>
                  <Show when={action.mutationRecovery}>
                    {(recovery) => (
                      <div
                        data-testid="durable-action-mutation-recovery"
                        data-action-id={action.actionID}
                        style={`padding:6px 8px;border-radius:6px;background:${recovery().requiresReview ? "rgba(245,158,11,0.10)" : "rgba(34,197,94,0.08)"};color:${recovery().requiresReview ? "#f59e0b" : "#22c55e"};display:grid;gap:3px`}
                      >
                        <b>
                          {copy().mutationRecoveryStatus(
                            recovery().phase,
                            recovery().decision,
                            recovery().requiresReview,
                            recovery().transactionID,
                          )}
                        </b>
                        <span>{recovery().requiresReview ? copy().automaticRetryBlocked : copy().noRetryNeeded}</span>
                        <span>
                          {copy().mutationRecoveryReason(runtimeReasonText(recovery().reason, language.locale()))}
                        </span>
                        <Show when={recovery().postProcessing?.length ? recovery().postProcessing : undefined}>
                          {(checkpoints) => (
                            <div
                              data-testid="durable-action-post-processing-checkpoints"
                              style="display:grid;gap:2px;margin-top:2px;padding-top:3px;border-top:1px solid var(--arforge-hairline)"
                            >
                              <span>{copy().postProcessingTitle}</span>
                              <For each={checkpoints()}>
                                {(checkpoint) => (
                                  <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                    #{checkpoint.sequence + 1} ·{" "}
                                    {postProcessingCheckpointText(
                                      checkpoint.stage,
                                      checkpoint.status,
                                      checkpoint.target,
                                      language.locale(),
                                    )}
                                  </span>
                                )}
                              </For>
                            </div>
                          )}
                        </Show>
                        <Show when={recovery().postProcessingRecovery}>
                          {(classification) => (
                            <div
                              data-testid="durable-action-post-processing-recovery"
                              style="display:grid;gap:2px;margin-top:2px;padding-top:3px;border-top:1px solid var(--arforge-hairline)"
                            >
                              <span>{copy().postProcessingRecoveryTitle}</span>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {postProcessingRecoveryText(
                                  classification().status,
                                  classification().stage,
                                  classification().target,
                                  language.locale(),
                                )}
                              </span>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {copy().mutationRecoveryReason(
                                  runtimeReasonText(classification().reason, language.locale()),
                                )}
                              </span>
                            </div>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={action.mcpReconciliation}>
                    {(handle) => {
                      const result = () => state.mcpReconciliations[action.actionID]
                      return (
                        <div
                          data-testid="mcp-action-reconciliation"
                          data-action-id={action.actionID}
                          style="padding:7px 9px;border-radius:6px;background:rgba(99,102,241,0.08);display:grid;gap:4px"
                        >
                          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                            <b>{copy().mcpRecoveryTitle}</b>
                            {badge(copy().human, "blue")}
                            <span style="font-size:11px;color:var(--v2-text-text-muted)">
                              {copy().mcpRecoveryState(handle().state)}
                            </span>
                          </div>
                          <span style="font-size:11px;color:var(--v2-text-text-muted)">{copy().mcpRecoveryHint}</span>
                          <span style="font-size:11px;color:var(--v2-text-text-muted)" title={handle().intentDigest}>
                            {copy().mcpRecoveryIdentity(shortArtifactIdentifier(handle().intentDigest))}
                          </span>
                          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                            <button
                              class="arforge-btn"
                              data-testid="mcp-action-reconciliation-inspect"
                              data-action-id={action.actionID}
                              disabled={state.mcpInspectionActionID === action.actionID}
                              onClick={() => void inspectMcpAction(action.actionID, handle())}
                            >
                              {state.mcpInspectionActionID === action.actionID
                                ? copy().mcpRecoveryInspecting
                                : copy().mcpRecoveryInspect}
                            </button>
                            <span style="font-size:11px;color:var(--v2-text-text-muted)">
                              {copy().mcpRecoveryOperatorNotice}
                            </span>
                          </div>
                          <Show when={result()}>
                            {(detail) => (
                              <div
                                data-testid="mcp-action-reconciliation-result"
                                data-action-id={action.actionID}
                                style="display:grid;gap:3px;padding:6px 8px;border-top:1px solid var(--arforge-hairline)"
                              >
                                <b>{copy().mcpRecoveryDecision(detail().kind)}</b>
                                <span>{copy().mcpRecoveryState(detail().state)}</span>
                                <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                  {mcpRecoveryReasonText(detail().reason, language.locale())}
                                </span>
                                <span
                                  style="font-size:11px;color:var(--v2-text-text-muted)"
                                  title={detail().evidence.evidenceDigest}
                                >
                                  {copy().mcpRecoveryEvidence(
                                    shortArtifactIdentifier(detail().evidence.evidenceDigest),
                                    detail().evidence.source,
                                  )}
                                </span>
                                <Show when={detail().evidence.summary}>
                                  {(summary) => (
                                    <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                      {mcpRecoveryEvidenceSummaryText(summary(), language.locale())}
                                    </span>
                                  )}
                                </Show>
                                <Show when={detail().kind !== "confirmed"}>
                                  <button
                                    class="arforge-btn"
                                    data-testid="mcp-action-reconciliation-record"
                                    data-action-id={action.actionID}
                                    disabled={state.mcpRecordingActionID === action.actionID}
                                    onClick={() => void recordMcpAction(action.actionID, handle(), detail())}
                                  >
                                    {state.mcpRecordingActionID === action.actionID
                                      ? copy().mcpRecoveryRecording
                                      : copy().mcpRecoveryRecord}
                                  </button>
                                </Show>
                              </div>
                            )}
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                  <Show when={action.mutationRecovery?.requiresReview}>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                      <button
                        class="arforge-btn"
                        data-testid="durable-action-inspect-targets"
                        data-action-id={action.actionID}
                        aria-label={`${copy().inspectTargets}: ${action.name}`}
                        disabled={state.inspectionActionID === action.actionID}
                        onClick={() => void inspectAction(action.actionID)}
                      >
                        {state.inspectionActionID === action.actionID
                          ? copy().inspectingTargets
                          : copy().inspectTargets}
                      </button>
                      <span style="font-size:11px;color:var(--v2-text-text-muted)">{copy().human}</span>
                    </div>
                  </Show>
                  <Show when={state.recoveries[action.actionID]}>
                    {(detail) => (
                      <div
                        data-testid="durable-action-inspection"
                        data-action-id={action.actionID}
                        style="padding:7px 9px;border-radius:6px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);display:grid;gap:4px"
                      >
                        <b>{copy().inspectionTitle}</b>
                        <Show when={detail().inspection} fallback={<span>{copy().inspectionUnavailable}</span>}>
                          {(inspection) => (
                            <>
                              <span>{copy().inspectionDecision(inspection().decision)}</span>
                              <For each={inspection().entries}>
                                {(entry) => (
                                  <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                    {copy().inspectionEntry(entry.operation, entry.target, entry.state)}
                                  </span>
                                )}
                              </For>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {copy().inspectionReason(runtimeReasonText(inspection().reason, language.locale()))}
                              </span>
                            </>
                          )}
                        </Show>
                        <Show when={detail().inspectionError}>
                          {(message) => <span style="color:#f59e0b;font-size:11px">{message()}</span>}
                        </Show>
                        <Show when={postProcessingFor(detail()).length > 0 ? postProcessingFor(detail()) : undefined}>
                          {(checkpoints) => (
                            <div
                              data-testid="durable-action-post-processing-detail"
                              style="display:grid;gap:2px;padding:5px 0;border-top:1px solid var(--arforge-hairline)"
                            >
                              <b>{copy().postProcessingTitle}</b>
                              <For each={checkpoints()}>
                                {(checkpoint) => (
                                  <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                    #{checkpoint.sequence + 1} ·{" "}
                                    {postProcessingCheckpointText(
                                      checkpoint.stage,
                                      checkpoint.status,
                                      checkpoint.target,
                                      language.locale(),
                                    )}
                                  </span>
                                )}
                              </For>
                            </div>
                          )}
                        </Show>
                        <Show when={detail().mutationRecovery?.postProcessingRecovery}>
                          {(classification) => (
                            <div
                              data-testid="durable-action-post-processing-recovery-detail"
                              style="display:grid;gap:2px;padding:5px 0;border-top:1px solid var(--arforge-hairline)"
                            >
                              <b>{copy().postProcessingRecoveryTitle}</b>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {postProcessingRecoveryText(
                                  classification().status,
                                  classification().stage,
                                  classification().target,
                                  language.locale(),
                                )}
                              </span>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {copy().mutationRecoveryReason(
                                  runtimeReasonText(classification().reason, language.locale()),
                                )}
                              </span>
                            </div>
                          )}
                        </Show>
                        <Show when={detail().artifact}>
                          {(artifact) => (
                            <div
                              data-testid="durable-action-artifact-health"
                              style={`padding:6px 8px;border-radius:6px;background:${artifact().status === "available" || artifact().status === "not_required" ? "rgba(34,197,94,0.08)" : "rgba(245,158,11,0.10)"};display:grid;gap:3px`}
                            >
                              <b>{copy().artifactStatus(artifact().status)}</b>
                              <span style="font-size:11px;color:var(--v2-text-text-muted)">
                                {runtimeReasonText(artifact().reason, language.locale())}
                              </span>
                            </div>
                          )}
                        </Show>
                        <Show when={detail().access && !detail().access.canRollbackMutation}>
                          <span data-testid="durable-action-recovery-role-notice" style="color:#f59e0b;font-size:11px">
                            {copy().recoveryRollbackPermission}
                          </span>
                        </Show>
                        <Show
                          when={guardedRollbackAvailable(detail())}
                          fallback={
                            <Show
                              when={
                                detail().mutationRecovery?.phase === "rollback_required" &&
                                detail().inspection?.rollbackAvailable === false
                              }
                            >
                              <span style="color:#f59e0b;font-size:11px">{copy().rollbackUnavailable}</span>
                            </Show>
                          }
                        >
                          <div
                            data-testid="durable-action-rollback-controls"
                            data-action-id={action.actionID}
                            style="display:grid;gap:5px;margin-top:3px;padding-top:6px;border-top:1px solid var(--arforge-hairline)"
                          >
                            <b>{copy().rollbackTitle}</b>
                            <span style="font-size:11px;color:var(--v2-text-text-muted)">
                              {copy().rollbackSafetyNotice}
                            </span>
                            <button
                              class="arforge-btn"
                              data-testid="durable-action-rollback"
                              data-action-id={action.actionID}
                              aria-label={`${copy().executeRollback}: ${action.name}`}
                              disabled={state.rollbackActionID === action.actionID}
                              onClick={() => void rollbackAction(action.actionID, detail())}
                            >
                              {state.rollbackActionID === action.actionID
                                ? copy().executingRollback
                                : copy().executeRollback}
                            </button>
                          </div>
                        </Show>
                        <Show when={reviewOptionsFor(detail(), language.locale()).length > 0}>
                          <div
                            data-testid="durable-action-review-controls"
                            data-action-id={action.actionID}
                            style="display:grid;gap:5px;margin-top:3px;padding-top:6px;border-top:1px solid var(--arforge-hairline)"
                          >
                            <b>{copy().reviewTitle}</b>
                            <span style="font-size:11px;color:var(--v2-text-text-muted)">
                              {copy().reviewSafetyNotice}
                            </span>
                            <div style="display:flex;gap:7px;flex-wrap:wrap">
                              <For each={reviewOptionsFor(detail(), language.locale())}>
                                {(option) => (
                                  <button
                                    class="arforge-btn"
                                    data-testid={`durable-action-review-${option.decision}`}
                                    data-action-id={action.actionID}
                                    aria-label={`${option.label}: ${action.name}`}
                                    disabled={state.reviewActionID === action.actionID}
                                    onClick={() => void reviewAction(action.actionID, detail(), option.decision)}
                                  >
                                    {state.reviewActionID === action.actionID ? copy().reviewing : option.label}
                                  </button>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>
                  <div data-testid="durable-action-budget" style="font-size:11px;color:var(--v2-text-text-muted)">
                    {copy().attempts(action.attemptsUsed, action.maxAttempts)} ·{" "}
                    {copy().duration(
                      durationText(action.durationMsUsed, language.locale()),
                      durationText(action.maxDurationMs, language.locale()),
                    )}{" "}
                    ·{" "}
                    {action.maxCostMicros > 0
                      ? copy().modelCost(costText(action.costMicrosUsed), costText(action.maxCostMicros))
                      : copy().localCost}
                  </div>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 上下文分层 */}
      <Show when={latestContext()}>
        {(context) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().contextTitle)}
              {badge(copy().auto)}
            </div>
            {hint(copy().contextHint)}
            <p style="margin:0 0 8px;font-size:12px;color:var(--v2-text-text-muted)">
              {modelText(context().model, language.locale())} · {copy().totalTokens(context().totalTokens)} ·{" "}
              {formatRuntimeTime(context().timestamp, language.locale())}
            </p>
            <For each={context().layers}>
              {(layer) => (
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">
                  <span style="width:26px;font-weight:600">{layer.layer}</span>
                  <span style="width:130px;color:var(--v2-text-text-muted)">{layer.source}</span>
                  <div style="flex:1;height:10px;border-radius:5px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);overflow:hidden">
                    <div
                      style={`height:100%;width:${barWidth(layer.tokens, totalLayers())};background:${layer.kept ? "#6366f1" : "#ef4444"}`}
                    />
                  </div>
                  <span style="width:70px;text-align:right">{layer.tokens} tok</span>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 模型路由 */}
      <Show when={state.data?.routing.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().routingTitle)}
              {badge(copy().auto)}
            </div>
            {hint(copy().routingHint)}
            <For each={value().routing.slice(0, 8)}>
              {(decision) => (
                <div style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px">
                  <div>
                    <b>{runtimeModelText(decision.providerID, decision.modelID, language.locale())}</b>{" "}
                    <span style="color:var(--v2-text-text-muted)">
                      ${copy().inputCost(decision.inputCost)} · ${copy().outputCost(decision.outputCost)}
                    </span>
                  </div>
                  <div style="color:var(--v2-text-text-muted)">
                    {runtimeReasonText(decision.reason, language.locale())} · {copy().task}：
                    {decision.task.slice(0, 60)}
                  </div>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 验证报告 */}
      <Show when={state.data?.verifications.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().verificationTitle)}
              {badge(copy().auto)}
            </div>
            {hint(copy().verificationHint)}
            <For each={value().verifications.slice(0, 8)}>
              {(verification) => (
                <div style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px">
                  <div>
                    <span
                      style={`display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${verification.passed ? "#22c55e" : "#ef4444"}`}
                    />
                    <b>{verification.passed ? copy().passed : copy().failed}</b> · {verification.claim.slice(0, 50)}
                  </div>
                  <div style="color:var(--v2-text-text-muted)">{verification.commands.join("  ·  ")}</div>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>

      {/* 审计 */}
      <Show when={state.data?.audit.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().auditTitle)}
              {badge(copy().auto)}
              {badge(copy().human, "blue")}
            </div>
            {hint(copy().auditHint)}
            <p style="margin:0 0 8px;font-size:12px">
              {copy().chainStatus}：
              <span style={`font-weight:600;${value().auditVerify.valid ? "color:#22c55e" : "color:#ef4444"}`}>
                {value().auditVerify.valid ? copy().validChain(value().auditVerify.count) : copy().invalidChain}
              </span>
            </p>
            <div style="font-size:12px;font-family:monospace;max-height:260px;overflow:auto;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);border-radius:8px;padding:8px;color:var(--v2-text-text-muted)">
              <For each={value().audit.slice(0, 40)}>
                {(entry) => (
                  <div style="display:flex;gap:8px;padding:2px 0">
                    <span style="min-width:44px">#{entry.seq}</span>
                    <span>{auditActionText(entry.action, language.locale())}</span>
                    <span title={entry.resource}>
                      {entry.resource.length > 18 ? `${entry.resource.slice(0, 18)}…` : entry.resource}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </article>
        )}
      </Show>

      {/* 运行状态 */}
      <Show when={state.data?.runs.length ? state.data : undefined}>
        {(value) => (
          <article style={card("")}>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">
              {title(copy().runsTitle)}
              {badge(copy().auto)}
            </div>
            {hint(copy().runsHint)}
            <For each={value().runs.slice(0, 8)}>
              {(run) => (
                <div style="font-size:12px;padding:6px 10px;border-radius:8px;background:var(--arforge-material-main);box-shadow:inset 0 0 0 0.5px var(--arforge-hairline);margin-bottom:4px;display:flex;gap:8px;align-items:center">
                  <span
                    style={`display:inline-block;width:8px;height:8px;border-radius:50%;background:${run.status === "running" ? "#22c55e" : run.status === "completed" ? "#818cf8" : run.status === "failed" || run.status === "interrupted" ? "#ef4444" : "#8b8b8b"}`}
                  />
                  <span>
                    {copy().sessionRunStatus(run.status)} · {run.sessionID.slice(0, 12)} ·{" "}
                    {formatRuntimeTime(run.startedAt, language.locale())}
                  </span>
                  <Show when={run.error}>
                    <span style="color:var(--v2-text-text-muted)">
                      · {runtimeReasonText(run.error, language.locale())}
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </article>
        )}
      </Show>
    </section>
  )
}
