import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "../database/dialect"
import { Timestamps } from "../database/schema.sql"

export const LOCAL_USER_ID = "usr_local"
export const LOCAL_TENANT_ID = "ten_local"

/**
 * Business tables carry ownership even in the embedded single-owner edition.
 * PostgreSQL replaces these static defaults with request-scoped settings in the
 * production migration; SQLite intentionally keeps the local owner defaults.
 */
export const OwnershipColumns = {
  tenant_id: text().notNull().default(LOCAL_TENANT_ID),
  owner_user_id: text().notNull().default(LOCAL_USER_ID),
}

export const IdentityUserTable = sqliteTable(
  "identity_user",
  {
    id: text().primaryKey(),
    email: text().notNull(),
    normalized_email: text().notNull(),
    display_name: text().notNull().default(""),
    password_hash: text().notNull(),
    status: text().$type<"pending" | "active" | "disabled">().notNull().default("pending"),
    email_verified_at: integer(),
    session_epoch: integer().notNull().default(0),
    ...Timestamps,
  },
  (table) => [uniqueIndex("identity_user_normalized_email_idx").on(table.normalized_email)],
)

export const IdentityTenantTable = sqliteTable(
  "identity_tenant",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    slug: text().notNull(),
    created_by_user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "restrict" }),
    ...Timestamps,
  },
  (table) => [uniqueIndex("identity_tenant_slug_idx").on(table.slug)],
)

export const IdentityTenantMemberTable = sqliteTable(
  "identity_tenant_member",
  {
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    role: text().$type<"owner" | "admin" | "member">().notNull().default("member"),
    status: text().$type<"active" | "suspended">().notNull().default("active"),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenant_id, table.user_id] }),
    index("identity_tenant_member_user_idx").on(table.user_id, table.status),
  ],
)

export const IdentityTokenTable = sqliteTable(
  "identity_token",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    purpose: text().$type<"verify_email" | "reset_password">().notNull(),
    token_hash: text().notNull(),
    expires_at: integer().notNull(),
    consumed_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("identity_token_hash_idx").on(table.token_hash),
    index("identity_token_user_purpose_idx").on(table.user_id, table.purpose, table.expires_at),
  ],
)

export const IdentitySessionTable = sqliteTable(
  "identity_session",
  {
    id: text().primaryKey(),
    user_id: text()
      .notNull()
      .references(() => IdentityUserTable.id, { onDelete: "cascade" }),
    tenant_id: text()
      .notNull()
      .references(() => IdentityTenantTable.id, { onDelete: "cascade" }),
    token_hash: text().notNull(),
    session_epoch: integer().notNull(),
    user_agent_hash: text().notNull().default(""),
    ip_hash: text().notNull().default(""),
    expires_at: integer().notNull(),
    idle_expires_at: integer().notNull(),
    last_seen_at: integer().notNull(),
    revoked_at: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("identity_session_token_hash_idx").on(table.token_hash),
    index("identity_session_user_active_idx").on(table.user_id, table.revoked_at, table.expires_at),
    index("identity_session_tenant_idx").on(table.tenant_id, table.expires_at),
  ],
)

export const IdentityRateLimitTable = sqliteTable(
  "identity_rate_limit",
  {
    bucket: text().notNull(),
    key_hash: text().notNull(),
    failures: integer().notNull().default(0),
    window_started_at: integer().notNull(),
    blocked_until: integer().notNull().default(0),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.key_hash] }),
    index("identity_rate_limit_expiry_idx").on(table.blocked_until),
  ],
)
