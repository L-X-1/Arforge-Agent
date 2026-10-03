import { index, integer, primaryKey, text, uniqueIndex } from "../database/dialect"
import { sqliteTable } from "../database/dialect"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export const ExperienceEvidenceTable = sqliteTable(
  "experience_evidence",
  {
    ...OwnershipColumns,
    id: text().$type<AgentRuntime.EvidenceID>().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    action_id: text().$type<AgentRuntime.ActionID>().notNull(),
    observation_id: text().$type<AgentRuntime.ObservationID>().notNull(),
    record_digest: text().notNull(),
    record: text({ mode: "json" }).$type<unknown>().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("experience_evidence_record_digest_idx").on(table.tenant_id, table.owner_user_id, table.record_digest),
    index("experience_evidence_run_action_idx").on(table.tenant_id, table.owner_user_id, table.run_id, table.action_id),
  ],
)

export const ExperienceCandidateTable = sqliteTable(
  "experience_candidate",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    problem_signature: text().notNull(),
    applicable_scope: text().notNull(),
    conditions: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    attempted_strategy: text().notNull(),
    counterexamples: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    support_count: integer().notNull(),
    source_run_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.RunID>>().notNull(),
    source_support_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    evaluation_digest: text(),
    review_actor: text(),
    review_reason: text(),
    review_status: text().$type<"pending" | "approved" | "rejected" | "expired">().notNull(),
    status: text().$type<"candidate" | "active" | "rejected" | "expired">().notNull(),
    policy_version: text().notNull(),
    expiry_at: integer(),
    digest: text().notNull(),
    revision: integer().notNull(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("experience_candidate_digest_idx").on(table.tenant_id, table.owner_user_id, table.digest),
    index("experience_candidate_status_idx").on(table.tenant_id, table.owner_user_id, table.status, table.time_updated),
  ],
)

export const ExperienceSupportTable = sqliteTable(
  "experience_support",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    candidate_id: text().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    action_id: text().$type<AgentRuntime.ActionID>().notNull(),
    evaluation_id: text().$type<AgentRuntime.EvaluationID>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    summary: text().notNull(),
    support_digest: text().notNull(),
    learning_outcome_id: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("experience_support_candidate_run_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.run_id,
    ),
    uniqueIndex("experience_support_digest_idx").on(table.tenant_id, table.owner_user_id, table.support_digest),
    index("experience_support_candidate_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.time_created,
    ),
  ],
)

export const ExperienceEvaluationTable = sqliteTable(
  "experience_evaluation",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    candidate_id: text().notNull(),
    evaluation_digest: text().notNull(),
    comparison: text({ mode: "json" }).$type<unknown>().notNull(),
    passed: integer({ mode: "boolean" }).notNull(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("experience_evaluation_candidate_digest_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.evaluation_digest,
    ),
    index("experience_evaluation_candidate_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.time_created,
    ),
  ],
)

export const ExperienceRecordTable = sqliteTable(
  "experience_record",
  {
    ...OwnershipColumns,
    id: text().$type<AgentRuntime.ExperienceID>().notNull(),
    candidate_id: text().notNull(),
    support_id: text().notNull(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    action_id: text().$type<AgentRuntime.ActionID>().notNull(),
    evaluation_id: text().$type<AgentRuntime.EvaluationID>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    record_digest: text().notNull(),
    record: text({ mode: "json" }).$type<unknown>().notNull(),
    policy_version: text().notNull(),
    promoted_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("experience_record_support_idx").on(table.tenant_id, table.owner_user_id, table.support_id),
    uniqueIndex("experience_record_digest_idx").on(table.tenant_id, table.owner_user_id, table.record_digest),
    index("experience_record_candidate_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.candidate_id,
      table.time_created,
    ),
  ],
)

export const ExperienceAuditTable = sqliteTable(
  "experience_audit",
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
    uniqueIndex("experience_audit_record_hash_idx").on(table.tenant_id, table.owner_user_id, table.record_hash),
    index("experience_audit_aggregate_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.aggregate_id,
      table.sequence,
    ),
  ],
)
