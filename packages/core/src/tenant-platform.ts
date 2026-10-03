import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { and, asc, eq, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { isSqlError } from "effect/unstable/sql/SqlError"
import * as TenantSchema from "@arforge-ai/schema/tenant-platform"
import { Database, isDefaultLocalPrincipal } from "./database/database"
import { usesPostgres } from "./database/dialect"
import { IdentityTenantMemberTable, IdentityTenantTable, IdentityUserTable } from "./identity/sql"
import { AuditEntryTable } from "./runtime/sql"
import { SecretProvider } from "./secret-provider"
import { makeGlobalNode } from "./effect/app-node"
import {
  TenantAuditExportTable,
  TenantBackupManifestTable,
  TenantDataRequestTable,
  TenantKeyTable,
  TenantPolicyTable,
  TenantRateWindowTable,
  TenantSecretTable,
  TenantUsageLedgerTable,
} from "./tenant/sql"

export type Principal = {
  readonly tenantID: TenantSchema.TenantID
  readonly userID: TenantSchema.UserID
  readonly role: TenantSchema.TenantRole
}

export type SettledUsageInput = {
  readonly settlementID: string
  readonly runID: string
  readonly currency: string
  readonly amountMinor: number
}

export class AuthorizationError extends Schema.TaggedErrorClass<AuthorizationError>()(
  "TenantPlatform.AuthorizationError",
  {
    reason: Schema.String,
  },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("TenantPlatform.ConflictError", {
  reason: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TenantPlatform.NotFoundError", {
  resource: Schema.String,
}) {}

export class QuotaExceededError extends Schema.TaggedErrorClass<QuotaExceededError>()(
  "TenantPlatform.QuotaExceededError",
  {
    currency: Schema.String,
    limitMinor: Schema.Number,
    projectedMinor: Schema.Number,
  },
) {}

export class RateLimitedError extends Schema.TaggedErrorClass<RateLimitedError>()("TenantPlatform.RateLimitedError", {
  retryAfterSeconds: Schema.Number,
}) {}

export class InvalidManifestError extends Schema.TaggedErrorClass<InvalidManifestError>()(
  "TenantPlatform.InvalidManifestError",
  { reason: Schema.String },
) {}

const ADMIN_ROLES = new Set<TenantSchema.TenantRole>(["owner", "admin"])
const SECRET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const DIGEST = /^[a-f0-9]{64}$/
const MAX_SECRET_BYTES = 64 * 1024
const SCOPED_VALUE_PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/
const SCOPED_CIPHERTEXT_PREFIX = "v1."

const WRITE_TRANSACTION_RETRY_TIMES = 8
const WRITE_TRANSACTION_RETRY_BASE_MS = 25

/**
 * SQLite can surface a writer collision as a native `SQLiteError` defect
 * before the SQL adapter has a chance to wrap it as `SqlError`.  Both forms
 * are safe to retry here: the callback is a database-only transaction and a
 * failed transaction is rolled back before the next attempt.  Never broaden
 * this to arbitrary failures because callers may rely on typed errors and
 * external side effects must not be replayed by this helper.
 */
const isSqliteBusyError = (value: unknown): boolean => {
  if (isSqlError(value)) return value.reason._tag === "LockTimeoutError"
  if (typeof value === "string") return /(?:database is locked|SQLITE_(?:BUSY|LOCKED))/i.test(value)
  if (value instanceof Error) {
    const code = (value as Error & { readonly code?: unknown }).code
    return (
      code === "SQLITE_BUSY" ||
      code === "SQLITE_LOCKED" ||
      /(?:database is locked|SQLITE_(?:BUSY|LOCKED))/i.test(value.message)
    )
  }
  if (typeof value !== "object" || value === null) return false
  const tagged = value as { readonly _tag?: unknown; readonly cause?: unknown }
  if (tagged._tag === "LockTimeoutError") return true
  return tagged.cause !== undefined && tagged.cause !== value ? isSqliteBusyError(tagged.cause) : false
}

const isRetryableSqliteBusyCause = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasInterrupts(cause) &&
  cause.reasons.some((reason) => {
    if (Cause.isDieReason(reason)) return isSqliteBusyError(reason.defect)
    if (Cause.isFailReason(reason)) return isSqliteBusyError(reason.error)
    return false
  })

/** Retry only transient SQLite lock failures with a bounded backoff. */
const retrySqliteBusy = <A>(operation: Effect.Effect<A, unknown>) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const exit = yield* Effect.exit(operation)
      if (exit._tag === "Success") return exit.value
      if (!isRetryableSqliteBusyCause(exit.cause) || attempt >= WRITE_TRANSACTION_RETRY_TIMES)
        return yield* Effect.failCause(exit.cause)
      yield* Effect.sleep(`${WRITE_TRANSACTION_RETRY_BASE_MS * 2 ** attempt} millis`)
    }
  })

const nowISO = (now: number) => new Date(now).toISOString()
const newID = (prefix: string) => `${prefix}${crypto.randomUUID()}`
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export const roleAllows = (role: TenantSchema.TenantRole, required: "member" | "admin") =>
  required === "member" || ADMIN_ROLES.has(role)

export const requireRole = (principal: Principal, required: "member" | "admin") => {
  if (!roleAllows(principal.role, required))
    throw new AuthorizationError({ reason: `tenant role ${principal.role} cannot perform ${required} operation` })
}

export const requestDigest = (input: {
  readonly tenantID: string
  readonly kind: TenantSchema.DataRequestKind
  readonly reason: string
}) => digest(canonical({ domain: "arforge.tenant-data-request/v1", ...input }))

export const backupDigest = (input: {
  readonly tenantID: string
  readonly region: string
  readonly schemaRevision: string
  readonly artifactDigest: string
}) => digest(canonical({ domain: "arforge.tenant-backup/v1", ...input }))

export type RateDecision = {
  readonly allowed: boolean
  readonly retryAfterSeconds: number
  readonly remaining: number
  /** Remaining bytes in the durable artifact.read window, when byte accounting was requested. */
  readonly remainingBytes?: number
}

export const ARTIFACT_READ_BUCKET = "artifact.read"
export const ARTIFACT_READ_BYTES_PER_MINUTE = 64 * 1024 * 1024

export const decideRate = (input: {
  readonly requestCount: number
  readonly limit: number
  readonly burst: number
  readonly windowStartedAt: number
  readonly now: number
  readonly windowMs?: number
}): RateDecision => {
  const windowMs = input.windowMs ?? 60_000
  if (input.now - input.windowStartedAt >= windowMs)
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, input.burst - 1) }
  const capacity = Math.max(input.limit, input.burst)
  const allowed = input.requestCount < capacity
  return {
    allowed,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowMs - (input.now - input.windowStartedAt)) / 1_000)),
    remaining: Math.max(0, capacity - input.requestCount - (allowed ? 1 : 0)),
  }
}

