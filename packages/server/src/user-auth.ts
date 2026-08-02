export * as UserAuth from "./user-auth"

import { Database } from "@arforge-ai/core/database/database"
import {
  IdentityRateLimitTable,
  IdentitySessionTable,
  IdentityTenantMemberTable,
  IdentityTenantTable,
  IdentityTokenTable,
  IdentityUserTable,
} from "@arforge-ai/core/identity/sql"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { Config as EffectConfig, Context, Effect, Layer, Option } from "effect"
import { createHash, createHmac, randomBytes } from "node:crypto"
import type { IdentityContext } from "./identity-context"
import { usesPostgres } from "@arforge-ai/core/database/dialect"

export const COOKIE_NAME = "arforge_session"
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1_000
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1_000
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000

const LOGIN_WINDOW_MS = 15 * 60 * 1_000
const LOGIN_BLOCK_MS = 15 * 60 * 1_000
const LOGIN_ACCOUNT_LIMIT = 5
const LOGIN_IP_LIMIT = 20
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1_000
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$DslOhTbBqO3nFXkCIMCK7puUBUgiJZRsFoiJ+L+96LM$j2MMLIvQlEimqSHb4PyWD03mD1lQh+pr2lFyBR3cv84"

export type Info = {
  readonly mode: string
  readonly secret: Option.Option<string>
  readonly publicUrl: string
  readonly emailWebhookUrl: Option.Option<string>
  readonly emailWebhookToken: Option.Option<string>
  readonly exposeTokens: string
  readonly trustProxy: string
}

export class Config extends Context.Service<Config, Info>()("@arforge/UserAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      EffectConfig.all({
        mode: EffectConfig.string("ARFORGE_AUTH_MODE").pipe(EffectConfig.withDefault("private")),
        secret: EffectConfig.string("ARFORGE_AUTH_SECRET").pipe(EffectConfig.option),
        publicUrl: EffectConfig.string("ARFORGE_PUBLIC_URL").pipe(EffectConfig.withDefault("http://localhost")),
        emailWebhookUrl: EffectConfig.string("ARFORGE_AUTH_EMAIL_WEBHOOK_URL").pipe(EffectConfig.option),
        emailWebhookToken: EffectConfig.string("ARFORGE_AUTH_EMAIL_WEBHOOK_TOKEN").pipe(EffectConfig.option),
        exposeTokens: EffectConfig.string("ARFORGE_AUTH_EXPOSE_TOKENS").pipe(EffectConfig.withDefault("false")),
        trustProxy: EffectConfig.string("ARFORGE_TRUST_PROXY").pipe(EffectConfig.withDefault("false")),
      }).pipe(Effect.tap((config) => Effect.sync(() => validateConfig(config)))),
    )
  }

  static get privateLayer() {
    return this.configLayer({
      mode: "private",
      secret: Option.none(),
      publicUrl: "http://localhost",
      emailWebhookUrl: Option.none(),
      emailWebhookToken: Option.none(),
      exposeTokens: "false",
      trustProxy: "false",
    })
  }
}

type Store = Database.Interface["db"]
type Delivery = {
  readonly purpose: "verify_email" | "reset_password"
  readonly email: string
  readonly token: string
  readonly expiresAt: number
}

export type LoginResult =
  | {
      readonly ok: true
      readonly principal: IdentityContext.Principal
      readonly token: string
      readonly expiresAt: number
    }
  | { readonly ok: false; readonly reason: "invalid" | "unverified" | "blocked"; readonly retryAfter?: number }

export function enabled(config: Info) {
  return config.mode.trim().toLowerCase() === "users"
}

export function exposeTokens(config: Info) {
  return ["1", "true", "yes"].includes(config.exposeTokens.trim().toLowerCase())
}

export function trustProxy(config: Info) {
  return ["1", "true", "yes"].includes(config.trustProxy.trim().toLowerCase())
}

export function validateConfig(config: Info) {
  if (!enabled(config)) return
  const value = Option.getOrUndefined(config.secret)?.trim() ?? ""
  if (value.length < 32) throw new Error("ARFORGE_AUTH_SECRET must contain at least 32 characters in users mode")
  const url = new URL(config.publicUrl)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("ARFORGE_PUBLIC_URL must use HTTPS outside loopback development")
  }
  if (exposeTokens(config) && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("ARFORGE_AUTH_EXPOSE_TOKENS is allowed only for loopback development")
  }
  if (!usesPostgres && !exposeTokens(config)) {
    throw new Error(
      "ARFORGE_AUTH_MODE=users requires PostgreSQL; SQLite is allowed only for loopback development tests",
    )
  }
}

