import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { SessionTable } from "../session/sql"
import { Timestamps } from "../database/schema.sql"
import { OwnershipColumns } from "../identity/sql"
import { sql } from "drizzle-orm"

export const SessionShareTable = sqliteTable("session_share", {
  ...OwnershipColumns,
  session_id: text()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  id: text().notNull(),
  secret: text().notNull(),
  url: text().notNull(),
  ...Timestamps,
})

/**
 * Append-only receipt projection for a provider operation that has already
 * passed local response verification. Pending or ambiguous operations never
 * enter this table; their truth remains in the ControlRun event stream.
 */
export const SessionShareOperationReceiptTable = sqliteTable(
  "session_share_operation_receipt",
  {
    ...OwnershipColumns,
    operation_id: text().notNull(),
    run_id: text().notNull(),
    action_id: text().notNull(),
    request_id: text().notNull(),
    kind: text().$type<"share" | "unshare">().notNull(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "restrict" }),
    project_id: text().notNull(),
    snapshot_digest: text().notNull(),
    export_digest: text().notNull(),
    target_base_url: text().notNull(),
    visibility: text().$type<"private" | "organization" | "public">().notNull(),
    organization_id: text(),
    provider_receipt_id: text(),
    publication_id: text().notNull(),
    publication_url: text().notNull(),
    stored_digest: text(),
    removed_digest: text(),
    response_digest: text().notNull(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.operation_id] }),
    uniqueIndex("session_share_operation_receipt_operation_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.operation_id,
    ),
    index("session_share_operation_receipt_session_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.session_id,
      table.time_created,
    ),
    index("session_share_operation_receipt_publication_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.publication_id,
      table.time_created,
    ),
    check(
      "session_share_operation_receipt_kind_fields_check",
      sql`${table.kind} = 'share' AND ${table.provider_receipt_id} IS NOT NULL AND ${table.stored_digest} IS NOT NULL AND ${table.removed_digest} IS NULL OR ${table.kind} = 'unshare' AND ${table.provider_receipt_id} IS NULL AND ${table.stored_digest} IS NULL AND ${table.removed_digest} IS NOT NULL`,
    ),
    check(
      "session_share_operation_receipt_visibility_check",
      sql`${table.visibility} IN ('private', 'organization', 'public')`,
    ),
  ],
)

/**
 * Durable fact source for the embedded self-hosted share provider. Publication
 * rows are immutable: the operation receipt and the exact frozen export are
 * retained so a later lookup can prove the stored digest without consulting
 * an in-memory cache.
 */
export const SelfHostedSharePublicationTable = sqliteTable(
  "self_hosted_share_publication",
  {
    ...OwnershipColumns,
    publication_id: text().notNull(),
    operation_id: text().notNull(),
    operation_digest: text().notNull(),
    provider_receipt_id: text().notNull(),
    publication_url: text().notNull(),
    export_digest: text().notNull(),
    frozen_export: text({ mode: "json" }).notNull().$type<Record<string, unknown>>(),
    target_base_url: text().notNull(),
    visibility: text().$type<"private" | "organization" | "public">().notNull(),
    organization_id: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.publication_id] }),
    uniqueIndex("self_hosted_share_publication_operation_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.operation_id,
    ),
    uniqueIndex("self_hosted_share_publication_receipt_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.provider_receipt_id,
    ),
    index("self_hosted_share_publication_created_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.time_created,
    ),
    check(
      "self_hosted_share_publication_visibility_check",
      sql`${table.visibility} IN ('private', 'organization', 'public')`,
    ),
  ],
)

/** Append-only revocation facts for the self-hosted provider. */
export const SelfHostedShareRevocationTable = sqliteTable(
  "self_hosted_share_revocation",
  {
    ...OwnershipColumns,
    operation_id: text().notNull(),
    operation_digest: text().notNull(),
    publication_id: text().notNull(),
    original_digest: text().notNull(),
    target_base_url: text().notNull(),
    visibility: text().$type<"private" | "organization" | "public">().notNull(),
    organization_id: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.owner_user_id, table.operation_id] }),
    uniqueIndex("self_hosted_share_revocation_operation_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.operation_id,
    ),
    uniqueIndex("self_hosted_share_revocation_publication_uidx").on(
      table.tenant_id,
      table.owner_user_id,
      table.publication_id,
    ),
    index("self_hosted_share_revocation_created_idx").on(
      table.tenant_id,
      table.owner_user_id,
      table.time_created,
    ),
    check(
      "self_hosted_share_revocation_visibility_check",
      sql`${table.visibility} IN ('private', 'organization', 'public')`,
    ),
  ],
)