export const settledOnly = (input: {
  readonly settlementID: string
  readonly tenantID: string
  readonly ownerUserID: string
  readonly runID: string
  readonly currency: string
  readonly amountMinor: number
}) => {
  if (!input.settlementID.trim() || !input.tenantID.trim() || !input.ownerUserID.trim() || !input.runID.trim())
    throw new ConflictError({ reason: "settled usage requires tenant, owner, run, and settlement identity" })
  if (
    input.settlementID.length > 160 ||
    input.tenantID.length > 160 ||
    input.ownerUserID.length > 160 ||
    input.runID.length > 160 ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor < 0
  )
    throw new ConflictError({ reason: "settled usage currency or amount is invalid" })
  return {
    settlement_id: input.settlementID,
    tenant_id: input.tenantID,
    owner_user_id: input.ownerUserID,
    run_id: input.runID,
    currency: input.currency,
    amount_minor: input.amountMinor,
    source: "settled-runtime-usage" as const,
  }
}

export const encryptTenantSecret = (key: Uint8Array, tenantID: string, version: number, plaintext: Uint8Array) => {
  if (key.byteLength !== 32) throw new Error("tenant key must be 32 bytes")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(`${tenantID}\0${version}`, "utf8"))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}

export const decryptTenantSecret = (key: Uint8Array, tenantID: string, version: number, ciphertext: string) => {
  if (key.byteLength !== 32) throw new Error("tenant key must be 32 bytes")
  const value = Buffer.from(ciphertext, "base64")
  if (value.byteLength < 28) throw new Error("tenant secret ciphertext is truncated")
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), value.subarray(0, 12))
  decipher.setAAD(Buffer.from(`${tenantID}\0${version}`, "utf8"))
  decipher.setAuthTag(value.subarray(12, 28))
  return new Uint8Array(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]))
}

const scopedValueAAD = (input: {
  readonly tenantID: string
  readonly ownerUserID: string
  readonly purpose: string
  readonly keyVersion: number
}) =>
  Buffer.from(
    canonical({
      domain: "arforge.tenant-scoped-value/v1",
      tenantID: input.tenantID,
      ownerUserID: input.ownerUserID,
      purpose: input.purpose,
      keyVersion: input.keyVersion,
    }),
    "utf8",
  )

export const encryptScopedTenantValue = (
  key: Uint8Array,
  input: {
    readonly tenantID: string
    readonly ownerUserID: string
    readonly purpose: string
    readonly keyVersion: number
    readonly plaintext: Uint8Array
  },
) => {
  if (key.byteLength !== 32) throw new Error("tenant key must be 32 bytes")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(scopedValueAAD(input))
  const encrypted = Buffer.concat([cipher.update(input.plaintext), cipher.final()])
  return `${SCOPED_CIPHERTEXT_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`
}

export const decryptScopedTenantValue = (
  key: Uint8Array,
  input: {
    readonly tenantID: string
    readonly ownerUserID: string
    readonly purpose: string
    readonly keyVersion: number
    readonly ciphertext: string
  },
) => {
  if (key.byteLength !== 32) throw new Error("tenant key must be 32 bytes")
  if (!input.ciphertext.startsWith(SCOPED_CIPHERTEXT_PREFIX))
    throw new Error("tenant value envelope version is invalid")
  const value = Buffer.from(input.ciphertext.slice(SCOPED_CIPHERTEXT_PREFIX.length), "base64")
  if (value.byteLength < 28) throw new Error("tenant value ciphertext is truncated")
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key), value.subarray(0, 12))
  decipher.setAAD(scopedValueAAD(input))
  decipher.setAuthTag(value.subarray(12, 28))
  return new Uint8Array(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]))
}

export type SealedScopedValue = {
  readonly keyVersion: number
  readonly ciphertext: string
  readonly fingerprint: string
}

const policyView = (row: typeof TenantPolicyTable.$inferSelect): TenantSchema.PlatformPolicy => ({
  schema_version: 1,
  tenant_id: row.tenant_id,
  region: row.region,
  retention_days: row.retention_days,
  quota: {
    currency: row.quota_currency,
    ...(row.quota_limit_minor === null ? {} : { limit_minor: row.quota_limit_minor }),
  },
  rate_limit: { requests_per_minute: row.rate_limit_per_minute, burst: row.rate_limit_burst },
  key_version: row.key_version,
  revision: row.revision,
  updated_at: nowISO(row.time_updated),
})

const usageView = (
  tenantID: string,
  currency: string,
  rows: ReadonlyArray<{ readonly amount_minor: number }>,
): TenantSchema.UsageSummary => ({
  tenant_id: tenantID,
  currency,
  settled_amount_minor: rows.reduce((sum, row) => sum + row.amount_minor, 0),
  settled_records: rows.length,
  source: "settled-runtime-usage",
})

export interface Interface {
  readonly overview: (principal: Principal) => Effect.Effect<TenantSchema.PlatformOverview, unknown>
  readonly setPolicy: (
    principal: Principal,
    input: Omit<TenantSchema.PlatformPolicy, "schema_version" | "tenant_id" | "revision" | "updated_at">,
  ) => Effect.Effect<TenantSchema.PlatformPolicy, unknown>
  readonly consumeRate: (
    principal: Principal,
    input?: { readonly bucket?: string; readonly now?: number; readonly bytes?: number },
  ) => Effect.Effect<RateDecision, unknown>
  readonly recordSettledUsage: (
    principal: Principal,
    input: SettledUsageInput,
  ) => Effect.Effect<TenantSchema.SettledUsage, unknown>
  readonly requestData: (
    principal: Principal,
    input: { readonly kind: TenantSchema.DataRequestKind; readonly reason: string },
  ) => Effect.Effect<TenantSchema.DataRequest, unknown>
  readonly approveData: (
    principal: Principal,
    input: { readonly requestID: string; readonly approve: boolean },
  ) => Effect.Effect<TenantSchema.DataRequest, unknown>
  readonly createBackup: (
    principal: Principal,
    input: { readonly region: string; readonly schemaRevision: string; readonly artifactDigest: string },
  ) => Effect.Effect<TenantSchema.BackupManifest, unknown>
  readonly verifyBackup: (
    principal: Principal,
    input: { readonly manifestID: string; readonly artifactDigest: string },
  ) => Effect.Effect<TenantSchema.BackupManifest, unknown>
  readonly exportAudit: (principal: Principal) => Effect.Effect<TenantSchema.AuditExport, unknown>
  readonly sealScopedValue: (
    principal: Principal,
    input: { readonly ownerUserID: string; readonly purpose: string; readonly plaintext: Uint8Array },
  ) => Effect.Effect<SealedScopedValue, unknown>
  readonly unsealScopedValue: (
    principal: Principal,
    input: {
      readonly ownerUserID: string
      readonly purpose: string
      readonly keyVersion: number
      readonly ciphertext: string
      readonly fingerprint: string
    },
  ) => Effect.Effect<Uint8Array, unknown>
  readonly listSecretMetadata: (
    principal: Principal,
  ) => Effect.Effect<ReadonlyArray<TenantSchema.SecretMetadata>, unknown>
  readonly putSecret: (
    principal: Principal,
    input: { readonly secretID: string; readonly plaintext: Uint8Array },
  ) => Effect.Effect<TenantSchema.SecretMetadata, unknown>
  readonly readSecret: (
    principal: Principal,
    input: { readonly secretID: string },
  ) => Effect.Effect<Uint8Array, unknown>
  readonly revokeSecret: (
    principal: Principal,
    input: { readonly secretID: string },
  ) => Effect.Effect<TenantSchema.SecretMetadata, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/TenantPlatform") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const secrets = yield* SecretProvider.Service

