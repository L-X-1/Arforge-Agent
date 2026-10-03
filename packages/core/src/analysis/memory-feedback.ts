import { MemoryFeedback } from "@arforge-ai/schema/memory-feedback"

/**
 * Contract audit for the historical memory-recall feedback command.
 *
 * MemoryV2 currently records bounded recall observations in RuntimeInsight,
 * while the Python compatibility command expects a durable retrieval event,
 * a retrieval UID, returned-set validation and an atomic feedback update.
 * Those are different semantics.  Keep the migration boundary typed and
 * explicit instead of writing to the retired Python store or accepting a
 * feedback payload that cannot be scoped and audited.
 */

export const MEMORY_FEEDBACK_REQUIREMENTS = [
  "durable_retrieval_event",
  "retrieval_uid",
  "returned_set_validation",
  "workspace_identity_binding",
  "actor_authorization",
  "transactional_update",
  "retention_or_clear_policy",
  "cross_process_evidence",
] as const satisfies ReadonlyArray<MemoryFeedback.Requirement>

/**
 * Return the stable checklist that gates a future memory feedback producer.
 * This function is deliberately pure: it does not inspect a profile, load a
 * retrieval UID, invoke a model, or touch the database.
 */
export function auditMemoryFeedbackContract(): MemoryFeedback.Contract {
  return {
    schema_version: 1,
    execution_mode: "read-only-memory-feedback-contract-audit",
    side_effects: "none",
    status: "not_ready",
    ready: false,
    model_invoked: false,
    writes: 0,
    missing_requirements: [...MEMORY_FEEDBACK_REQUIREMENTS],
    legacy_source: "python-memory-retrieval-event",
    decision: "fail-closed",
    caveat:
      "MemoryV2 目前只有 bounded RuntimeInsight recall observations，没有可跨进程定位并校验 returned set 的 durable retrieval event；在补齐 retrieval UID、工作区/身份绑定、授权、事务更新、保留/清理策略和跨进程证据前，不会写入 recall feedback，也不会回退旧 Python 数据库。",
  }
}

export const MemoryFeedbackAnalysis = {
  audit: auditMemoryFeedbackContract,
}
