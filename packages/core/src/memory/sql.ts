import { index, integer, real, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Memory } from "@arforge-ai/schema/memory"
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
    ...Timestamps,
  },
  (table) => [
    index("memory_scope_workspace_idx").on(table.scope, table.project_id, table.workspace_path),
    index("memory_source_idx").on(table.source),
    index("memory_type_importance_idx").on(table.type, table.importance),
    index("memory_updated_idx").on(table.time_updated),
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
