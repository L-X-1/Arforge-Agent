import { describe, expect, test } from "bun:test"
import { Database } from "@arforge-ai/core/database/database"
import {
  IdentityRateLimitTable,
  IdentitySessionTable,
  IdentityTokenTable,
  IdentityUserTable,
} from "@arforge-ai/core/identity/sql"
import { Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { UserAuth } from "./user-auth"

const config: UserAuth.Info = {
  mode: "users",
  secret: Option.some("test-only-auth-secret-with-at-least-32-characters"),
  publicUrl: "http://localhost:4096",
  emailWebhookUrl: Option.none(),
  emailWebhookToken: Option.none(),
  exposeTokens: "true",
  trustProxy: "false",
}

function run<A, E>(effect: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped))
}

describe("UserAuth", () => {
  test("rejects unsafe production configuration and cross-origin mutations", () => {
    expect(() =>
      UserAuth.validateConfig({
        ...config,
        publicUrl: "http://arforge.example.com",
        exposeTokens: "false",
      }),
    ).toThrow("must use HTTPS")
    expect(() =>
      UserAuth.validateConfig({
        ...config,
        publicUrl: "https://arforge.example.com",
        exposeTokens: "true",
      }),
    ).toThrow("loopback")
    expect(UserAuth.sameOrigin({ method: "GET" })).toBe(true)
    expect(UserAuth.sameOrigin({ method: "POST", url: "https://arforge.example.com/api", origin: undefined })).toBe(
      false,
    )
    expect(
      UserAuth.sameOrigin({
        method: "POST",
        url: "https://arforge.example.com/api",
        origin: "https://attacker.example",
      }),
    ).toBe(false)
    expect(
      UserAuth.sameOrigin({
        method: "POST",
        url: "https://arforge.example.com/api",
        origin: "http://arforge.example.com",
      }),
    ).toBe(false)
    expect(
      UserAuth.sameOrigin({
        method: "POST",
        url: "https://arforge.example.com/api",
        origin: "https://arforge.example.com",
      }),
    ).toBe(true)
  })

  test("registers, verifies, persists a session, and globally logs out", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const registered = yield* UserAuth.register(
          db,
          config,
          { email: " Owner@Example.COM ", password: "correct horse battery staple", displayName: "Owner" },
          1_000,
        )
        expect(registered.accepted).toBe(true)
        if (!registered.accepted || !registered.delivery) throw new Error("Expected verification delivery")

        const user = yield* db.select().from(IdentityUserTable).get().pipe(Effect.orDie)
        expect(user?.normalized_email).toBe("owner@example.com")
        expect(user?.password_hash).toStartWith("$argon2id$")
        expect(user?.password_hash).not.toContain("correct horse")
        const storedToken = yield* db.select().from(IdentityTokenTable).get().pipe(Effect.orDie)
        expect(storedToken?.token_hash).not.toBe(registered.delivery.token)
        expect(storedToken?.token_hash).toHaveLength(64)

        expect(yield* UserAuth.verifyEmail(db, registered.delivery.token, 2_000)).toBe(true)
        expect(yield* UserAuth.verifyEmail(db, registered.delivery.token, 2_001)).toBe(false)

        const login = yield* UserAuth.login(
          db,
          config,
          {
            email: "owner@example.com",
            password: "correct horse battery staple",
            ip: "127.0.0.1",
            userAgent: "test",
          },
          3_000,
        )
        expect(login.ok).toBe(true)
        if (!login.ok) throw new Error("Expected login")
        const cookie = UserAuth.sessionCookie(login.token, login.expiresAt, false, 3_000).split(";", 1)[0]
        const principal = yield* UserAuth.authenticate(db, config, cookie, 4_000)
        expect(Option.getOrUndefined(principal)).toMatchObject({
          userID: login.principal.userID,
          tenantID: login.principal.tenantID,
          email: "owner@example.com",
          role: "owner",
        })

        yield* UserAuth.logoutAll(db, login.principal.userID, 5_000)
        expect(Option.isNone(yield* UserAuth.authenticate(db, config, cookie, 5_001))).toBe(true)
      }),
    )
  })

  test("uses single-use reset tokens and revokes every existing session", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const registered = yield* UserAuth.register(
          db,
          config,
          { email: "reset@example.com", password: "first secure password" },
          10_000,
        )
        if (!registered.accepted || !registered.delivery) throw new Error("Expected verification delivery")
        yield* UserAuth.verifyEmail(db, registered.delivery.token, 11_000)
        const login = yield* UserAuth.login(
          db,
          config,
          { email: "reset@example.com", password: "first secure password", ip: "direct", userAgent: "test" },
          12_000,
        )
        if (!login.ok) throw new Error("Expected login")
        const cookie = `${UserAuth.COOKIE_NAME}=${login.token}`
        const request = yield* UserAuth.requestPasswordReset(db, { email: "reset@example.com" }, 13_000)
        if (!request.delivery) throw new Error("Expected reset delivery")

        expect(yield* UserAuth.resetPassword(db, request.delivery.token, "second secure password", 14_000)).toEqual({
          ok: true,
        })
        expect(yield* UserAuth.resetPassword(db, request.delivery.token, "third secure password", 14_001)).toEqual({
          ok: false,
          field: "token",
        })
        expect(Option.isNone(yield* UserAuth.authenticate(db, config, cookie, 14_002))).toBe(true)
        const active = yield* db
          .select()
          .from(IdentitySessionTable)
          .where(eq(IdentitySessionTable.user_id, login.principal.userID))
          .all()
          .pipe(Effect.orDie)
        expect(active.every((session) => session.revoked_at !== null)).toBe(true)
      }),
    )
  })

  test("persists account and IP login throttles in the database", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const result = yield* UserAuth.login(
            db,
            config,
            { email: "missing@example.com", password: "not the password", ip: "203.0.113.9", userAgent: "test" },
            20_000 + attempt,
          )
          expect(result).toMatchObject({ ok: false, reason: "invalid" })
        }
        const blocked = yield* UserAuth.login(
          db,
          config,
          { email: "missing@example.com", password: "not the password", ip: "203.0.113.9", userAgent: "test" },
          20_010,
        )
        expect(blocked).toMatchObject({ ok: false, reason: "blocked" })
        expect((yield* db.select().from(IdentityRateLimitTable).all().pipe(Effect.orDie)).length).toBe(2)
      }),
    )
  })
})