    const withPrincipal = <A>(principal: Principal, effect: Effect.Effect<A, unknown>) =>
      database.runAsPrincipal(
        principal,
        Effect.gen(function* () {
          if (principal.tenantID === "ten_local" && principal.userID === "usr_local" && principal.role === "owner") {
            // The default local principal is bootstrapped lazily.  Most calls
            // arrive after the bootstrap already exists (including independent
            // CLI workers), so keep this path read-only in the steady state.
            // That avoids turning every worker's first authenticated request
            // into an unnecessary SQLite writer race.
            const localMember = yield* retrySqliteBusy(
              database.db
                .select({ user_id: IdentityTenantMemberTable.user_id })
                .from(IdentityTenantMemberTable)
                .where(
                  and(
                    eq(IdentityTenantMemberTable.tenant_id, "ten_local"),
                    eq(IdentityTenantMemberTable.user_id, "usr_local"),
                    eq(IdentityTenantMemberTable.role, "owner"),
                    eq(IdentityTenantMemberTable.status, "active"),
                  ),
                )
                .get()
                .pipe(Effect.orDie),
            )
            if (!localMember) {
              const createdAt = Date.now()
              yield* database.db.transaction(
                (tx) =>
                  Effect.gen(function* () {
                    yield* tx
                      .insert(IdentityUserTable)
                      .values({
                        id: "usr_local",
                        email: "local@arforge.invalid",
                        normalized_email: "local@arforge.invalid",
                        display_name: "Local owner",
                        password_hash: "!",
                        status: "disabled",
                        email_verified_at: 0,
                        session_epoch: 0,
                        time_created: createdAt,
                        time_updated: createdAt,
                      })
                      .onConflictDoNothing()
                      .run()
                      .pipe(Effect.orDie)
                    yield* tx
                      .insert(IdentityTenantTable)
                      .values({
                        id: "ten_local",
                        name: "Local workspace",
                        slug: "local",
                        created_by_user_id: "usr_local",
                        time_created: createdAt,
                        time_updated: createdAt,
                      })
                      .onConflictDoNothing()
                      .run()
                      .pipe(Effect.orDie)
                    yield* tx
                      .insert(IdentityTenantMemberTable)
                      .values({
                        tenant_id: "ten_local",
                        user_id: "usr_local",
                        role: "owner",
                        status: "active",
                        time_created: createdAt,
                        time_updated: createdAt,
                      })
                      .onConflictDoNothing()
                      .run()
                      .pipe(Effect.orDie)
                  }),
                { behavior: "immediate" },
              )
            }
          }
          const member = yield* retrySqliteBusy(
            database.db
              .select()
              .from(IdentityTenantMemberTable)
              .where(
                and(
                  eq(IdentityTenantMemberTable.tenant_id, principal.tenantID),
                  eq(IdentityTenantMemberTable.user_id, principal.userID),
                  eq(IdentityTenantMemberTable.status, "active"),
                ),
              )
              .get()
              .pipe(Effect.orDie),
          )
          if (!member || member.role !== principal.role)
            return yield* new AuthorizationError({ reason: "authenticated principal is not an active tenant member" })
          return yield* effect
        }),
      )

    const policyFor = (principal: Principal) =>
      retrySqliteBusy(
        database.db
          .select()
          .from(TenantPolicyTable)
          .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
          .get()
          .pipe(Effect.orDie),
      )

    type TenantDatabase = Pick<typeof database.db, "select" | "insert" | "update" | "run">

    // Remote PostgreSQL requests already run inside the principal transaction.
    // The private/local PostgreSQL principal deliberately does not, so it must
    // open a short write transaction here or its xact advisory lock would be
    // released at the end of the SELECT statement. SQLite also needs an
    // explicit transaction and uses a no-op policy update as its writer lock.
    const withWriteTransaction = <A>(principal: Principal, body: (tx: TenantDatabase) => Effect.Effect<A, unknown>) => {
      const transaction =
        usesPostgres && !isDefaultLocalPrincipal(principal)
          ? body(database.db)
          : database.db.transaction((tx) => body(tx), { behavior: "immediate" })

      if (usesPostgres && !isDefaultLocalPrincipal(principal)) return transaction

      // The transaction has already rolled back before a lock error is
      // observed, so retrying this database-only callback cannot duplicate a
      // side effect.
      return retrySqliteBusy(transaction)
    }

