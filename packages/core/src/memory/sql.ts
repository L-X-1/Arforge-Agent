import { index, integer, real, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Memory } from "@arforge-ai/schema/memory"
import * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"
import * as MemoryClass from "@arforge-ai/schema/memory-class"
import * as MemoryRevision from "@arforge-ai/schema/memory-revision"
import * as MemoryRetention from "@arforge-ai/schema/memory-retention"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"

export const MemoryTable = sqliteTable(
  "memory",
  {
    ...OwnershipColumns,
    id: text().$type<Memory.ID>().primaryKey(),
    content: text().$type<Memory.Content>().notNull(),
    type: text().$type<Memory.Type>().notNull(),
    tags: text({ mode: "json" }).$type<ReadonlyArray<Memory.Tag>>().notNull(),
    importance: integer().$type<Memory.Importance>().notNull().default(1),
    source: text().$type<Memory.Source>().notNull(),
    scope: text().$type<Memory.Scope>().notNull(),
    project_id: text(),
    workspace_path: text(),
    related_to: text().$type<Memory.ID>(),
    strength: real().$type<Memory.Strength>().notNull().default(0.5),
    review_level: integer().$type<Memory.ReviewLevel>().notNull().default(0),
    time_reviewed: integer(),
    memory_class: text().$type<MemoryClass.MemoryClass>(),
    lifecycle: text().$type<MemoryRetention.Lifecycle>().notNull().default("active"),
    memory_version: integer().notNull().default(1),
    provenance_status: text().$type<"legacy_unknown" | "verified">().notNull().default("legacy_unknown"),
    content_digest: text().$type<MemoryRevision.ContentDigest>(),
    retention_mode: text().$type<MemoryRetention.RetentionMode>().notNull().default("indefinite"),
    retention_expires_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("memory_scope_workspace_idx").on(table.scope, table.project_id, table.workspace_path),
    index("memory_source_idx").on(table.source),
    index("memory_type_importance_idx").on(table.type, table.importance),
    index("memory_updated_idx").on(table.time_updated),
    index("memory_lifecycle_idx").on(table.lifecycle, table.time_updated),
    index("memory_class_idx").on(table.memory_class),
  ],
)

export const MemoryCandidateTable = sqliteTable(
  "memory_candidate",
  {
    ...OwnershipColumns,
    id: text().$type<MemoryCandidate.CandidateID>().primaryKey(),
    proposed_class: text().$type<MemoryClass.MemoryClass>().notNull(),
    content: text().$type<Memory.Content>().notNull(),
    source_evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    scope: text().$type<Memory.Scope>().notNull(),
    project_id: text(),
    workspace_path: text(),
    sensitivity: text().$type<MemoryCandidate.Sensitivity>().notNull(),
    confidence: real().$type<MemoryCandidate.Confidence>().notNull(),
    dedup_status: text().$type<MemoryCandidate.DedupStatus>().notNull(),
    dedup_compared_memory_ids: text({ mode: "json" }).$type<ReadonlyArray<Memory.ID>>().notNull(),
    dedup_similarity: real(),
    retention_mode: text().$type<MemoryCandidate.RetentionMode>().notNull(),
    retention_expires_at: integer(),
    retention_reason: text().notNull(),
    proposer_kind: text().$type<MemoryCandidate.Proposer["kind"]>().notNull(),
    principal_ref: text(),
    run_id: text(),
    policy_status: text().$type<MemoryCandidate.PolicyDecision["status"]>().notNull(),
    policy_version: text().notNull(),
    policy_reason: text().notNull(),
    status: text().$type<MemoryCandidate.Status>().notNull(),
    reason: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_expires: integer(),
  },
  (table) => [
    index("memory_candidate_status_idx").on(table.status, table.time_updated),
    index("memory_candidate_scope_idx").on(table.scope, table.project_id, table.workspace_path, table.time_created),
    index("memory_candidate_run_idx").on(table.run_id, table.time_created),
  ],
)

