import { FileState } from "@arforge-ai/schema/file-state"

/** Requirements for replacing the process-local Python tracker safely. */
export const FILE_STATE_REQUIREMENTS = [
  "observation_journal",
  "run_session_binding",
  "workspace_identity_binding",
  "durable_persistence",
  "restart_recovery",
  "actor_authorization",
  "cancellation",
  "transactional_settlement",
  "evidence_digest",
  "retention_or_clear_policy",
] as const satisfies ReadonlyArray<FileState.Requirement>

/**
 * Audit the available building blocks without opening a second file-state
 * store.  `FileMutation.fingerprint` and `AnalysisRuns` are useful primitives,
 * but neither is a durable, run-scoped observation journal.  Keeping this
 * report read-only lets the CLI remain fail-closed until the full contract is
 * implemented by the TypeScript/Core owner.
 */
export function auditFileStateContract(): FileState.Contract {
  return {
    schema_version: 1,
    execution_mode: "read-only-file-state-contract-audit",
    side_effects: "none",
    status: "not_ready",
    ready: false,
    model_invoked: false,
    writes: 0,
    missing_requirements: [...FILE_STATE_REQUIREMENTS],
    available_primitives: {
      fileMutationFingerprint: "available-but-not-observation-ledger",
      analysisRuns: "available-but-not-file-observation-ledger",
      pythonTracker: "process-local-compatibility-only",
    },
    legacy_source: "python-file-state-tracker",
    decision: "fail-closed",
    caveat:
      "当前 TS/Core 只有一次性 FileMutation 指纹和只读 AnalysisRuns 投影，没有按 Agent run 绑定、可跨进程恢复的文件观察账本；在补齐持久化、工作区/身份授权、取消、事务结算、证据摘要和保留/清理策略前，不会把 file-state 或 cost-optimization 旧报告重新开放。",
  }
}

export const FileStateAnalysis = {
  audit: auditFileStateContract,
}
