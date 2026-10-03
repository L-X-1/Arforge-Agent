import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"

export const EvolutionProposalTable = sqliteTable(
  "evolution_proposal",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    candidate_id: text().notNull(),
    artifact_digest: text().notNull(),
    artifact_ref: text().notNull(),
    manifest: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    state: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text().notNull(),
    revision: integer().notNull(),
    evaluation_id: text(),
    control_run_id: text(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("evolution_proposal_candidate_idx").on(table.tenant_id, table.owner_user_id, table.candidate_id),
    index("evolution_proposal_status_idx").on(table.tenant_id, table.owner_user_id, table.status, table.time_updated),
    index("evolution_proposal_digest_idx").on(table.tenant_id, table.owner_user_id, table.artifact_digest),
  ],
)

export const EvolutionEvaluationTable = sqliteTable(
  "evolution_evaluation",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    proposal_id: text().notNull(),
    candidate_digest: text().notNull(),
    report_digest: text().notNull(),
    report: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    run_id: text(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("evolution_evaluation_proposal_digest_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.proposal_id,
      table.report_digest,
    ),
    index("evolution_evaluation_proposal_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.proposal_id,
      table.time_created,
    ),
  ],
)

export const EvolutionObservationTable = sqliteTable(
  "evolution_observation",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    proposal_id: text().notNull(),
    candidate_digest: text().notNull(),
    cohort: text().notNull(),
    success: integer({ mode: "boolean" }).notNull(),
    score: real().notNull(),
    safety_incident: integer({ mode: "boolean" }).notNull(),
    evidence_ref: text().notNull(),
    record_hash: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("evolution_observation_proposal_hash_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.proposal_id,
      table.record_hash,
    ),
    index("evolution_observation_proposal_cohort_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.proposal_id,
      table.cohort,
      table.time_created,
    ),
  ],
)

export const EvolutionExposureTable = sqliteTable(
  "evolution_exposure",
  {
    ...OwnershipColumns,
    id: text().notNull(),
    ticket_digest: text().notNull(),
    ticket: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text().notNull(),
    outcome_input_digest: text(),
    receipt_digest: text(),
    receipt: text({ mode: "json" }).$type<Record<string, unknown>>(),
    revision: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.id] }),
    uniqueIndex("evolution_exposure_ticket_digest_idx").on(table.tenant_id, table.owner_user_id, table.ticket_digest),
    index("evolution_exposure_status_idx").on(table.tenant_id, table.owner_user_id, table.status, table.time_created),
  ],
)

export const EvolutionArtifactTable = sqliteTable(
  "evolution_artifact",
  {
    ...OwnershipColumns,
    digest: text().notNull(),
    kind: text().notNull(),
    uri: text().notNull(),
    byte_length: integer().notNull(),
    content: text().notNull(),
    created_by: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.digest] }),
    index("evolution_artifact_kind_idx").on(table.tenant_id, table.owner_user_id, table.kind, table.time_created),
  ],
)

export const EvolutionAuditTable = sqliteTable(
  "evolution_audit",
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
    uniqueIndex("evolution_audit_record_hash_idx").on(table.tenant_id, table.owner_user_id, table.record_hash),
    index("evolution_audit_aggregate_idx").on(table.tenant_id, table.owner_user_id, table.aggregate_id, table.sequence),
  ],
)

export const EvolutionLeaseTable = sqliteTable(
  "evolution_lease",
  {
    ...OwnershipColumns,
    aggregate_id: text().notNull(),
    run_id: text().notNull(),
    lease_id: text().notNull(),
    owner_id: text().notNull(),
    generation: integer().notNull(),
    heartbeat_at: integer().notNull(),
    expires_at: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.aggregate_id] }),
    uniqueIndex("evolution_lease_run_idx").on(table.tenant_id, table.owner_user_id, table.run_id),
    index("evolution_lease_expiry_idx").on(table.tenant_id, table.owner_user_id, table.expires_at),
  ],
)
