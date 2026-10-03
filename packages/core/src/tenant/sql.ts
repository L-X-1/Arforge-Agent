import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { OwnershipColumns } from "../identity/sql"
import { ProjectTable } from "../project/sql"
import { IdentityTenantTable, IdentityUserTable } from "../identity/sql"

export const TenantPolicyTable = sqliteTable("tenant_policy", {
  ...OwnershipColumns,
  tenant_id: text()
    .notNull()
    .primaryKey()
    .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
  owner_user_id: text()
    .notNull()
    .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
  region: text().notNull().default("self-hosted"),
  retention_days: integer().notNull().default(365),
  quota_currency: text().notNull().default("USD"),
  quota_limit_minor: integer(),
  rate_limit_per_minute: integer().notNull().default(60),
  rate_limit_burst: integer().notNull().default(20),
  key_version: integer().notNull().default(1),
  revision: integer().notNull().default(1),
  time_created: integer().notNull().$default(() => Date.now()),
  time_updated: integer().notNull().$default(() => Date.now()),
})

export const TenantKeyTable = sqliteTable(
  "tenant_key",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    version: integer().notNull(),
    wrapped_key: text().notNull(),
    key_digest: text().notNull(),
    status: text().$type<"active" | "revoked">().notNull().default("active"),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.version] }),
    uniqueIndex("tenant_key_digest_idx").on(table.tenant_id, table.key_digest),
  ],
)

export const TenantSecretTable = sqliteTable(
  "tenant_secret",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    secret_id: text().notNull(),
    key_version: integer().notNull(),
    ciphertext: text().notNull(),
    fingerprint: text().notNull(),
    status: text().$type<"active" | "revoked">().notNull().default("active"),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
    revoked_at: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.secret_id] }),
    index("tenant_secret_status_idx").on(table.tenant_id, table.status),
  ],
)

export const TenantProjectMemberTable = sqliteTable(
  "tenant_project_member",
  {
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    project_id: text()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    role: text().$type<"admin" | "editor" | "viewer">().notNull().default("viewer"),
    status: text().$type<"active" | "suspended">().notNull().default("active"),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.user_id] }),
    index("tenant_project_member_tenant_idx").on(table.tenant_id, table.user_id, table.status),
  ],
)

export const TenantRateWindowTable = sqliteTable(
  "tenant_rate_window",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    bucket: text().notNull(),
    window_started_at: integer().notNull(),
    request_count: integer().notNull().default(0),
    byte_count: integer().notNull().default(0),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.tenant_id, table.bucket] })],
)

export const TenantUsageLedgerTable = sqliteTable(
  "tenant_usage_ledger",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "restrict" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    id: text().primaryKey(),
    settlement_id: text().notNull(),
    run_id: text().notNull(),
    currency: text().notNull(),
    amount_minor: integer().notNull(),
    source: text().$type<"settled-runtime-usage">().notNull().default("settled-runtime-usage"),
    recorded_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("tenant_usage_settlement_idx").on(table.tenant_id, table.settlement_id),
    index("tenant_usage_recorded_idx").on(table.tenant_id, table.recorded_at),
  ],
)

export const TenantDataRequestTable = sqliteTable(
  "tenant_data_request",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    id: text().primaryKey(),
    kind: text().$type<"tenant-export" | "tenant-delete">().notNull(),
    status: text()
      .$type<"requested" | "approved" | "executing" | "completed" | "rejected" | "failed">()
      .notNull()
      .default("requested"),
    requested_by: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    approved_by: text().references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    reason: text().notNull().default(""),
    request_digest: text().notNull(),
    requested_at: integer().notNull().$default(() => Date.now()),
    completed_at: integer(),
  },
  (table) => [
    index("tenant_data_request_status_idx").on(table.tenant_id, table.status, table.requested_at),
    uniqueIndex("tenant_data_request_digest_idx").on(table.tenant_id, table.request_digest),
  ],
)

export const TenantBackupManifestTable = sqliteTable(
  "tenant_backup_manifest",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    id: text().primaryKey(),
    region: text().notNull(),
    schema_revision: text().notNull(),
    artifact_digest: text().notNull(),
    status: text().$type<"created" | "verified" | "restored" | "failed">().notNull().default("created"),
    created_at: integer().notNull().$default(() => Date.now()),
    verified_at: integer(),
  },
  (table) => [
    index("tenant_backup_manifest_tenant_idx").on(table.tenant_id, table.created_at),
    uniqueIndex("tenant_backup_manifest_digest_idx").on(table.tenant_id, table.artifact_digest),
  ],
)

export const TenantAuditExportTable = sqliteTable(
  "tenant_audit_export",
  {
    ...OwnershipColumns,
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    owner_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    id: text().primaryKey(),
    requested_by: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    item_count: integer().notNull(),
    export_digest: text().notNull(),
    created_at: integer().notNull().$default(() => Date.now()),
  },
  (table) => [index("tenant_audit_export_tenant_idx").on(table.tenant_id, table.created_at)],
)
