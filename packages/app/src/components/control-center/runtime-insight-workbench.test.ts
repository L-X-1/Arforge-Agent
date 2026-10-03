import { describe, expect, test } from "bun:test"
import {
  actionNameText,
  auditActionText,
  authorityText,
  actionStatusText,
  canCancelPendingAction,
  modelText,
  mcpRecoveryEvidenceSummaryText,
  mcpRecoveryReasonText,
  riskTierText,
  runtimeModelText,
  runtimeReasonText,
  runStatus,
  runtimeInsightCopy,
  recoveryReviewOptions,
  postProcessingCheckpointText,
  postProcessingRecoveryText,
  sessionProcessCopy,
} from "./runtime-insight-presentation"
import {
  artifactActionText,
  artifactAuditChainState,
  formatArtifactBytes,
  shortArtifactIdentifier,
} from "./artifact-evidence"

describe("runtime insight audit labels", () => {
  test("translates known action identifiers while preserving unknown identifiers", () => {
    expect(actionNameText("asset-localization", "en")).toBe("Localize external assets")
    expect(actionNameText("asset-localization", "zh")).toBe("本地化外部资源")
    expect(actionNameText("asset-localization", "zht")).toBe("本地化外部資源")
    expect(actionNameText("future-action", "en")).toBe("future-action")
  })

  test("offers originating-session cancellation only before execution handoff", () => {
    expect(canCancelPendingAction("ses_1", "awaiting_approval", "ses_1")).toBe(true)
    expect(canCancelPendingAction("ses_1", "policy_evaluated", "ses_1")).toBe(true)
    expect(canCancelPendingAction("ses_1", "authorized", "ses_1")).toBe(false)
    expect(canCancelPendingAction("ses_1", "executing", "ses_1")).toBe(false)
    expect(canCancelPendingAction("ses_1", "awaiting_approval", "ses_2")).toBe(false)
    expect(canCancelPendingAction("ses_1", "awaiting_approval", undefined)).toBe(false)
    expect(actionStatusText("cancelled", "en")).toBe("Cancelled")
    expect(actionStatusText("cancelled", "zh")).toBe("已取消")
  })

  test("explains durable authorization outcomes without exposing implementation details", () => {
    expect(auditActionText("action.authorization.granted")).toBe("授权范围已安全记录")
    expect(auditActionText("action.authorization.failed")).toBe("授权未通过，动作未执行")
    expect(auditActionText("action.scope.escalation")).toBe("执行范围超出授权，已安全停止")
  })

  test("localizes durable run metadata without exposing raw enums", () => {
    expect(authorityText("scoped_grant", "en")).toBe("Scoped permission")
    expect(riskTierText("L2", "zh")).toBe("风险 L2")
    expect(runStatus("awaiting_authorization", "zht").text).toBe("需要你確認")
    expect(runtimeInsightCopy("en").durableTitle).toBe("Durable runs and crash recovery")
    expect(runtimeInsightCopy("zh").mutationRecoveryStatus("prepared", "inspect", true, "mut_tx_1")).toContain(
      "恢复需要处理",
    )
    expect(runtimeInsightCopy("en").mutationRecoveryStatus("settled", "settled", false, "mut_tx_1")).toContain(
      "Mutation settled",
    )
    expect(runtimeInsightCopy("en").inspectionDecision("postimage_matches")).toBe("Postimage matches")
    expect(runtimeInsightCopy("zh").inspectionEntry("write", "src/index.ts", "preimage_matches")).toContain(
      "匹配写入前",
    )
    expect(sessionProcessCopy("en").actionTimeline).toBe("Execution timeline · real backend records")
    expect(sessionProcessCopy("zht").evolutionStages[3]).toBe("你審批")
    expect(runtimeModelText("unselected", "unselected", "zh")).toBe("未选择模型")
    expect(modelText("provider/model", "en")).toBe("provider/model")
    expect(runtimeReasonText("ProviderModelNotFoundError: Model not found: unselected/unselected", "zh")).toBe(
      "尚未配置可用模型。请在设置中选择提供商和模型后重试。",
    )
    expect(runtimeReasonText("workflow independent verifier passed", "zht")).toBe("工作流程驗證已通過")
    expect(runtimeReasonText("A durable file mutation was interrupted during post-processing.", "zht")).toBe(
      "持久檔案變更在後處理期間中斷。",
    )
    expect(runtimeReasonText("Waiting for approval in another session", "zht")).toBe("等待確認。")
    expect(runtimeInsightCopy("zht").cancelPendingAction).toBe("取消待確認動作")
    expect(runtimeInsightCopy("zht").cancelPendingActionHint).toContain("僅原始會話")
    expect(runtimeInsightCopy("zh").reviewTitle).toBe("人工复核决定")
    expect(runtimeInsightCopy("zht").reviewTitle).toBe("人工復核決定")
    expect(runtimeInsightCopy("zh").reviewSafetyNotice).toContain("以下按钮")
    expect(runtimeInsightCopy("zht").reviewSafetyNotice).toContain("以下按鈕")
    expect(runtimeInsightCopy("zh").recoveryRoleNotice("member", false, false)).toContain("成员")
    expect(runtimeInsightCopy("zht").recoveryRoleNotice("member", false, false)).toContain("成員")
    expect(
      mcpRecoveryReasonText(
        "The remote outcome remains unknown; inspect the provider before recording evidence.",
        "zht",
      ),
    ).toBe("遠端結果仍未知；請先檢查提供商後再記錄證據。")
    expect(mcpRecoveryEvidenceSummaryText("No transport replay was attempted.", "zht")).toBe("未執行傳輸重放。")
    expect(mcpRecoveryEvidenceSummaryText("future provider summary", "zht")).toBe("future provider summary")
  })

  test("preserves unknown actions for forward-compatible diagnostics", () => {
    expect(auditActionText("future.action")).toBe("future.action")
  })

  test("explains semantic post-processing checkpoints in every supported locale", () => {
    expect(postProcessingCheckpointText("formatter", "started", "src/index.ts", "en")).toBe(
      "formatter · in progress · src/index.ts",
    )
    expect(postProcessingCheckpointText("diagnostics", "completed", undefined, "zh")).toBe("诊断 · 已完成")
    expect(postProcessingCheckpointText("watcher", "completed", "src/index.ts", "zht")).toContain("檔案變更通知")
    expect(postProcessingRecoveryText("in_flight", "lsp_touch", "src/index.ts", "en")).toBe(
      "possibly in flight · LSP refresh · src/index.ts",
    )
    expect(postProcessingRecoveryText("completed_unsettled", undefined, undefined, "zh")).toBe("已完成但尚未结算")
  })

  test("offers only legal evidence-bound recovery decisions", () => {
    expect(recoveryReviewOptions("committed", "postimage_matches", "en").map((item) => item.decision)).toEqual([
      "settle_postimage",
      "require_rollback",
    ])
    expect(recoveryReviewOptions("prepared", "postimage_matches", "zh").map((item) => item.decision)).toEqual([
      "require_rollback",
    ])
    expect(recoveryReviewOptions("rollback_required", "preimage_matches", "en").map((item) => item.decision)).toEqual([
      "confirm_rolled_back",
    ])
    expect(recoveryReviewOptions("rollback_required", "manual_review", "zht").map((item) => item.decision)).toEqual([
      "block_rollback",
    ])
    expect(recoveryReviewOptions("settled", "postimage_matches", "en")).toEqual([])
  })

  test("explains role-scoped recovery controls without hiding evidence review", () => {
    expect(runtimeInsightCopy("en").recoveryRoleNotice("member", false, false)).toContain(
      "rollback requires owner/admin",
    )
    expect(runtimeInsightCopy("en").recoveryRollbackPermission).toContain("can inspect and record evidence")
    expect(runtimeInsightCopy("zh").recoveryRoleNotice("admin", true, true)).toContain("管理员")
  })

  test("explains artifact health and requires a deliberate maintenance confirmation", () => {
    expect(runtimeInsightCopy("zh").artifactStatus("missing")).toBe("逆向工件缺失")
    expect(runtimeInsightCopy("en").artifactStatus("corrupt")).toBe("Inverse artifact integrity failed")
    expect(runtimeInsightCopy("en").confirmSweepArtifacts).toContain("Confirm")
    expect(runtimeInsightCopy("zh").artifactScanIncomplete).toContain("不允许清理")
    expect(runtimeInsightCopy("en").continueArtifactScan).toContain("Continue")
    expect(runtimeInsightCopy("zh").sweepRequiresCompleteScan).toContain("完成")
    expect(runtimeInsightCopy("en").artifactScanProgress(2, 10)).toContain("2")
  })

  test("keeps artifact evidence metadata bounded and honest about a paged audit window", () => {
    expect(shortArtifactIdentifier("artifact_abcdefghijklmnopqrstuvwxyz", 12)).toBe("artif…uvwxyz")
    expect(formatArtifactBytes(1024 * 1024 * 2.5)).toBe("2.5 MiB")
    expect(
      artifactAuditChainState(
        [
          { sequence: 2, previousHash: "hash-1", recordHash: "hash-2" },
          { sequence: 1, previousHash: "genesis", recordHash: "hash-1" },
        ],
        0,
      ),
    ).toBe("intact")
    expect(artifactAuditChainState([{ sequence: 8, previousHash: "hash-7", recordHash: "hash-8" }], 7)).toBe("windowed")
    expect(
      artifactAuditChainState(
        [
          { sequence: 2, previousHash: "wrong", recordHash: "hash-2" },
          { sequence: 1, previousHash: "genesis", recordHash: "hash-1" },
        ],
        0,
      ),
    ).toBe("broken")
    expect(artifactActionText("removed", "zh")).toBe("已移除")
    expect(runtimeInsightCopy("zh").artifactEvidenceHint("tenant")).toContain("当前租户")
    expect(runtimeInsightCopy("en").artifactEvidenceEmpty("profile")).toContain("current profile")
    expect(runtimeInsightCopy("en").artifactEvidenceMaintenanceStatus(false, undefined, undefined, "role")).toContain(
      "unavailable",
    )
    expect(runtimeInsightCopy("zh").artifactEvidenceMaintenanceProgress(2, 10)).toContain("2")
    expect(runtimeInsightCopy("zh").settlementRecoveryHint).toContain("recovery-outbox")
    expect(runtimeInsightCopy("en").settlementRecoverySummary(2, 1, 0, 1)).toContain("Scanned 2")
    expect(runtimeInsightCopy("zht").settlementRecoveryReview(1)).toContain("人工復核")
  })
})
