import { check, index, integer, primaryKey, sqliteTable, text } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"
import { sql } from "drizzle-orm"

/**
 * Payload-free, restartable owner promotion checkpoint.  The runtime validates
 * the exact shape and digest before using this metadata to advance a receipt.
 */
export interface SettlementOutboxOwnerProgress {
  readonly schemaVersion: 1
  readonly intentID: string
  readonly commitDigest: string
  readonly ownerOrder: ReadonlyArray<SettlementOutboxOwner>
  readonly completed: ReadonlyArray<SettlementOutboxOwner>
  readonly ownerDigests: Readonly<Record<string, string>>
  readonly progressDigest: string
}

export type SettlementOutboxOwner = "admission-evidence" | "child-result" | "parent-budget"

/**
 * Metadata-only recovery receipt for a cross-owner child settlement.
 *
 * This table is deliberately not an Evidence, Result, or Budget projection.
 * It stores the immutable commit-plan digest and the bounded owner graph so a
 * rebuilt process can resume the existing owners without replaying a
 * provider. The composite key keeps receipts isolated even when two tenants
 * happen to use the same deterministic intent id.
 */
export const ChildSettlementRecoveryOutboxTable = sqliteTable(
  "child_settlement_recovery_outbox",
  {
    ...OwnershipColumns,
    intent_id: text().notNull(),
    parent_run_id: text().notNull(),
    child_run_id: text().notNull(),
    commit_digest: text().notNull(),
    mode: text().notNull().default("recovery-outbox"),
    status: text().notNull(),
    owner_order: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    expected_digests: text({ mode: "json" }).$type<Readonly<Record<string, string>>>().notNull(),
    reason: text().notNull().default(""),
    revision: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    receipt_digest: text().notNull(),
    owner_progress: text({ mode: "json" }).$type<SettlementOutboxOwnerProgress | null>(),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.intent_id] }),
    check("child_settlement_recovery_outbox_mode_check", sql`${table.mode} = 'recovery-outbox'`),
    check(
      "child_settlement_recovery_outbox_status_check",
      sql`${table.status} IN ('prepared', 'committed', 'recovery-required')`,
    ),
    check("child_settlement_recovery_outbox_revision_check", sql`${table.revision} >= 0`),
    index("child_settlement_recovery_outbox_owner_status_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.status,
      table.time_updated,
    ),
    index("child_settlement_recovery_outbox_parent_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.parent_run_id,
      table.time_updated,
    ),
  ],
)
