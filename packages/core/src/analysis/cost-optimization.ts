import { CostOptimization } from "@arforge-ai/schema/cost-optimization"

/** Requirements for replacing the process-local Python cost report safely. */
export const COST_OPTIMIZATION_REQUIREMENTS = [
  "observation_journal",
  "run_session_binding",
  "workspace_identity_binding",
  "durable_cost_attribution",
  "provider_pricing_version",
  "token_usage_reconciliation",
  "cross_process_aggregation",
  "restart_recovery",
  "retention_or_clear_policy",
  "evidence_digest",
] as const satisfies ReadonlyArray<CostOptimization.Requirement>

/**
 * Audit cost-reporting prerequisites without reading the retired Python
 * tracker.  Session statistics and file fingerprints are useful signals, but
 * neither records a durable, priced, run-scoped cost ledger that can survive
 * process restarts and be reconciled across providers.
 */
export function auditCostOptimizationContract(): CostOptimization.Contract {
  return {
    schema_version: 1,
    execution_mode: "read-only-cost-optimization-contract-audit",
    side_effects: "none",
    status: "not_ready",
    ready: false,
    model_invoked: false,
    writes: 0,
    missing_requirements: [...COST_OPTIMIZATION_REQUIREMENTS],
    available_primitives: {
      sessionStats: "available-but-not-cost-ledger",
      fileMutationFingerprint: "available-but-not-read-cost-ledger",
      agentMetrics: "available-but-not-cost-ledger",
    },
    legacy_source: "python-cost-optimization",
    decision: "fail-closed",
    caveat:
      "当前 TS/Core 有 Session 统计、文件指纹和 AgentMetrics 等局部信号，但没有按 run/session、工作区/身份和 provider 定价版本绑定的 durable 成本账本；在补齐 token 对账、跨进程聚合、重启恢复、证据摘要和保留/清理策略前，不会开放旧 cost-optimization 报告或写入路径。",
  }
}

export const CostOptimizationAnalysis = {
  audit: auditCostOptimizationContract,
}