    const lockTenant = (db: TenantDatabase, tenantID: string) =>
      usesPostgres
        ? db.run(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantID}, 0))`).pipe(Effect.orDie)
        : db
            .update(TenantPolicyTable)
            .set({ time_updated: sql`${TenantPolicyTable.time_updated}` })
            .where(eq(TenantPolicyTable.tenant_id, tenantID))
            .run()
            .pipe(Effect.orDie)

    const lockDataRequest = (db: TenantDatabase, tenantID: string, requestID: string) =>
      db
        .update(TenantDataRequestTable)
        .set({ reason: sql`${TenantDataRequestTable.reason}` })
        .where(and(eq(TenantDataRequestTable.tenant_id, tenantID), eq(TenantDataRequestTable.id, requestID)))
        .run()
        .pipe(Effect.orDie)

    const ensurePolicy = (principal: Principal, now: number) =>
      Effect.gen(function* () {
        const existing = yield* policyFor(principal)
        if (existing) return existing
        yield* database.db
          .insert(TenantPolicyTable)
          .values({
            tenant_id: principal.tenantID,
            owner_user_id: principal.userID,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const created = yield* policyFor(principal)
        if (!created) return yield* new NotFoundError({ resource: `tenant policy ${principal.tenantID}` })
        return created
      })

    const overview = (principal: Principal) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          const policy = yield* ensurePolicy(principal, Date.now())
          const usageRows = yield* database.db
            .select({ amount_minor: TenantUsageLedgerTable.amount_minor })
            .from(TenantUsageLedgerTable)
            .where(eq(TenantUsageLedgerTable.tenant_id, principal.tenantID))
            .all()
            .pipe(Effect.orDie)
          const requests = yield* database.db
            .select({ id: TenantDataRequestTable.id })
            .from(TenantDataRequestTable)
            .where(
              and(
                eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                eq(TenantDataRequestTable.status, "requested"),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          const windows = yield* database.db
            .select({ bucket: TenantRateWindowTable.bucket })
            .from(TenantRateWindowTable)
            .where(eq(TenantRateWindowTable.tenant_id, principal.tenantID))
            .all()
            .pipe(Effect.orDie)
          return {
            schema_version: 1 as const,
            policy: policyView(policy),
            usage: usageView(principal.tenantID, policy.quota_currency, usageRows),
            active_rate_window_count: windows.length,
            pending_requests: requests.length,
          }
        }),
      )

    const setPolicy = (
      principal: Principal,
      input: Omit<TenantSchema.PlatformPolicy, "schema_version" | "tenant_id" | "revision" | "updated_at">,
    ) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const region = input.region.trim()
          const currency = input.quota.currency.trim()
          const limitMinor = input.quota.limit_minor
          if (region.length < 1 || region.length > 64)
            return yield* new ConflictError({ reason: "region must contain 1 to 64 non-space characters" })
          if (!/^[A-Z]{3}$/.test(currency))
            return yield* new ConflictError({ reason: "quota currency must be ISO-4217 uppercase" })
          if (
            !Number.isSafeInteger(input.retention_days) ||
            input.retention_days < 1 ||
            input.retention_days > 3_650 ||
            (limitMinor !== undefined && (!Number.isSafeInteger(limitMinor) || limitMinor < 0)) ||
            !Number.isSafeInteger(input.rate_limit.requests_per_minute) ||
            input.rate_limit.requests_per_minute < 1 ||
            input.rate_limit.requests_per_minute > 1_000_000 ||
            !Number.isSafeInteger(input.rate_limit.burst) ||
            input.rate_limit.burst < 1 ||
            input.rate_limit.burst > 100_000 ||
            !Number.isSafeInteger(input.key_version) ||
            input.key_version < 1
          )
            return yield* new ConflictError({ reason: "tenant policy contains an out-of-range value" })
          yield* ensurePolicy(principal, Date.now())
          return yield* withWriteTransaction(principal, (tx) =>
            Effect.gen(function* () {
              yield* lockTenant(tx, principal.tenantID)
              const current = yield* tx
                .select()
                .from(TenantPolicyTable)
                .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
                .get()
                .pipe(Effect.orDie)
              if (!current) return yield* new NotFoundError({ resource: `tenant policy ${principal.tenantID}` })
              if (input.key_version < current.key_version)
                return yield* new ConflictError({ reason: "tenant key version cannot be rolled back" })
              const nextRevision = current.revision + 1
              yield* tx
                .update(TenantPolicyTable)
                .set({
                  owner_user_id: principal.userID,
                  region,
                  retention_days: input.retention_days,
                  quota_currency: currency,
                  quota_limit_minor: limitMinor ?? null,
                  rate_limit_per_minute: input.rate_limit.requests_per_minute,
                  rate_limit_burst: input.rate_limit.burst,
                  key_version: input.key_version,
                  revision: nextRevision,
                  time_updated: Date.now(),
                })
                .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
                .run()
                .pipe(Effect.orDie)
              const updated = yield* tx
                .select()
                .from(TenantPolicyTable)
                .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ resource: `tenant policy ${principal.tenantID}` })
              return policyView(updated)
            }),
          )
        }),
      )

    const consumeRate = (
      principal: Principal,
      input: { readonly bucket?: string; readonly now?: number; readonly bytes?: number } = {},
    ) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          const now = input.now ?? Date.now()
          const bucket = input.bucket?.trim() || "api"
          if (!/^[A-Za-z0-9._:-]{1,80}$/.test(bucket))
            return yield* new ConflictError({ reason: "rate bucket is invalid" })
          if (!Number.isSafeInteger(now) || now < 0)
            return yield* new ConflictError({ reason: "rate timestamp must be a non-negative safe integer" })
          const bytes = input.bytes ?? 0
          if (!Number.isSafeInteger(bytes) || bytes < 0)
            return yield* new ConflictError({ reason: "rate byte cost must be a non-negative safe integer" })
          const byteLimit = bucket === ARTIFACT_READ_BUCKET ? ARTIFACT_READ_BYTES_PER_MINUTE : undefined
          if (byteLimit !== undefined && bytes > byteLimit)
            return yield* new ConflictError({ reason: "artifact read byte cost exceeds the durable window limit" })
          yield* ensurePolicy(principal, now)
          return yield* withWriteTransaction(principal, (tx) =>
            Effect.gen(function* () {
              yield* lockTenant(tx, principal.tenantID)
              const policy = yield* tx
                .select()
                .from(TenantPolicyTable)
                .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
                .get()
                .pipe(Effect.orDie)
              if (!policy) return yield* new NotFoundError({ resource: `tenant policy ${principal.tenantID}` })
              const existing = yield* tx
                .select()
                .from(TenantRateWindowTable)
                .where(
                  and(
                    eq(TenantRateWindowTable.tenant_id, principal.tenantID),
                    eq(TenantRateWindowTable.bucket, bucket),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              const decision = decideRate({
                requestCount: existing?.request_count ?? 0,
                limit: policy.rate_limit_per_minute,
                burst: policy.rate_limit_burst,
                windowStartedAt: existing?.window_started_at ?? now,
                now,
              })
              if (!decision.allowed)
                return yield* new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds })
              const reset = now - (existing?.window_started_at ?? now) >= 60_000
              const previousBytes = reset ? 0 : existing?.byte_count ?? 0
              const projectedBytes = previousBytes + bytes
              if (!Number.isSafeInteger(projectedBytes))
                return yield* new ConflictError({ reason: "rate byte counter would exceed safe integer range" })
              if (byteLimit !== undefined && projectedBytes > byteLimit)
                return yield* new RateLimitedError({
                  retryAfterSeconds: Math.max(
                    1,
                    Math.ceil((60_000 - Math.max(0, now - (existing?.window_started_at ?? now))) / 1_000),
                  ),
                })
              if (!existing) {
                yield* tx
                  .insert(TenantRateWindowTable)
                  .values({
                    tenant_id: principal.tenantID,
                    owner_user_id: principal.userID,
                    bucket,
                    window_started_at: now,
                    request_count: 1,
                    byte_count: bytes,
                    time_updated: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
              } else {
                yield* tx
                  .update(TenantRateWindowTable)
                  .set({
                    owner_user_id: principal.userID,
                    window_started_at: reset ? now : existing.window_started_at,
                    request_count: reset ? 1 : existing.request_count + 1,
                    byte_count: reset ? bytes : existing.byte_count + bytes,
                    time_updated: now,
                  })
                  .where(
                    and(
                      eq(TenantRateWindowTable.tenant_id, principal.tenantID),
                      eq(TenantRateWindowTable.bucket, bucket),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
              }
              return {
                ...decision,
                ...(byteLimit === undefined
                  ? {}
                  : { remainingBytes: Math.max(0, byteLimit - projectedBytes) }),
              }
            }),
          )
        }),
      )

    const recordSettledUsage = (principal: Principal, input: SettledUsageInput) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          const safe = settledOnly({ ...input, tenantID: principal.tenantID, ownerUserID: principal.userID })
          yield* ensurePolicy(principal, Date.now())
          return yield* withWriteTransaction(principal, (tx) =>
            Effect.gen(function* () {
              yield* lockTenant(tx, principal.tenantID)
              const policy = yield* tx
                .select()
                .from(TenantPolicyTable)
                .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
                .get()
                .pipe(Effect.orDie)
              if (!policy) return yield* new NotFoundError({ resource: `tenant policy ${principal.tenantID}` })
              if (policy.quota_currency !== input.currency)
                return yield* new ConflictError({
                  reason: "settled usage currency does not match tenant quota currency",
                })
              const existing = yield* tx
                .select()
                .from(TenantUsageLedgerTable)
                .where(
                  and(
                    eq(TenantUsageLedgerTable.tenant_id, principal.tenantID),
                    eq(TenantUsageLedgerTable.settlement_id, input.settlementID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (existing) {
                if (
                  existing.run_id !== input.runID ||
                  existing.currency !== input.currency ||
                  existing.amount_minor !== input.amountMinor
                )
                  return yield* new ConflictError({ reason: "settlement identity is already bound to different usage" })
                return {
                  settlement_id: existing.settlement_id,
                  tenant_id: existing.tenant_id,
                  owner_user_id: existing.owner_user_id,
                  run_id: existing.run_id,
                  currency: existing.currency,
                  amount_minor: existing.amount_minor,
                  recorded_at: nowISO(existing.recorded_at),
                  source: "settled-runtime-usage" as const,
                }
              }
              const usageRows = yield* tx
                .select({ amount_minor: TenantUsageLedgerTable.amount_minor })
                .from(TenantUsageLedgerTable)
                .where(eq(TenantUsageLedgerTable.tenant_id, principal.tenantID))
                .all()
                .pipe(Effect.orDie)
              const projectedMinor = usageRows.reduce((sum, row) => sum + row.amount_minor, 0) + input.amountMinor
              if (!Number.isSafeInteger(projectedMinor))
                return yield* new ConflictError({ reason: "settled usage total exceeds supported integer range" })
              if (policy.quota_limit_minor !== null && projectedMinor > policy.quota_limit_minor)
                return yield* new QuotaExceededError({
                  currency: input.currency,
                  limitMinor: policy.quota_limit_minor,
                  projectedMinor,
                })
              const recordedAt = Date.now()
              yield* tx
                .insert(TenantUsageLedgerTable)
                .values({
                  id: newID("tul_"),
                  ...safe,
                  recorded_at: recordedAt,
                })
                .run()
                .pipe(Effect.orDie)
              return { ...safe, recorded_at: nowISO(recordedAt) } satisfies TenantSchema.SettledUsage
            }),
          )
        }),
      )

    const requestData = (
      principal: Principal,
      input: { readonly kind: TenantSchema.DataRequestKind; readonly reason: string },
    ) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          const reason = input.reason.trim()
          if (!reason) return yield* new ConflictError({ reason: "data request reason cannot be empty" })
          if (reason.length > 1_000)
            return yield* new ConflictError({ reason: "data request reason must be at most 1000 characters" })
          if (input.kind !== "tenant-export" && input.kind !== "tenant-delete")
            return yield* new ConflictError({ reason: "data request kind is invalid" })
          const requestDigestValue = requestDigest({ tenantID: principal.tenantID, kind: input.kind, reason })
          const existing = yield* database.db
            .select()
            .from(TenantDataRequestTable)
            .where(
              and(
                eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                eq(TenantDataRequestTable.request_digest, requestDigestValue),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (existing) return dataRequestView(existing)
          const requestedAt = Date.now()
          const id = newID("tdr_")
          yield* database.db
            .insert(TenantDataRequestTable)
            .values({
              tenant_id: principal.tenantID,
              owner_user_id: principal.userID,
              id,
              kind: input.kind,
              requested_by: principal.userID,
              reason,
              request_digest: requestDigestValue,
              requested_at: requestedAt,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const row = yield* database.db
            .select()
            .from(TenantDataRequestTable)
            .where(
              and(
                eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                eq(TenantDataRequestTable.request_digest, requestDigestValue),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `data request ${requestDigestValue}` })
          return dataRequestView(row)
        }),
      )

    const approveData = (principal: Principal, input: { readonly requestID: string; readonly approve: boolean }) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          return yield* withWriteTransaction(principal, (tx) =>
            Effect.gen(function* () {
              yield* lockDataRequest(tx, principal.tenantID, input.requestID)
              const row = yield* tx
                .select()
                .from(TenantDataRequestTable)
                .where(
                  and(
                    eq(TenantDataRequestTable.id, input.requestID),
                    eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* new NotFoundError({ resource: `data request ${input.requestID}` })
              if (row.status === "approved" && input.approve) return dataRequestView(row)
              if (row.status === "rejected" && !input.approve) return dataRequestView(row)
              if (row.status !== "requested")
                return yield* new ConflictError({ reason: `data request ${input.requestID} is already terminal` })
              const status = input.approve ? "approved" : "rejected"
              yield* tx
                .update(TenantDataRequestTable)
                // The legacy column stores the administrator who made either terminal
                // decision. Public responses only expose it as approved_by for an
                // approval; audit artifacts project it under the neutral decided_by.
                .set({ status, approved_by: principal.userID })
                .where(
                  and(
                    eq(TenantDataRequestTable.id, input.requestID),
                    eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
              const updated = yield* tx
                .select()
                .from(TenantDataRequestTable)
                .where(
                  and(
                    eq(TenantDataRequestTable.id, input.requestID),
                    eq(TenantDataRequestTable.tenant_id, principal.tenantID),
                  ),
                )
                .get()
                .pipe(Effect.orDie)
              if (!updated) return yield* new NotFoundError({ resource: `data request ${input.requestID}` })
              return dataRequestView(updated)
            }),
          )
        }),
      )

    const createBackup = (
      principal: Principal,
      input: { readonly region: string; readonly schemaRevision: string; readonly artifactDigest: string },
    ) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const region = input.region.trim()
          const schemaRevision = input.schemaRevision.trim()
          if (region.length < 1 || region.length > 64 || schemaRevision.length < 1 || schemaRevision.length > 160)
            return yield* new InvalidManifestError({ reason: "backup region or schema revision is invalid" })
          if (!DIGEST.test(input.artifactDigest))
            return yield* new InvalidManifestError({ reason: "artifact digest must be sha256" })
          const policy = yield* ensurePolicy(principal, Date.now())
          if (region !== policy.region)
            return yield* new InvalidManifestError({ reason: "backup region must match the tenant data-region policy" })
          const bindingDigest = backupDigest({
            tenantID: principal.tenantID,
            region,
            schemaRevision,
            artifactDigest: input.artifactDigest,
          })
          const existing = yield* database.db
            .select()
            .from(TenantBackupManifestTable)
            .where(
              and(
                eq(TenantBackupManifestTable.tenant_id, principal.tenantID),
                eq(TenantBackupManifestTable.artifact_digest, input.artifactDigest),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            const existingBinding = backupDigest({
              tenantID: existing.tenant_id,
              region: existing.region,
              schemaRevision: existing.schema_revision,
              artifactDigest: existing.artifact_digest,
            })
            if (existingBinding !== bindingDigest)
              return yield* new InvalidManifestError({
                reason: "backup artifact digest is already bound to different manifest metadata",
              })
            return backupView(existing)
          }
          const createdAt = Date.now()
          const id = newID("tbk_")
          yield* database.db
            .insert(TenantBackupManifestTable)
            .values({
              tenant_id: principal.tenantID,
              owner_user_id: principal.userID,
              id,
              region,
              schema_revision: schemaRevision,
              artifact_digest: input.artifactDigest,
              status: "created",
              created_at: createdAt,
            })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          const row = yield* database.db
            .select()
            .from(TenantBackupManifestTable)
            .where(
              and(
                eq(TenantBackupManifestTable.tenant_id, principal.tenantID),
                eq(TenantBackupManifestTable.artifact_digest, input.artifactDigest),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `backup manifest ${input.artifactDigest}` })
          const storedBinding = backupDigest({
            tenantID: row.tenant_id,
            region: row.region,
            schemaRevision: row.schema_revision,
            artifactDigest: row.artifact_digest,
          })
          if (storedBinding !== bindingDigest)
            return yield* new InvalidManifestError({
              reason: "backup artifact digest was concurrently bound to different manifest metadata",
            })
          return backupView(row)
        }),
      )

    const verifyBackup = (
      principal: Principal,
      input: { readonly manifestID: string; readonly artifactDigest: string },
    ) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const row = yield* database.db
            .select()
            .from(TenantBackupManifestTable)
            .where(
              and(
                eq(TenantBackupManifestTable.id, input.manifestID),
                eq(TenantBackupManifestTable.tenant_id, principal.tenantID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `backup manifest ${input.manifestID}` })
          if (row.artifact_digest !== input.artifactDigest)
            return yield* new InvalidManifestError({ reason: "backup artifact digest does not match manifest" })
          if (row.status === "verified" || row.status === "restored") return backupView(row)
          const verifiedAt = Date.now()
          yield* database.db
            .update(TenantBackupManifestTable)
            .set({ status: "verified", verified_at: verifiedAt })
            .where(
              and(
                eq(TenantBackupManifestTable.id, input.manifestID),
                eq(TenantBackupManifestTable.tenant_id, principal.tenantID),
              ),
            )
            .run()
            .pipe(Effect.orDie)
          return backupView({ ...row, status: "verified", verified_at: verifiedAt })
        }),
      )

    const exportAudit = (principal: Principal) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const runtimeRows = yield* database.db
            .select({
              id: AuditEntryTable.id,
              seq: AuditEntryTable.seq,
              recorded_at: AuditEntryTable.recorded_at,
              actor: AuditEntryTable.actor,
              action: AuditEntryTable.action,
              resource: AuditEntryTable.resource,
              previous_hash: AuditEntryTable.previous_hash,
              record_hash: AuditEntryTable.record_hash,
            })
            .from(AuditEntryTable)
            .where(eq(AuditEntryTable.tenant_id, principal.tenantID))
            .orderBy(asc(AuditEntryTable.seq))
            .all()
            .pipe(Effect.orDie)
          // Tenant governance mutates durable platform tables directly rather
          // than going through the runtime insight singleton. Include their
          // safe projections in the export so a tenant with policy, secret,
          // usage, request, backup, or earlier export activity does not receive
          // an empty audit receipt. Never include secret ciphertext or request
          // plaintext.
          const [policies, keys, secrets, usage, requests, backups, auditExports] = yield* Effect.all([
            database.db
              .select({
                tenant_id: TenantPolicyTable.tenant_id,
                owner_user_id: TenantPolicyTable.owner_user_id,
                region: TenantPolicyTable.region,
                retention_days: TenantPolicyTable.retention_days,
                quota_currency: TenantPolicyTable.quota_currency,
                quota_limit_minor: TenantPolicyTable.quota_limit_minor,
                rate_limit_per_minute: TenantPolicyTable.rate_limit_per_minute,
                rate_limit_burst: TenantPolicyTable.rate_limit_burst,
                key_version: TenantPolicyTable.key_version,
                revision: TenantPolicyTable.revision,
                time_created: TenantPolicyTable.time_created,
                time_updated: TenantPolicyTable.time_updated,
              })
              .from(TenantPolicyTable)
              .where(eq(TenantPolicyTable.tenant_id, principal.tenantID))
              .all(),
            database.db
              .select({
                version: TenantKeyTable.version,
                key_digest: TenantKeyTable.key_digest,
                status: TenantKeyTable.status,
                time_created: TenantKeyTable.time_created,
                time_updated: TenantKeyTable.time_updated,
              })
              .from(TenantKeyTable)
              .where(eq(TenantKeyTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantKeyTable.version))
              .all(),
            database.db
              .select({
                secret_id: TenantSecretTable.secret_id,
                key_version: TenantSecretTable.key_version,
                fingerprint: TenantSecretTable.fingerprint,
                ciphertext: TenantSecretTable.ciphertext,
                status: TenantSecretTable.status,
                time_created: TenantSecretTable.time_created,
                time_updated: TenantSecretTable.time_updated,
                revoked_at: TenantSecretTable.revoked_at,
              })
              .from(TenantSecretTable)
              .where(eq(TenantSecretTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantSecretTable.time_created), asc(TenantSecretTable.secret_id))
              .all(),
            database.db
              .select({
                settlement_id: TenantUsageLedgerTable.settlement_id,
                run_id: TenantUsageLedgerTable.run_id,
                currency: TenantUsageLedgerTable.currency,
                amount_minor: TenantUsageLedgerTable.amount_minor,
                source: TenantUsageLedgerTable.source,
                recorded_at: TenantUsageLedgerTable.recorded_at,
              })
              .from(TenantUsageLedgerTable)
              .where(eq(TenantUsageLedgerTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantUsageLedgerTable.recorded_at), asc(TenantUsageLedgerTable.settlement_id))
              .all(),
            database.db
              .select({
                id: TenantDataRequestTable.id,
                kind: TenantDataRequestTable.kind,
                status: TenantDataRequestTable.status,
                requested_by: TenantDataRequestTable.requested_by,
                decided_by: TenantDataRequestTable.approved_by,
                reason: TenantDataRequestTable.reason,
                request_digest: TenantDataRequestTable.request_digest,
                requested_at: TenantDataRequestTable.requested_at,
                completed_at: TenantDataRequestTable.completed_at,
              })
              .from(TenantDataRequestTable)
              .where(eq(TenantDataRequestTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantDataRequestTable.requested_at), asc(TenantDataRequestTable.id))
              .all(),
            database.db
              .select({
                id: TenantBackupManifestTable.id,
                region: TenantBackupManifestTable.region,
                schema_revision: TenantBackupManifestTable.schema_revision,
                artifact_digest: TenantBackupManifestTable.artifact_digest,
                status: TenantBackupManifestTable.status,
                created_at: TenantBackupManifestTable.created_at,
                verified_at: TenantBackupManifestTable.verified_at,
              })
              .from(TenantBackupManifestTable)
              .where(eq(TenantBackupManifestTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantBackupManifestTable.created_at), asc(TenantBackupManifestTable.id))
              .all(),
            database.db
              .select({
                id: TenantAuditExportTable.id,
                requested_by: TenantAuditExportTable.requested_by,
                item_count: TenantAuditExportTable.item_count,
                export_digest: TenantAuditExportTable.export_digest,
                created_at: TenantAuditExportTable.created_at,
              })
              .from(TenantAuditExportTable)
              .where(eq(TenantAuditExportTable.tenant_id, principal.tenantID))
              .orderBy(asc(TenantAuditExportTable.created_at), asc(TenantAuditExportTable.id))
              .all(),
          ]).pipe(Effect.orDie)
          const invalidSecretEnvelope = secrets.find(
            (row) => row.ciphertext.startsWith(SCOPED_CIPHERTEXT_PREFIX) && row.fingerprint !== digest(row.ciphertext),
          )
          if (invalidSecretEnvelope)
            return yield* new ConflictError({
              reason: `tenant secret ${invalidSecretEnvelope.secret_id} failed integrity check`,
            })
          const tenantRows = [
            ...policies.map((row) => ({ source: "tenant_policy", ...row })),
            ...keys.map((row) => ({ source: "tenant_key", ...row })),
            ...secrets.map(({ ciphertext, fingerprint: _fingerprint, ...row }) => ({
              source: "tenant_secret_metadata",
              ...row,
              fingerprint: digest(ciphertext),
            })),
            ...usage.map((row) => ({ ...row, source: "settled_usage" as const })),
            ...requests.map(({ reason, ...row }) => ({
              source: "tenant_data_request",
              ...row,
              reason_digest: digest(reason),
            })),
            ...backups.map((row) => ({ source: "tenant_backup_manifest", ...row })),
            ...auditExports.map((row) => ({ source: "tenant_audit_export", ...row })),
          ]
          const rows = [...runtimeRows.map((row) => ({ source: "runtime_audit", ...row })), ...tenantRows]
          const createdAt = Date.now()
          const id = newID("tae_")
          const artifactJson = canonical({
            schema_version: 1,
            tenant_id: principal.tenantID,
            export_id: id,
            requested_by: principal.userID,
            created_at: nowISO(createdAt),
            rows,
          })
          const exportDigest = digest(artifactJson)
          yield* database.db
            .insert(TenantAuditExportTable)
            .values({
              tenant_id: principal.tenantID,
              owner_user_id: principal.userID,
              id,
              requested_by: principal.userID,
              item_count: rows.length,
              export_digest: exportDigest,
              created_at: createdAt,
            })
            .run()
            .pipe(Effect.orDie)
          return {
            id,
            tenant_id: principal.tenantID,
            requested_by: principal.userID,
            item_count: rows.length,
            export_digest: exportDigest,
            created_at: nowISO(createdAt),
            artifact_filename: `arforge-tenant-audit-${id}.json`,
            artifact_media_type: "application/json",
            artifact_json: artifactJson,
          } satisfies TenantSchema.AuditExport
        }),
      )

    const ensureKey = (principal: Principal, version: number) =>
      Effect.gen(function* () {
        const row = yield* database.db
          .select()
          .from(TenantKeyTable)
          .where(and(eq(TenantKeyTable.tenant_id, principal.tenantID), eq(TenantKeyTable.version, version)))
          .get()
          .pipe(Effect.orDie)
        if (row) return row
        const raw = randomBytes(32)
        const wrapped = yield* secrets.protect(raw)
        const keyDigest = digest(raw)
        yield* database.db
          .insert(TenantKeyTable)
          .values({
            tenant_id: principal.tenantID,
            owner_user_id: principal.userID,
            version,
            wrapped_key: wrapped,
            key_digest: keyDigest,
            status: "active",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const created = yield* database.db
          .select()
          .from(TenantKeyTable)
          .where(and(eq(TenantKeyTable.tenant_id, principal.tenantID), eq(TenantKeyTable.version, version)))
          .get()
          .pipe(Effect.orDie)
        if (!created) return yield* new NotFoundError({ resource: `tenant key ${principal.tenantID}/${version}` })
        return created
      })

    const unwrapKey = (row: typeof TenantKeyTable.$inferSelect) =>
      Effect.gen(function* () {
        const raw = yield* secrets.unprotect(row.wrapped_key)
        if (digest(raw) !== row.key_digest || row.status !== "active")
          return yield* new ConflictError({ reason: "tenant key integrity or status check failed" })
        return raw
      })

    const keyBytes = (principal: Principal, version: number) =>
      ensureKey(principal, version).pipe(Effect.flatMap(unwrapKey))

    const existingKeyBytes = (principal: Principal, version: number) =>
      Effect.gen(function* () {
        const row = yield* database.db
          .select()
          .from(TenantKeyTable)
          .where(and(eq(TenantKeyTable.tenant_id, principal.tenantID), eq(TenantKeyTable.version, version)))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* new ConflictError({ reason: "tenant key required by the encrypted value is missing" })
        return yield* unwrapKey(row)
      })

    const validateScopedValue = (
      principal: Principal,
      input: { readonly ownerUserID: string; readonly purpose: string },
    ) => {
      if (input.ownerUserID !== principal.userID && !ADMIN_ROLES.has(principal.role))
        throw new AuthorizationError({ reason: "tenant value belongs to a different user" })
      if (!SCOPED_VALUE_PURPOSE.test(input.purpose))
        throw new ConflictError({ reason: "tenant value purpose is invalid" })
    }

    const sealForPrincipal = (
      principal: Principal,
      input: { readonly ownerUserID: string; readonly purpose: string; readonly plaintext: Uint8Array },
    ) =>
      Effect.gen(function* () {
        validateScopedValue(principal, input)
        if (input.plaintext.byteLength > MAX_SECRET_BYTES)
          return yield* new ConflictError({ reason: `tenant value must be at most ${MAX_SECRET_BYTES} bytes` })
        const policy = yield* ensurePolicy(principal, Date.now())
        const key = yield* keyBytes(principal, policy.key_version)
        const ciphertext = encryptScopedTenantValue(key, {
          tenantID: principal.tenantID,
          ownerUserID: input.ownerUserID,
          purpose: input.purpose,
          keyVersion: policy.key_version,
          plaintext: input.plaintext,
        })
        return {
          keyVersion: policy.key_version,
          ciphertext,
          fingerprint: digest(ciphertext),
        } satisfies SealedScopedValue
      })

    const unsealForPrincipal = (
      principal: Principal,
      input: {
        readonly ownerUserID: string
        readonly purpose: string
        readonly keyVersion: number
        readonly ciphertext: string
        readonly fingerprint: string
      },
    ) =>
      Effect.gen(function* () {
        validateScopedValue(principal, input)
        if (
          !Number.isSafeInteger(input.keyVersion) ||
          input.keyVersion < 1 ||
          !DIGEST.test(input.fingerprint) ||
          input.ciphertext.length > (MAX_SECRET_BYTES + 64) * 2 ||
          digest(input.ciphertext) !== input.fingerprint
        )
          return yield* new ConflictError({ reason: "tenant value envelope failed integrity validation" })
        const key = yield* existingKeyBytes(principal, input.keyVersion)
        try {
          return decryptScopedTenantValue(key, {
            tenantID: principal.tenantID,
            ownerUserID: input.ownerUserID,
            purpose: input.purpose,
            keyVersion: input.keyVersion,
            ciphertext: input.ciphertext,
          })
        } catch {
          return yield* new ConflictError({ reason: "tenant value envelope could not be authenticated" })
        }
      })

    const sealScopedValue: Interface["sealScopedValue"] = (principal, input) =>
      withPrincipal(principal, sealForPrincipal(principal, input))

    const unsealScopedValue: Interface["unsealScopedValue"] = (principal, input) =>
      withPrincipal(principal, unsealForPrincipal(principal, input))

    const listSecretMetadata = (principal: Principal) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          const rows = yield* database.db
            .select()
            .from(TenantSecretTable)
            .where(eq(TenantSecretTable.tenant_id, principal.tenantID))
            .all()
            .pipe(Effect.orDie)
          const invalid = rows.find(
            (row) => row.ciphertext.startsWith(SCOPED_CIPHERTEXT_PREFIX) && row.fingerprint !== digest(row.ciphertext),
          )
          if (invalid)
            return yield* new ConflictError({ reason: `tenant secret ${invalid.secret_id} failed integrity check` })
          return rows.map(secretView)
        }),
      )

    const putSecret = (principal: Principal, input: { readonly secretID: string; readonly plaintext: Uint8Array }) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          if (!SECRET_ID.test(input.secretID)) return yield* new ConflictError({ reason: "secret ID is invalid" })
          if (input.plaintext.byteLength > MAX_SECRET_BYTES)
            return yield* new ConflictError({ reason: `tenant secret must be at most ${MAX_SECRET_BYTES} bytes` })
          const sealed = yield* sealForPrincipal(principal, {
            ownerUserID: principal.userID,
            purpose: `tenant-secret:${input.secretID}`,
            plaintext: input.plaintext,
          })
          const time = Date.now()
          yield* database.db
            .insert(TenantSecretTable)
            .values({
              tenant_id: principal.tenantID,
              owner_user_id: principal.userID,
              secret_id: input.secretID,
              key_version: sealed.keyVersion,
              ciphertext: sealed.ciphertext,
              fingerprint: sealed.fingerprint,
              status: "active",
              time_created: time,
              time_updated: time,
              revoked_at: null,
            })
            .onConflictDoUpdate({
              target: [TenantSecretTable.tenant_id, TenantSecretTable.secret_id],
              set: {
                owner_user_id: principal.userID,
                key_version: sealed.keyVersion,
                ciphertext: sealed.ciphertext,
                fingerprint: sealed.fingerprint,
                status: "active",
                time_updated: time,
                revoked_at: null,
              },
            })
            .run()
            .pipe(Effect.orDie)
          const row = yield* database.db
            .select()
            .from(TenantSecretTable)
            .where(
              and(eq(TenantSecretTable.tenant_id, principal.tenantID), eq(TenantSecretTable.secret_id, input.secretID)),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `tenant secret ${input.secretID}` })
          return secretView(row)
        }),
      )

    const readSecret = (principal: Principal, input: { readonly secretID: string }) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const row = yield* database.db
            .select()
            .from(TenantSecretTable)
            .where(
              and(
                eq(TenantSecretTable.tenant_id, principal.tenantID),
                eq(TenantSecretTable.secret_id, input.secretID),
                eq(TenantSecretTable.status, "active"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `tenant secret ${input.secretID}` })
          if (row.ciphertext.startsWith(SCOPED_CIPHERTEXT_PREFIX))
            return yield* unsealForPrincipal(principal, {
              ownerUserID: row.owner_user_id,
              purpose: `tenant-secret:${row.secret_id}`,
              keyVersion: row.key_version,
              ciphertext: row.ciphertext,
              fingerprint: row.fingerprint,
            })
          try {
            const key = yield* existingKeyBytes(principal, row.key_version)
            const plaintext = decryptTenantSecret(key, principal.tenantID, row.key_version, row.ciphertext)
            if (digest(plaintext) !== row.fingerprint)
              return yield* new ConflictError({ reason: "legacy tenant secret failed integrity validation" })
            return plaintext
          } catch {
            return yield* new ConflictError({ reason: "legacy tenant secret could not be authenticated" })
          }
        }),
      )

    const revokeSecret = (principal: Principal, input: { readonly secretID: string }) =>
      withPrincipal(
        principal,
        Effect.gen(function* () {
          requireRole(principal, "admin")
          const revokedAt = Date.now()
          yield* database.db
            .update(TenantSecretTable)
            .set({ status: "revoked", revoked_at: revokedAt, time_updated: revokedAt })
            .where(
              and(eq(TenantSecretTable.tenant_id, principal.tenantID), eq(TenantSecretTable.secret_id, input.secretID)),
            )
            .run()
            .pipe(Effect.orDie)
          const row = yield* database.db
            .select()
            .from(TenantSecretTable)
            .where(
              and(eq(TenantSecretTable.tenant_id, principal.tenantID), eq(TenantSecretTable.secret_id, input.secretID)),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new NotFoundError({ resource: `tenant secret ${input.secretID}` })
          return secretView(row)
        }),
      )

    return {
      overview,
      setPolicy,
      consumeRate,
      recordSettledUsage,
      requestData,
      approveData,
      createBackup,
      verifyBackup,
      exportAudit,
      sealScopedValue,
      unsealScopedValue,
      listSecretMetadata,
      putSecret,
      readSecret,
      revokeSecret,
    } satisfies Interface
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SecretProvider.node] })

const dataRequestView = (row: typeof TenantDataRequestTable.$inferSelect): TenantSchema.DataRequest => ({
  id: row.id,
  tenant_id: row.tenant_id,
  kind: row.kind,
  status: row.status,
  requested_by: row.requested_by,
  ...(row.status === "approved" && row.approved_by !== null ? { approved_by: row.approved_by } : {}),
  reason: row.reason,
  request_digest: row.request_digest,
  requested_at: nowISO(row.requested_at),
  ...(row.completed_at === null ? {} : { completed_at: nowISO(row.completed_at) }),
})

const backupView = (row: typeof TenantBackupManifestTable.$inferSelect): TenantSchema.BackupManifest => ({
  id: row.id,
  tenant_id: row.tenant_id,
  region: row.region,
  schema_revision: row.schema_revision,
  artifact_digest: row.artifact_digest,
  status: row.status,
  created_at: nowISO(row.created_at),
  ...(row.verified_at === null ? {} : { verified_at: nowISO(row.verified_at) }),
})

const secretView = (row: typeof TenantSecretTable.$inferSelect): TenantSchema.SecretMetadata => ({
  tenant_id: row.tenant_id,
  secret_id: row.secret_id,
  key_version: row.key_version,
  fingerprint: digest(row.ciphertext),
  status: row.status,
  created_at: nowISO(row.time_created),
  ...(row.revoked_at === null ? {} : { revoked_at: nowISO(row.revoked_at) }),
})
