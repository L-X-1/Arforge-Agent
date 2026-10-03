import { FeaturePolicy } from "@arforge-ai/schema/feature-policy"

/** Requirements for replacing the legacy feature flag writer safely. */
export const FEATURE_POLICY_REQUIREMENTS = [
  "durable_feature_state",
  "workspace_identity_binding",
  "actor_authorization",
  "transactional_update",
  "rollback_or_recovery",
  "audit_evidence",
  "cross_process_consistency",
  "retention_or_clear_policy",
] as const satisfies ReadonlyArray<FeaturePolicy.Requirement>

/**
 * Describe the missing feature-policy mutation contract without reading the
 * retired Python registry or changing the native TypeScript policy.
 */
export function auditFeaturePolicyContract(): FeaturePolicy.Contract {
  return {
    schema_version: 1,
    execution_mode: "read-only-feature-policy-contract-audit",
    side_effects: "none",
    status: "not_ready",
    ready: false,
    model_invoked: false,
    writes: 0,
    missing_requirements: [...FEATURE_POLICY_REQUIREMENTS],
    available_primitives: {
      nativePolicy: "available-read-only",
      deepInsightsSection: "available-read-only",
      pythonRegistry: "not-read",
    },
    legacy_source: "python-feature-flags",
    decision: "fail-closed",
    caveat:
      "当前 TS/Core 只有 nativeFeatures 与 Desktop 深度诊断只读投影，没有可按工作区/身份持久化、授权、事务更新和回滚的功能策略 writer；在补齐跨进程一致性、审计证据和保留/清理策略前，不会恢复旧 Python feature_flags.json 写入。",
  }
}

export const FeaturePolicyAnalysis = {
  audit: auditFeaturePolicyContract,
}
