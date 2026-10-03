import "../../../src/index.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LanguageProvider, normalizeLocale } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { RuntimeInsightWorkbench } from "../../../src/components/control-center/runtime-insight-workbench"
import type { OperationsApi } from "../../../src/utils/server"

const directory = "C:/Arforge/RuntimeInsightFixture"
const [fixtureWorkspace, setFixtureWorkspace] = createSignal("workspace-one")
const locationCalls: Array<{ directory: string; workspace: string }> = []
const fixtureLocale = normalizeLocale(new URL(window.location.href).searchParams.get("locale") ?? "en")
const fixtureActions = [
  {
    actionID: "act_runtime_insight_fixture",
    transactionID: "mut_runtime_insight_fixture",
    observationDigest: "a".repeat(64),
    name: "write",
    target: "workspace/fixture.txt",
  },
  {
    actionID: "act_runtime_insight_second",
    transactionID: "mut_runtime_insight_second",
    observationDigest: "b".repeat(64),
    name: "edit",
    target: "workspace/second.txt",
  },
  {
    actionID: "act_runtime_insight_asset",
    transactionID: "mut_runtime_insight_asset",
    observationDigest: "e".repeat(64),
    name: "asset-localization",
    target: "src/index.html",
    phase: "rollback_required" as const,
  },
] as const

const mcpFixtureAction = {
  actionID: "act_mcp_runtime_fixture",
  intentDigest: "c".repeat(64),
  idempotencyKey: "mcp-idem-runtime-fixture",
} as const

const pendingAssetAction = {
  actionID: "act_runtime_insight_pending_asset",
  sessionID: "ses_runtime_insight_fixture",
  name: "asset-localization",
} as const

const foreignPendingAction = {
  actionID: "act_runtime_insight_foreign_pending_asset",
  sessionID: "ses_runtime_insight_other",
  name: "asset-localization",
} as const

type ReviewCall = Parameters<OperationsApi["runtimeInsight"]["actionRecoveryReview"]>[0]
type McpRecordCall = Parameters<OperationsApi["mcp"]["recordReconciliation"]>[0]

const state = {
  reviewed: new Set<string>(),
  inspections: [] as string[],
  reviews: [] as ReviewCall[],
  role: "member" as "member" | "owner" | "admin",
  mcpInspections: [] as string[],
  mcpRecords: [] as McpRecordCall[],
  mcpRecorded: false,
  mcpFailureMode: false,
  pendingCancelled: false,
  interrupts: [] as string[],
  deferRecovery: false,
  recoveryPending: false,
  resolveRecovery: null as (() => void) | null,
  recoveryCalls: [] as string[],
}

function runtimeAccess() {
  return {
    role: state.role,
    canReviewMutation: true,
    canRollbackMutation: state.role !== "member",
    canMaintainArtifacts: state.role !== "member",
    canRecordMcpEvidence: state.role !== "member",
  } as const
}

function actionFor(actionID: string) {
  const action = fixtureActions.find((item) => item.actionID === actionID)
  if (!action) throw new Error(`Unknown fixture action: ${actionID}`)
  return action
}

