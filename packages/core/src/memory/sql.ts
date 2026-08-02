import { index, integer, real, sqliteTable, text } from "../database/dialect"
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