export function normalizeEmail(input: string) {
  return input.trim().normalize("NFKC").toLowerCase()
}

export function validEmail(input: string) {
  const email = normalizeEmail(input)
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export function validPassword(input: string) {
  return input.length >= 12 && input.length <= 256
}

export function register(
  db: Store,
  config: Info,
  input: { readonly email: string; readonly password: string; readonly displayName?: string },
  now = Date.now(),
) {
  return Effect.gen(function* () {
    validateConfig(config)
    const email = normalizeEmail(input.email)
    if (!validEmail(email)) return { accepted: false as const, field: "email" as const }
    if (!validPassword(input.password)) return { accepted: false as const, field: "password" as const }

    // Pay the same password-hashing cost before looking up the address. This
    // keeps duplicate-registration timing from becoming an account oracle.
    const passwordHash = yield* Effect.promise(() =>
      Bun.password.hash(input.password, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 }),
    )

    const existing = yield* db
      .select()
      .from(IdentityUserTable)
      .where(eq(IdentityUserTable.normalized_email, email))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (existing.status !== "pending") return { accepted: true as const }
      const delivery = verificationDelivery(existing.id, existing.email, now)
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(IdentityTokenTable)
            .set({ consumed_at: now })
            .where(
              and(
                eq(IdentityTokenTable.user_id, existing.id),
                eq(IdentityTokenTable.purpose, "verify_email"),
                isNull(IdentityTokenTable.consumed_at),
              ),
            )
            .run()
          yield* tx.insert(IdentityTokenTable).values(delivery.row).run()
        }),
      )
      return { accepted: true as const, delivery: delivery.public }
    }

    const userID = `usr_${crypto.randomUUID()}`
    const tenantID = `ten_${crypto.randomUUID()}`
    const delivery = verificationDelivery(userID, email, now)
    const displayName = input.displayName?.trim().slice(0, 120) || email.split("@", 1)[0] || "Arforge user"

    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(IdentityUserTable)
            .values({
              id: userID,
              email,
              normalized_email: email,
              display_name: displayName,
              password_hash: passwordHash,
              status: "pending",
              time_created: now,
              time_updated: now,
            })
            .run()
          yield* tx
            .insert(IdentityTenantTable)
            .values({
              id: tenantID,
              name: `${displayName}'s workspace`,
              slug: `personal-${userID.slice(-12)}`,
              created_by_user_id: userID,
              time_created: now,
              time_updated: now,
            })
            .run()
          yield* tx
            .insert(IdentityTenantMemberTable)
            .values({
              tenant_id: tenantID,
              user_id: userID,
              role: "owner",
              status: "active",
              time_created: now,
              time_updated: now,
            })
            .run()
          yield* tx.insert(IdentityTokenTable).values(delivery.row).run()
        }),
      )
      .pipe(Effect.orDie)
    return { accepted: true as const, delivery: delivery.public }
  })
}

export function verifyEmail(db: Store, token: string, now = Date.now()) {
  return consumeToken(db, token, "verify_email", now, (tx, userID) =>
    tx
      .update(IdentityUserTable)
      .set({ status: "active", email_verified_at: now, time_updated: now })
      .where(eq(IdentityUserTable.id, userID))
      .run(),
  )
}

export function requestPasswordReset(db: Store, input: { readonly email: string }, now = Date.now()) {
  return Effect.gen(function* () {
    const email = normalizeEmail(input.email)
    if (!validEmail(email)) return { accepted: true as const }
    const user = yield* db
      .select()
      .from(IdentityUserTable)
      .where(eq(IdentityUserTable.normalized_email, email))
      .get()
      .pipe(Effect.orDie)
    if (!user || user.status !== "active" || user.email_verified_at === null) return { accepted: true as const }
    const delivery = resetDelivery(user.id, user.email, now)
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .update(IdentityTokenTable)
            .set({ consumed_at: now })
            .where(
              and(
                eq(IdentityTokenTable.user_id, user.id),
                eq(IdentityTokenTable.purpose, "reset_password"),
                isNull(IdentityTokenTable.consumed_at),
              ),
            )
            .run()
          yield* tx.insert(IdentityTokenTable).values(delivery.row).run()
        }),
      )
      .pipe(Effect.orDie)
    return { accepted: true as const, delivery: delivery.public }
  })
}

