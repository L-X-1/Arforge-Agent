import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"

export const SkillVersionTable = sqliteTable(
  "skill_version",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    skill_id: text().$type<SkillContract.SkillID>().notNull(),
    version: text().notNull(),
    digest: text().notNull(),
    skill_record: text({ mode: "json" }).$type<unknown>().notNull(),
    manifest: text({ mode: "json" }).$type<unknown>().notNull(),
    artifact_files: text({ mode: "json" }).$type<unknown>().notNull(),
    tests: text({ mode: "json" }).$type<unknown>().notNull(),
    scan: text({ mode: "json" }).$type<unknown>().notNull(),
    source_experience_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.ExperienceID>>().notNull(),
    source_evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    evaluation_id: text().$type<AgentRuntime.EvaluationID>().notNull(),
    evaluation_digest: text(),
    evaluation_passed: integer({ mode: "boolean" }),
    baseline_version_id: text(),
    status: text().$type<SkillContract.Status>().notNull(),
    revision: integer().notNull(),
    policy_version: text().notNull(),
    created_by: text().notNull(),
    review_actor: text(),
    review_reason: text(),
    traffic_percent: integer(),
    canary_digest: text(),
    rollback_version: text(),
    record_digest: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("skill_version_identity_idx").on(table.tenant_id, table.owner_user_id, table.skill_id, table.version),
    uniqueIndex("skill_version_digest_idx").on(table.tenant_id, table.owner_user_id, table.digest),
    index("skill_version_status_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.skill_id,
      table.status,
      table.time_updated,
    ),
  ],
)

export const SkillEvaluationTable = sqliteTable(
  "skill_evaluation",
  {
    ...OwnershipColumns,
    id: text().$type<AgentRuntime.EvaluationID>().notNull(),
    candidate_id: text().notNull(),
    report_digest: text().notNull(),
    report: text({ mode: "json" }).$type<unknown>().notNull(),
    passed: integer({ mode: "boolean" }).notNull(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("skill_evaluation_candidate_idx").on(table.tenant_id, table.owner_user_id, table.candidate_id),
    uniqueIndex("skill_evaluation_digest_idx").on(table.tenant_id, table.owner_user_id, table.report_digest),
  ],
)

export const SkillCanaryObservationTable = sqliteTable(
  "skill_canary_observation",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    candidate_id: text().notNull(),
    idempotency_key: text().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    evaluation_id: text().$type<AgentRuntime.EvaluationID>().notNull(),
    cohort_key_digest: text().notNull(),
    success: integer({ mode: "boolean" }).notNull(),
    safety_incident: integer({ mode: "boolean" }).notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    record_digest: text().notNull(),
    record: text({ mode: "json" }).$type<unknown>().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("skill_canary_idempotency_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.idempotency_key,
    ),
    uniqueIndex("skill_canary_record_digest_idx").on(table.tenant_id, table.owner_user_id, table.record_digest),
    index("skill_canary_candidate_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.time_created,
    ),
  ],
)

export const SkillDeploymentTable = sqliteTable(
  "skill_deployment",
  {
    ...OwnershipColumns,
    skill_id: text().$type<SkillContract.SkillID>().notNull(),
    active_candidate_id: text().notNull(),
    previous_candidate_id: text(),
    generation: integer().notNull(),
    deployment_digest: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.skill_id] }),
    uniqueIndex("skill_deployment_digest_idx").on(table.tenant_id, table.owner_user_id, table.deployment_digest),
  ],
)

export const SkillAuditTable = sqliteTable(
  "skill_audit",
  {
    ...OwnershipColumns,
    aggregate_id: text().notNull(),
    sequence: integer().notNull(),
    action: text().notNull(),
    actor: text().notNull(),
    reason: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    previous_hash: text().notNull(),
    record_hash: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.aggregate_id, table.sequence] }),
    uniqueIndex("skill_audit_record_hash_idx").on(table.tenant_id, table.owner_user_id, table.record_hash),
    index("skill_audit_aggregate_idx").on(table.tenant_id, table.owner_user_id, table.aggregate_id, table.sequence),
  ],
)
