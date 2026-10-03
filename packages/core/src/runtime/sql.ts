import { index, integer, real, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { OwnershipColumns } from "../identity/sql"

export const AuditEntryTable = sqliteTable(
  "audit_entry",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    seq: integer().notNull(),
    recorded_at: integer().notNull(),
    actor: text().notNull(),
    action: text().notNull(),
    resource: text().notNull(),
    reason: text(),
    metadata: text({ mode: "json" }),
    previous_hash: text().notNull(),
    record_hash: text().notNull(),
  },
  (table) => [
    uniqueIndex("audit_entry_seq_idx").on(table.seq),
    index("audit_entry_action_idx").on(table.action, table.recorded_at),
    index("audit_entry_actor_idx").on(table.actor, table.recorded_at),
  ],
)

export const SessionRunTable = sqliteTable(
  "session_run",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    session_id: text().notNull(),
    status: text().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    last_seq: integer(),
    error: text(),
  },
  (table) => [
    index("session_run_session_idx").on(table.session_id, table.started_at),
    index("session_run_status_idx").on(table.status, table.started_at),
  ],
)

export const SessionRunUsageTable = sqliteTable(
  "session_run_usage",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    run_id: text().notNull(),
    session_id: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    usage_source: text().notNull(),
    estimator_id: text(),
    unknown_input: integer().notNull(),
    image_input: integer().notNull(),
    audio_input: integer().notNull(),
    cache_read_input: integer().notNull(),
    cache_write_input: integer().notNull(),
    text_output: integer().notNull(),
    reasoning_output: integer().notNull(),
    audio_output: integer().notNull(),
    price_catalog_revision: text(),
    currency: text(),
    amount_minor: integer(),
    unpriced_categories: text({ mode: "json" }).notNull(),
    settlement_reservation_id: text(),
    billing_receipt: text({ mode: "json" }).$type<unknown>(),
    over_budget: integer({ mode: "boolean" }).notNull().default(false),
    recorded_at: integer().notNull(),
  },
  (table) => [
    index("session_run_usage_run_idx").on(table.run_id, table.recorded_at),
    index("session_run_usage_session_idx").on(table.session_id, table.recorded_at),
  ],
)

export const EvaluationResultTable = sqliteTable(
  "evaluation_result",
  {
    ...OwnershipColumns,
    id: text().$type<AgentRuntime.EvaluationID>().primaryKey(),
    run_id: text().$type<AgentRuntime.RunID>().notNull(),
    suite_id: text().notNull(),
    suite_revision: integer().notNull(),
    case_id: text().notNull(),
    case_revision: integer().notNull(),
    baseline_artifact_digest: text().notNull(),
    candidate_artifact_digest: text().notNull(),
    environment_digest: text().notNull(),
    toolchain_digest: text().notNull(),
    sample_size: integer().notNull(),
    score: real().notNull(),
    success_delta: real().notNull(),
    cost_delta: real().notNull(),
    latency_delta: real().notNull(),
    passed: integer({ mode: "boolean" }).notNull(),
    metrics: text({ mode: "json" }).$type<Readonly<Record<string, number>>>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<AgentRuntime.EvidenceID>>().notNull(),
    provider_id: text(),
    model_id: text(),
    input_tokens: integer(),
    output_tokens: integer(),
    cost_minor: integer(),
    currency: text(),
    reviewer_id: text(),
    approval_status: text().notNull().default("pending"),
    approval_reason: text(),
    created_at: integer().notNull(),
    evaluated_at: integer().notNull(),
  },
  (table) => [
    index("evaluation_result_run_created_idx").on(table.run_id, table.created_at),
    index("evaluation_result_case_revision_idx").on(table.case_id, table.case_revision),
    index("evaluation_result_suite_revision_idx").on(table.suite_id, table.suite_revision),
  ],
)
