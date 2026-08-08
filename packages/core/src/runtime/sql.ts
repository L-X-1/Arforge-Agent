import { index, integer, sqliteTable, text, uniqueIndex } from "../database/dialect"
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