export function resetPassword(db: Store, token: string, password: string, now = Date.now()) {
  return Effect.gen(function* () {
    if (!validPassword(password)) return { ok: false as const, field: "password" as const }
    const passwordHash = yield* Effect.promise(() =>
      Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 }),
    )
    const result = yield* consumeToken(db, token, "reset_password", now, (tx, userID) =>
      Effect.gen(function* () {
        yield* tx
          .update(IdentityUserTable)
          .set({
            password_hash: passwordHash,
            session_epoch: sql`${IdentityUserTable.session_epoch} + 1`,
            time_updated: now,
          })
          .where(eq(IdentityUserTable.id, userID))
          .run()
        yield* tx
          .update(IdentitySessionTable)
          .set({ revoked_at: now })
          .where(and(eq(IdentitySessionTable.user_id, userID), isNull(IdentitySessionTable.revoked_at)))
          .run()
      }),
    )
    return result ? { ok: true as const } : { ok: false as const, field: "token" as const }
  })
}

export function login(
  db: Store,
  config: Info,
  input: { readonly email: string; readonly password: string; readonly ip: string; readonly userAgent: string },
  now = Date.now(),
) {
  return Effect.gen(function* () {
    validateConfig(config)
    const email = normalizeEmail(input.email)
    const keys = rateKeys(config, email, input.ip)
    const blockedUntil = yield* blocked(db, keys, now)
    if (blockedUntil > now) {
      return { ok: false as const, reason: "blocked" as const, retryAfter: Math.ceil((blockedUntil - now) / 1_000) }
    }

    const user = validEmail(email)
      ? yield* db
          .select()
          .from(IdentityUserTable)
          .where(eq(IdentityUserTable.normalized_email, email))
          .get()
          .pipe(Effect.orDie)
      : undefined
    const passwordHash = user?.password_hash.startsWith("$argon2id$") ? user.password_hash : DUMMY_PASSWORD_HASH
    const matches = yield* Effect.promise(() => Bun.password.verify(input.password, passwordHash))
    if (!user || !matches || user.status === "disabled") {
      yield* recordFailures(db, keys, now)
      return { ok: false as const, reason: "invalid" as const }
    }
    if (user.status !== "active" || user.email_verified_at === null) {
      yield* recordFailures(db, keys, now)
      return { ok: false as const, reason: "unverified" as const }
    }

    const member = yield* db
      .select()
      .from(IdentityTenantMemberTable)
      .where(and(eq(IdentityTenantMemberTable.user_id, user.id), eq(IdentityTenantMemberTable.status, "active")))
      .get()
      .pipe(Effect.orDie)
    if (!member) {
      yield* recordFailures(db, keys, now)
      return { ok: false as const, reason: "invalid" as const }
    }

    yield* clearFailures(db, keys)
    const token = opaqueToken()
    const sessionID = `aus_${crypto.randomUUID()}`
    const expiresAt = now + SESSION_ABSOLUTE_TTL_MS
    const principal: IdentityContext.Principal = {
      userID: user.id,
      tenantID: member.tenant_id,
      email: user.email,
      role: member.role,
      sessionID,
    }
    yield* db
      .insert(IdentitySessionTable)
      .values({
        id: sessionID,
        user_id: user.id,
        tenant_id: member.tenant_id,
        token_hash: keyedDigest(token, authSecret(config)),
        session_epoch: user.session_epoch,
        user_agent_hash: keyedDigest(input.userAgent, authSecret(config)),
        ip_hash: keyedDigest(input.ip, authSecret(config)),
        expires_at: expiresAt,
        idle_expires_at: now + SESSION_IDLE_TTL_MS,
        last_seen_at: now,
        time_created: now,
      })
      .run()
      .pipe(Effect.orDie)
    return { ok: true as const, principal, token, expiresAt }
  }) satisfies Effect.Effect<LoginResult>
}

export function authenticate(db: Store, config: Info, cookieHeader: string | undefined, now = Date.now()) {
  return Effect.gen(function* () {
    validateConfig(config)
    const token = readToken(cookieHeader)
    if (!token) return Option.none<IdentityContext.Principal>()
    const row = yield* db
      .select({
        session: IdentitySessionTable,
        user: IdentityUserTable,
        member: IdentityTenantMemberTable,
      })
      .from(IdentitySessionTable)
      .innerJoin(IdentityUserTable, eq(IdentityUserTable.id, IdentitySessionTable.user_id))
      .innerJoin(
        IdentityTenantMemberTable,
        and(
          eq(IdentityTenantMemberTable.user_id, IdentitySessionTable.user_id),
          eq(IdentityTenantMemberTable.tenant_id, IdentitySessionTable.tenant_id),
        ),
      )
      .where(eq(IdentitySessionTable.token_hash, keyedDigest(token, authSecret(config))))
      .get()
      .pipe(Effect.orDie)
    if (
      !row ||
      row.session.revoked_at !== null ||
      row.session.expires_at <= now ||
      row.session.idle_expires_at <= now ||
      row.session.session_epoch !== row.user.session_epoch ||
      row.user.status !== "active" ||
      row.user.email_verified_at === null ||
      row.member.status !== "active"
    ) {
      return Option.none<IdentityContext.Principal>()
    }
    if (now - row.session.last_seen_at >= LAST_SEEN_WRITE_INTERVAL_MS) {
      yield* db
        .update(IdentitySessionTable)
        .set({ last_seen_at: now, idle_expires_at: Math.min(now + SESSION_IDLE_TTL_MS, row.session.expires_at) })
        .where(and(eq(IdentitySessionTable.id, row.session.id), isNull(IdentitySessionTable.revoked_at)))
        .run()
        .pipe(Effect.orDie)
    }
    return Option.some({
      userID: row.user.id,
      tenantID: row.session.tenant_id,
      email: row.user.email,
      role: row.member.role,
      sessionID: row.session.id,
    })
  })
}