function snapshot() {
  return {
    access: runtimeAccess(),
    contextLayers: [],
    routing: [],
    verifications: [],
    audit: [],
    auditDropped: 0,
    auditVerify: { valid: true, count: 0, headHash: "", issue: null },
    runs: [],
    durableRuns: [
      {
        runID: "run_runtime_insight_custom_agent",
        sessionID: "ses_runtime_insight_fixture",
        status: "completed",
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "custom-agent child completed after deterministic admission",
        attemptsUsed: 1,
        maxAttempts: 2,
        durationMsUsed: 240,
        maxDurationMs: 10_000,
        costMicrosUsed: 0,
        maxCostMicros: 0,
        activeAttempt: null,
        createdAt: 1,
        updatedAt: 3,
        startedAt: 2,
        finishedAt: 3,
        lastLeaseGeneration: null,
        lastTransition: null,
        lease: null,
        checkpoint: null,
        admission: {
          role: "CustomAgent.runtime-insight",
          status: "admitted",
          decision: "admitted",
          reason: "profile is opted in and tool projection is complete",
          ready: true,
          descriptorDigest: "e".repeat(64),
          checks: {
            statusConsistent: true,
            descriptorDigestConsistent: true,
            toolProjectionConsistent: true,
            payloadFree: true,
          },
          declaredToolCount: 1,
          canonicalToolCount: 1,
          unsupportedToolCount: 0,
          valid: true,
          evidenceRefs: ["evd_runtime_insight_admission"],
        },
      },
    ],
    durableActions: [
      ...fixtureActions.map((action, index) => {
        const reviewed = state.reviewed.has(action.actionID)
        return {
          actionID: action.actionID,
          runID: null,
          sessionID: "ses_runtime_insight_fixture",
          name: action.name,
          status: reviewed ? "settled" : "verifying",
          authority: "scoped_grant",
          riskTier: "L2",
          reasonSummary: "A durable file mutation was interrupted during post-processing.",
          resourceCount: 1,
          observationStatus: "interrupted",
          resultReplayable: false,
          outputDigest: null,
          outputByteLength: null,
          attemptsUsed: 1,
          maxAttempts: 3,
          durationMsUsed: 120 + index,
          maxDurationMs: 10_000,
          costMicrosUsed: 0,
          maxCostMicros: 0,
          mutationRecovery: {
            transactionID: action.transactionID,
            phase: reviewed ? "settled" : (action.phase ?? "postprocessing"),
            decision: reviewed ? "settled" : action.phase === "rollback_required" ? "manual_rollback" : "inspect",
            automaticRetryAllowed: false as const,
            requiresReview: !reviewed,
            reason: reviewed
              ? "Human review recorded for the observed postimage."
              : "Action log still needs settlement.",
          },
          progress:
            action.name === "asset-localization"
              ? {
                  phase: reviewed ? ("settled" as const) : ("committed" as const),
                  completed: 2,
                  total: 2,
                  sequence: reviewed ? 4 : 3,
                  updatedAt: reviewed ? 3 : 2,
                  detail: reviewed ? "Localization result settled" : "Localized files committed",
                }
              : null,
          createdAt: 1,
          updatedAt: 2,
        }
      }),
      {
        actionID: pendingAssetAction.actionID,
        runID: null,
        sessionID: pendingAssetAction.sessionID,
        name: pendingAssetAction.name,
        status: state.pendingCancelled ? "cancelled" : "awaiting_approval",
        authority: "scoped_grant",
        riskTier: "L2",
        reasonSummary: "The originating session has a precise asset localization request awaiting approval.",
        resourceCount: 2,
        observationStatus: state.pendingCancelled ? "interrupted" : null,
        resultReplayable: false,
        outputDigest: null,
        outputByteLength: null,
        attemptsUsed: 0,
        maxAttempts: 1,
        durationMsUsed: 0,
        maxDurationMs: 10_000,
        costMicrosUsed: 0,
        maxCostMicros: 0,
        mutationRecovery: null,
        progress: {
          phase: state.pendingCancelled ? ("cancelled" as const) : ("fetching" as const),
          completed: state.pendingCancelled ? 0 : 0,
          total: 2,
          sequence: state.pendingCancelled ? 2 : 1,
          updatedAt: state.pendingCancelled ? 3 : 2,
          detail: state.pendingCancelled ? "Cancellation recorded before execution" : "Waiting for approval",
        },
        createdAt: 1,
        updatedAt: state.pendingCancelled ? 3 : 2,
      },
      {
        actionID: foreignPendingAction.actionID,
        runID: null,
        sessionID: foreignPendingAction.sessionID,
        name: foreignPendingAction.name,
        status: "awaiting_approval",
        authority: "scoped_grant",
        riskTier: "L2",
        reasonSummary: "A different originating session has an asset localization request awaiting approval.",
        resourceCount: 2,
        observationStatus: null,
        resultReplayable: false,
        outputDigest: null,
        outputByteLength: null,
        attemptsUsed: 0,
        maxAttempts: 1,
        durationMsUsed: 0,
        maxDurationMs: 10_000,
        costMicrosUsed: 0,
        maxCostMicros: 0,
        mutationRecovery: null,
        progress: {
          phase: "fetching" as const,
          completed: 0,
          total: 2,
          sequence: 1,
          updatedAt: 2,
          detail: "Waiting for approval in another session",
        },
        createdAt: 1,
        updatedAt: 2,
      },
      {
        actionID: mcpFixtureAction.actionID,
        runID: null,
        sessionID: "ses_runtime_insight_fixture",
        name: "mcp_remote_task",
        status: state.mcpRecorded ? "settled" : "verifying",
        authority: "scoped_grant",
        riskTier: "L2",
        reasonSummary: "An external MCP action was interrupted before its remote outcome was confirmed.",
        resourceCount: 1,
        observationStatus: "interrupted",
        resultReplayable: false,
        outputDigest: null,
        outputByteLength: null,
        attemptsUsed: 1,
        maxAttempts: 1,
        durationMsUsed: 220,
        maxDurationMs: 10_000,
        costMicrosUsed: 0,
        maxCostMicros: 0,
        mutationRecovery: null,
        mcpReconciliation: {
          actionKind: "mcp" as const,
          actionVersion: "1" as const,
          intentDigest: mcpFixtureAction.intentDigest,
          idempotencyKey: mcpFixtureAction.idempotencyKey,
          state: state.mcpRecorded ? ("known_success" as const) : null,
          evidenceDigest: state.mcpRecorded ? "d".repeat(64) : null,
          source: state.mcpRecorded ? "mcp-fixture" : null,
          observedAt: state.mcpRecorded ? 3 : null,
          summary: state.mcpRecorded ? "Owner recorded the operator-confirmed remote outcome." : null,
          operatorRequired: true as const,
        },
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    recalls: [],
  }
}

function recovery(action: (typeof fixtureActions)[number], countInspection = true) {
  const reviewed = state.reviewed.has(action.actionID)
  if (countInspection) state.inspections.push(action.actionID)
  return {
    access: runtimeAccess(),
    actionID: action.actionID,
    actionStatus: reviewed ? "settled" : "verifying",
    state: reviewed ? "settled" : "recovery_required",
    outcome: null,
    repair: { required: !reviewed, source: "durable_mutation", reason: null },
    mutationRecovery: {
      transactionID: action.transactionID,
      phase: reviewed ? "settled" : (action.phase ?? "postprocessing"),
      decision: reviewed ? "settled" : action.phase === "rollback_required" ? "manual_rollback" : "inspect",
      automaticRetryAllowed: false as const,
      requiresReview: !reviewed,
      reason: reviewed ? "Human review recorded for the observed postimage." : "Action log still needs settlement.",
    },
    inspection: reviewed
      ? null
      : {
          transactionID: action.transactionID,
          phase: action.phase ?? "postprocessing",
          observationDigest: action.observationDigest,
          decision: "postimage_matches",
          automaticRetryAllowed: false as const,
          rollbackAvailable: action.phase === "rollback_required",
          entries: [{ target: action.target, operation: action.name, state: "postimage_matches" }],
          reason: "All cooperative fingerprints match the durable postimage.",
        },
    inspectionError: null,
    artifact:
      action.phase === "rollback_required"
        ? {
            status: "available" as const,
            referencedCount: 1,
            missingReferenceCount: 0,
            corruptCount: 0,
            overQuota: false,
            reason: "The profile-owned inverse artifact is available.",
          }
        : null,
  }
}

const api = {
  runtimeInsight: {
    snapshot: async (input?: { location?: { directory: string; workspace?: string } }) => {
      if (input?.location)
        locationCalls.push({ directory: input.location.directory, workspace: input.location.workspace ?? "" })
      return snapshot()
    },
    auditVerify: async () => ({ valid: true, count: 0, headHash: "", issue: null }),
    actionRecovery: async ({ actionID }) => {
      state.recoveryCalls.push(actionID)
      if (state.deferRecovery) {
        state.recoveryPending = true
        await new Promise<void>((resolve) => {
          state.resolveRecovery = resolve
        })
        state.recoveryPending = false
        state.resolveRecovery = null
      }
      return recovery(actionFor(actionID))
    },
    actionRecoveryReview: async (input: ReviewCall) => {
      state.reviews.push(input)
      const action = actionFor(input.actionID)
      state.reviewed.add(action.actionID)
      return recovery(action, false)
    },
  },
  sessions: {
    interrupt: async ({ sessionID }: { sessionID: string }) => {
      if (sessionID !== pendingAssetAction.sessionID) throw new Error(`Unknown session: ${sessionID}`)
      state.interrupts.push(sessionID)
      state.pendingCancelled = true
    },
  },
  artifacts: {
    catalog: async () => ({ entries: [], nextSequence: null, headSequence: 0, headHash: "", droppedAuditEntries: 0 }),
    audit: async () => [],
  },
  mcp: {
    actionReconciliation: async ({ actionID }: { actionID: string }) => {
      if (actionID !== mcpFixtureAction.actionID) throw new Error(`Unknown MCP fixture action: ${actionID}`)
      state.mcpInspections.push(actionID)
      if (state.mcpFailureMode) throw new Error("provider transport failed: secret=fixture-only")
      return {
        location: { directory, project: { id: "fixture", directory } },
        data: {
          actionID,
          kind: state.mcpRecorded ? ("confirmed" as const) : ("manual_review" as const),
          state: state.mcpRecorded ? ("known_success" as const) : ("unknown" as const),
          automaticRetryAllowed: false as const,
          reason: state.mcpRecorded
            ? "The owner recorded the observed remote outcome; no replay was performed."
            : "The remote outcome remains unknown; inspect the provider before recording evidence.",
          evidence: {
            state: state.mcpRecorded ? ("known_success" as const) : ("unknown" as const),
            evidenceDigest: "d".repeat(64),
            source: "mcp-fixture",
            observedAt: 3,
            summary: state.mcpRecorded
              ? "Owner recorded the operator-confirmed remote outcome."
              : "No transport replay was attempted.",
          },
        },
      }
    },
    recordReconciliation: async (input: McpRecordCall) => {
      if (state.role === "member")
        throw new Error("403 Forbidden: owner/admin required to record reconciliation evidence")
      if (input.actionID !== mcpFixtureAction.actionID) throw new Error(`Unknown MCP fixture action: ${input.actionID}`)
      state.mcpRecords.push(input)
      state.mcpRecorded = true
      return {
        location: { directory, project: { id: "fixture", directory } },
        data: {
          actionID: input.actionID,
          kind: "confirmed" as const,
          state: "known_success" as const,
          automaticRetryAllowed: false as const,
          reason: "The owner recorded the observed remote outcome; no replay was performed.",
          evidence: {
            state: "known_success" as const,
            evidenceDigest: "d".repeat(64),
            source: "mcp-fixture",
            observedAt: 3,
            summary: "Owner recorded the operator-confirmed remote outcome.",
          },
        },
      }
    },
  },
} as unknown as OperationsApi

declare global {
  interface Window {
    runtimeInsightFixture: typeof state & {
      setWorkspace: (workspace: string) => void
      locationCalls: typeof locationCalls
    }
  }
}

window.runtimeInsightFixture = Object.assign(state, {
  setWorkspace: (workspace: string) => setFixtureWorkspace(workspace),
  locationCalls,
})

render(
  () => (
    <PlatformProvider
      value={{
        platform: "web",
        openLink: () => undefined,
        restart: async () => undefined,
        back: () => undefined,
        forward: () => undefined,
        notify: async () => undefined,
      }}
    >
      <LanguageProvider locale={fixtureLocale}>
        <RuntimeInsightWorkbench
          api={() => api}
          location={() => ({ location: { directory, workspace: fixtureWorkspace() } })}
          sessionID="ses_runtime_insight_fixture"
          ready={() => true}
        />
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.getElementById("root")!,
)
