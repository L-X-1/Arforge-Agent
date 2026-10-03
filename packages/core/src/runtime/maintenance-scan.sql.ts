import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"

/**
 * Durable, profile-owned maintenance scan state.  The session row is the
 * mutable cursor/revision projection; page rows are append-only audit facts.
 * Neither table stores artifact bytes or action payloads.
 */
export const ArtifactMaintenanceScanTable = sqliteTable(
  "artifact_maintenance_scan",
  {
    ...OwnershipColumns,
    id: text().primaryKey(),
    scope: text().notNull(),
    status: text().notNull(),
    scan_limit: integer().notNull(),
    start_cursor: text(),
    cursor: text(),
    page_count: integer().notNull().default(0),
    scanned_actions: integer().notNull().default(0),
    referenced_count: integer().notNull().default(0),
    session_digest: text().notNull(),
    expires_at: integer().notNull(),
    completed_at: integer(),
    revision: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("artifact_maintenance_scan_owner_status_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.status,
      table.time_updated,
    ),
    index("artifact_maintenance_scan_expiry_idx").on(table.status, table.expires_at),
  ],
)

export const ArtifactMaintenanceScanPageTable = sqliteTable(
  "artifact_maintenance_scan_page",
  {
    ...OwnershipColumns,
    scan_id: text().notNull(),
    page_number: integer().notNull(),
    cursor_before: text(),
    cursor_after: text(),
    scanned_actions: integer().notNull(),
    referenced_count: integer().notNull(),
    audit: text({ mode: "json" }).$type<Readonly<Record<string, number | boolean>>>().notNull(),
    page_digest: text().notNull(),
    recorded_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scan_id, table.page_number] }),
    uniqueIndex("artifact_maintenance_scan_page_digest_idx").on(table.scan_id, table.page_digest),
    index("artifact_maintenance_scan_page_owner_idx").on(table.tenant_id, table.owner_user_id, table.recorded_at),
  ],
)

/**
 * Append-only audit of cooperative maintenance leases.  The current Flock
 * still provides the local OS admission window; these rows make generation,
 * expiry, heartbeat and release observable after a process is rebuilt.
 */
export const ArtifactMaintenanceLeaseTable = sqliteTable(
  "artifact_maintenance_lease",
  {
    ...OwnershipColumns,
    lease_id: text().primaryKey(),
    scan_id: text()
      .notNull()
      .references(() => ArtifactMaintenanceScanTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    status: text().notNull(),
    acquired_at: integer().notNull(),
    heartbeat_at: integer().notNull(),
    expires_at: integer().notNull(),
    released_at: integer(),
  },
  (table) => [
    uniqueIndex("artifact_maintenance_lease_scan_generation_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.scan_id,
      table.generation,
    ),
    index("artifact_maintenance_lease_scan_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.scan_id,
      table.generation,
    ),
    index("artifact_maintenance_lease_expiry_idx").on(table.status, table.expires_at),
  ],
)