export const MemoryCandidateAuditTable = sqliteTable(
  "memory_candidate_audit",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    candidate_id: text()
      .$type<MemoryCandidate.CandidateID>()
      .notNull()
      .references(() => MemoryCandidateTable.id, { onDelete: "cascade" }),
    operation: text().$type<MemoryCandidate.ReviewOperation>().notNull(),
    actor_kind: text().$type<MemoryRevision.Actor["kind"]>().notNull(),
    principal_ref: text(),
    reason: text().notNull(),
    policy_version: text().notNull(),
    status_from: text().$type<MemoryCandidate.Status>(),
    status_to: text().$type<MemoryCandidate.Status>().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("memory_candidate_audit_candidate_idx").on(table.candidate_id, table.time_created),
    index("memory_candidate_audit_operation_idx").on(table.operation, table.time_created),
  ],
)

export const MemoryRevisionTable = sqliteTable(
  "memory_revision",
  {
    ...OwnershipColumns,
    id: text().$type<MemoryRevision.RevisionID>().primaryKey(),
    memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    operation: text().$type<MemoryRevision.Operation>().notNull(),
    actor_kind: text().$type<MemoryRevision.Actor["kind"]>().notNull(),
    principal_ref: text(),
    run_id: text(),
    reason: text().notNull(),
    policy_version: text().notNull(),
    evidence_ids: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    prior_digest: text().$type<MemoryRevision.ContentDigest>(),
    content_digest: text().$type<MemoryRevision.ContentDigest>().notNull(),
    successor_memory_id: text()
      .$type<Memory.ID>()
      .references(() => MemoryTable.id, { onDelete: "set null" }),
    candidate_id: text()
      .$type<MemoryCandidate.CandidateID>()
      .references(() => MemoryCandidateTable.id, { onDelete: "set null" }),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("memory_revision_memory_version_idx").on(table.memory_id, table.version),
    index("memory_revision_memory_created_idx").on(table.memory_id, table.time_created),
    index("memory_revision_run_idx").on(table.run_id, table.time_created),
  ],
)

export const MemoryCorrectionTable = sqliteTable(
  "memory_correction",
  {
    ...OwnershipColumns,
    id: text().$type<Memory.CorrectionID>().primaryKey(),
    original_memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    successor_memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    original_source: text().$type<Memory.Source>().notNull(),
    reason: text().$type<Memory.CorrectionReason>().notNull(),
    status: text().$type<Memory.CorrectionStatus>().notNull().default("active"),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_undone: integer(),
  },
  (table) => [
    index("memory_correction_original_idx").on(table.original_memory_id, table.time_created),
    index("memory_correction_successor_idx").on(table.successor_memory_id),
    index("memory_correction_status_idx").on(table.status, table.time_created),
  ],
)

export const MemoryConflictTable = sqliteTable(
  "memory_conflict",
  {
    ...OwnershipColumns,
    id: text().$type<Memory.ConflictID>().primaryKey(),
    signature: text().notNull(),
    conflict_key: text().$type<Memory.ConflictKey>().notNull(),
    basis: text().$type<Memory.ConflictBasis>().notNull(),
    left_memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    right_memory_id: text()
      .$type<Memory.ID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    left_fingerprint: text().notNull(),
    right_fingerprint: text().notNull(),
    status: text().$type<Memory.ConflictStatus>().notNull().default("pending"),
    chosen_memory_id: text().$type<Memory.ID>(),
    retired_memory_id: text().$type<Memory.ID>(),
    retired_original_source: text().$type<Memory.Source>(),
    decision_reason: text().$type<Memory.ConflictReason>(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
    time_updated: integer()
      .notNull()
      .$default(() => Date.now()),
    time_decided: integer(),
    time_undone: integer(),
  },
  (table) => [
    uniqueIndex("memory_conflict_signature_idx").on(table.signature),
    index("memory_conflict_status_idx").on(table.status, table.time_updated),
    index("memory_conflict_left_idx").on(table.left_memory_id),
    index("memory_conflict_right_idx").on(table.right_memory_id),
  ],
)
