import { PermissionPolicy } from "@arforge-ai/schema/permission-policy"

/** Requirements for replacing legacy permission-profile mutations safely. */
export const PERMISSION_POLICY_REQUIREMENTS = [
  "typed_rule_schema",
  "workspace_project_binding",
  "actor_authorization",
  "transactional_update",
  "optimistic_revision",
  "audit_evidence",
  "rollback_or_recovery",
  "cross_process_consistency",
] as const satisfies ReadonlyArray<PermissionPolicy.Requirement>

/**
 * Audit the typed building blocks without turning the legacy subject/category
 * syntax into an unreviewed database mutation.
 */
export function auditPermissionPolicyContract(): PermissionPolicy.Contract {
  return {
    schema_version: 1,
    execution_mode: "read-only-permission-policy-contract-audit",
    side_effects: "none",
    status: "not_ready",
    ready: false,
    model_invoked: false,
    writes: 0,
    missing_requirements: [...PERMISSION_POLICY_REQUIREMENTS],
    available_primitives: {
      savedRuleList: "available-read-only",
      savedRuleStore: "available-but-legacy-write-not-equivalent",
      sessionAuthorizer: "available-session-scoped",
      pythonProfile: "not-read",
    },
    legacy_source: "python-permission-profile",
    decision: "fail-closed",
    caveat:
      "当前 TS/Core 可读取 project-scoped saved rules，并可处理 session permission request，但旧 Python subject/category/decision/scope 写入语义没有同等的身份授权、乐观版本、审计证据和可恢复事务；在补齐跨进程一致性与回滚前，不会从旧 permission_rules.json 恢复写入。",
  }
}

export const PermissionPolicyAnalysis = {
  audit: auditPermissionPolicyContract,
}