export function logout(db: Store, config: Info, cookieHeader: string | undefined, now = Date.now()) {
  const token = readToken(cookieHeader)
  if (!token) return Effect.succeed(false)
  return db
    .update(IdentitySessionTable)
    .set({ revoked_at: now })
    .where(
      and(
        eq(IdentitySessionTable.token_hash, keyedDigest(token, authSecret(config))),
        isNull(IdentitySessionTable.revoked_at),
      ),
    )
    .returning({ id: IdentitySessionTable.id })
    .get()
    .pipe(Effect.map(Boolean), Effect.orDie)
}

export function logoutAll(db: Store, userID: string, now = Date.now()) {
  return db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx
        .update(IdentityUserTable)
        .set({ session_epoch: sql`${IdentityUserTable.session_epoch} + 1`, time_updated: now })
        .where(eq(IdentityUserTable.id, userID))
        .run()
      yield* tx
        .update(IdentitySessionTable)
        .set({ revoked_at: now })
        .where(and(eq(IdentitySessionTable.user_id, userID), isNull(IdentitySessionTable.revoked_at)))
        .run()
    }),
  )
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean, now = Date.now()) {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor((expiresAt - now) / 1_000))}`,
    secure ? "Secure" : undefined,
  ]
    .filter((item): item is string => !!item)
    .join("; ")
}

export function clearCookie(secure: boolean) {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : undefined,
  ]
    .filter((item): item is string => !!item)
    .join("; ")
}

export function secureForHost(host: string | undefined) {
  if (!host) return true
  const normalized = host.trim().toLowerCase()
  const hostname = normalized.startsWith("[") ? normalized.slice(1, normalized.indexOf("]")) : normalized.split(":")[0]
  return !(["localhost", "::1"].includes(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname))
}

export function sameOrigin(request: {
  readonly host?: string
  readonly url?: string
  readonly expectedOrigin?: string
  readonly method: string
  readonly origin?: string
}) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true
  const targetOrigin =
    request.expectedOrigin ?? (request.url && URL.canParse(request.url) ? new URL(request.url).origin : undefined)
  if (targetOrigin && request.origin && URL.canParse(request.origin)) {
    return new URL(request.origin).origin.toLowerCase() === new URL(targetOrigin).origin.toLowerCase()
  }
  const host = request.host ?? (request.url && URL.canParse(request.url) ? new URL(request.url).host : undefined)
  return (
    !!host &&
    !!request.origin &&
    URL.canParse(request.origin) &&
    new URL(request.origin).host.toLowerCase() === host.toLowerCase()
  )
}

export async function deliver(config: Info, delivery: Delivery) {
  validateConfig(config)
  const webhook = Option.getOrUndefined(config.emailWebhookUrl)
  if (!webhook) return exposeTokens(config)
  const action = delivery.purpose === "verify_email" ? "verify-email" : "reset-password"
  const url = new URL(config.publicUrl)
  url.searchParams.set(action === "verify-email" ? "verify_token" : "reset_token", delivery.token)
  const headers: Record<string, string> = { "content-type": "application/json" }
  const bearer = Option.getOrUndefined(config.emailWebhookToken)
  if (bearer) headers.authorization = `Bearer ${bearer}`
  const response = await fetch(webhook, {
    method: "POST",
    headers,
    body: JSON.stringify({
      template: action,
      to: delivery.email,
      actionUrl: url.toString(),
      expiresAt: new Date(delivery.expiresAt).toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  return response.ok
}

function verificationDelivery(userID: string, email: string, now: number) {
  return makeDelivery(userID, email, "verify_email", EMAIL_VERIFICATION_TTL_MS, now)
}

function resetDelivery(userID: string, email: string, now: number) {
  return makeDelivery(userID, email, "reset_password", PASSWORD_RESET_TTL_MS, now)
}

function makeDelivery(userID: string, email: string, purpose: Delivery["purpose"], ttl: number, now: number) {
  const token = opaqueToken()
  const expiresAt = now + ttl
  return {
    row: {
      id: `aut_${crypto.randomUUID()}`,
      user_id: userID,
      purpose,
      token_hash: tokenDigest(token),
      expires_at: expiresAt,
      time_created: now,
    },
    public: { purpose, email, token, expiresAt } satisfies Delivery,
  }
}

function consumeToken(
  db: Store,
  token: string,
  purpose: Delivery["purpose"],
  now: number,
  apply: (tx: Store, userID: string) => Effect.Effect<unknown, unknown>,
) {
  if (token.length < 32 || token.length > 256) return Effect.succeed(false)
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const row = yield* tx
          .select()
          .from(IdentityTokenTable)
          .where(
            and(
              eq(IdentityTokenTable.token_hash, tokenDigest(token)),
              eq(IdentityTokenTable.purpose, purpose),
              isNull(IdentityTokenTable.consumed_at),
            ),
          )
          .get()
        if (!row || row.expires_at <= now) return false
        const consumed = yield* tx
          .update(IdentityTokenTable)
          .set({ consumed_at: now })
          .where(and(eq(IdentityTokenTable.id, row.id), isNull(IdentityTokenTable.consumed_at)))
          .returning({ id: IdentityTokenTable.id })
          .get()
        if (!consumed) return false
        yield* apply(tx as unknown as Store, row.user_id)
        return true
      }),
    )
    .pipe(Effect.orDie)
}

function rateKeys(config: Info, email: string, ip: string) {
  const secret = authSecret(config)
  return [
    { bucket: "login_account", keyHash: keyedDigest(email, secret), limit: LOGIN_ACCOUNT_LIMIT },
    { bucket: "login_ip", keyHash: keyedDigest(ip || "unknown", secret), limit: LOGIN_IP_LIMIT },
  ] as const
}

function blocked(db: Store, keys: ReturnType<typeof rateKeys>, now: number) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(IdentityRateLimitTable)
      .where(
        or(
          ...keys.map((key) =>
            and(eq(IdentityRateLimitTable.bucket, key.bucket), eq(IdentityRateLimitTable.key_hash, key.keyHash)),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    return Math.max(now, ...rows.map((row) => row.blocked_until))
  })
}

function recordFailures(db: Store, keys: ReturnType<typeof rateKeys>, now: number) {
  return Effect.forEach(
    keys,
    (key) =>
      db.run(sql`
        INSERT INTO identity_rate_limit (bucket, key_hash, failures, window_started_at, blocked_until, time_updated)
        VALUES (${key.bucket}, ${key.keyHash}, 1, ${now}, 0, ${now})
        ON CONFLICT (bucket, key_hash) DO UPDATE SET
          failures = CASE
            WHEN ${now} - identity_rate_limit.window_started_at >= ${LOGIN_WINDOW_MS} THEN 1
            ELSE identity_rate_limit.failures + 1
          END,
          window_started_at = CASE
            WHEN ${now} - identity_rate_limit.window_started_at >= ${LOGIN_WINDOW_MS} THEN ${now}
            ELSE identity_rate_limit.window_started_at
          END,
          blocked_until = CASE
            WHEN (CASE
              WHEN ${now} - identity_rate_limit.window_started_at >= ${LOGIN_WINDOW_MS} THEN 1
              ELSE identity_rate_limit.failures + 1
            END) >= ${key.limit} THEN ${now + LOGIN_BLOCK_MS}
            ELSE identity_rate_limit.blocked_until
          END,
          time_updated = ${now}
      `),
    { concurrency: 1, discard: true },
  ).pipe(Effect.orDie)
}

function clearFailures(db: Store, keys: ReturnType<typeof rateKeys>) {
  return db
    .delete(IdentityRateLimitTable)
    .where(
      or(
        ...keys.map((key) =>
          and(eq(IdentityRateLimitTable.bucket, key.bucket), eq(IdentityRateLimitTable.key_hash, key.keyHash)),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie)
}

function authSecret(config: Info) {
  const secret = Option.getOrUndefined(config.secret)?.trim() ?? ""
  if (secret.length < 32) throw new Error("User authentication secret is unavailable")
  return secret
}

function opaqueToken() {
  return randomBytes(32).toString("base64url")
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function keyedDigest(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("hex")
}

function readToken(cookieHeader: string | undefined) {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === COOKIE_NAME)?.[1]
}
