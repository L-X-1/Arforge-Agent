import { Database } from "@arforge-ai/core/database/database"
import { SessionAuth } from "@arforge-ai/server/session-auth"
import { UserAuth } from "@arforge-ai/server/user-auth"
import { ServerAuth } from "@/server/auth"
import { Effect, Option, Redacted, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

const LoginInput = Schema.Struct({
  username: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  password: Schema.String,
})
const RegisterInput = Schema.Struct({
  email: Schema.String,
  password: Schema.String,
  displayName: Schema.optional(Schema.String),
})
const TokenInput = Schema.Struct({ token: Schema.String })
const ForgotInput = Schema.Struct({ email: Schema.String })
const ResetInput = Schema.Struct({ token: Schema.String, password: Schema.String })
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeLogin = Schema.decodeUnknownOption(LoginInput)
const decodeRegister = Schema.decodeUnknownOption(RegisterInput)
const decodeToken = Schema.decodeUnknownOption(TokenInput)
const decodeForgot = Schema.decodeUnknownOption(ForgotInput)
const decodeReset = Schema.decodeUnknownOption(ResetInput)
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_BLOCK_MS = 5 * 60 * 1000
const LOGIN_FAILURE_LIMIT = 5
const loginAttempts = new Map<string, { failures: number; windowStartedAt: number; blockedUntil: number }>()

export const privateAuthRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerAuth.Config
    const userConfig = yield* UserAuth.Config
    const { db } = yield* Database.Service

    yield* router.add("GET", "/auth/config", () =>
      Effect.succeed(
        json({
          mode: UserAuth.enabled(userConfig) ? "users" : "private",
          registrationEnabled: UserAuth.enabled(userConfig),
          passwordMinimumLength: UserAuth.enabled(userConfig) ? 12 : undefined,
        }),
      ),
    )

    yield* router.add("GET", "/auth/session", (request) =>
      Effect.gen(function* () {
        if (UserAuth.enabled(userConfig)) {
          const principal = yield* UserAuth.authenticate(db, userConfig, request.headers.cookie)
          return json(
            Option.match(principal, {
              onNone: () => ({ authenticated: false, sessionRequired: true, mode: "users" }),
              onSome: (value) => ({
                authenticated: true,
                sessionRequired: true,
                mode: "users",
                user: { id: value.userID, email: value.email },
                tenant: { id: value.tenantID, role: value.role },
              }),
            }),
          )
        }
        if (!ServerAuth.required(serverConfig)) {
          return json({ authenticated: true, sessionRequired: false, mode: "private" })
        }
        const session = SessionAuth.fromCookie(request.headers.cookie, serverConfig)
        return json(
          Option.match(session, {
            onNone: () => ({ authenticated: false, sessionRequired: true, mode: "private" }),
            onSome: (payload) => ({
              authenticated: true,
              sessionRequired: true,
              mode: "private",
              username: serverConfig.username,
              expiresAt: payload.expiresAt * 1000,
            }),
          }),
        )
      }),
    )

    yield* router.add("POST", "/auth/register", (request) =>
      Effect.gen(function* () {
        if (!UserAuth.enabled(userConfig)) return json({ accepted: false, error: "Registration unavailable" }, 404)
        const parsed = yield* parseBody(request, decodeRegister)
        if (Option.isNone(parsed)) return json({ accepted: false, error: "Invalid registration" }, 400)
        const result = yield* UserAuth.register(db, userConfig, parsed.value)
        if (!result.accepted) {
          return json(
            {
              accepted: false,
              error: result.field === "password" ? "Password must contain 12 to 256 characters" : "Invalid email",
              field: result.field,
            },
            400,
          )
        }
        if (result.delivery) {
          const delivered = yield* Effect.tryPromise({
            try: () => UserAuth.deliver(userConfig, result.delivery),
            catch: () => false,
          })
          if (!delivered) return json({ accepted: false, error: "Verification delivery unavailable" }, 503)
        }
        return json(
          {
            accepted: true,
            message: "If the address can be registered, a verification message has been sent.",
            ...(result.delivery && UserAuth.exposeTokens(userConfig)
              ? { developmentToken: result.delivery.token }
              : {}),
          },
          202,
        )
      }),
    )

    yield* router.add("POST", "/auth/verify-email", (request) =>
      Effect.gen(function* () {
        if (!UserAuth.enabled(userConfig)) return json({ verified: false }, 404)
        const parsed = yield* parseBody(request, decodeToken)
        if (Option.isNone(parsed)) return json({ verified: false, error: "Invalid or expired token" }, 400)
        const verified = yield* UserAuth.verifyEmail(db, parsed.value.token)
        return verified ? json({ verified: true }) : json({ verified: false, error: "Invalid or expired token" }, 400)
      }),
    )

    yield* router.add("POST", "/auth/forgot-password", (request) =>
      Effect.gen(function* () {
        if (!UserAuth.enabled(userConfig)) return json({ accepted: false }, 404)
        const parsed = yield* parseBody(request, decodeForgot)
        if (Option.isSome(parsed)) {
          const result = yield* UserAuth.requestPasswordReset(db, parsed.value)
          if (result.delivery) {
            yield* Effect.tryPromise({
              try: () => UserAuth.deliver(userConfig, result.delivery),
              catch: () => false,
            })
          }
          return json(
            {
              accepted: true,
              message: "If the account exists, a password reset message has been sent.",
              ...(result.delivery && UserAuth.exposeTokens(userConfig)
                ? { developmentToken: result.delivery.token }
                : {}),
            },
            202,
          )
        }
        return json({ accepted: true, message: "If the account exists, a password reset message has been sent." }, 202)
      }),
    )

    yield* router.add("POST", "/auth/reset-password", (request) =>
      Effect.gen(function* () {
        if (!UserAuth.enabled(userConfig)) return json({ reset: false }, 404)
        const parsed = yield* parseBody(request, decodeReset)
        if (Option.isNone(parsed)) return json({ reset: false, error: "Invalid request" }, 400)
        const result = yield* UserAuth.resetPassword(db, parsed.value.token, parsed.value.password)
        return result.ok
          ? json({ reset: true })
          : json(
              {
                reset: false,
                error:
                  result.field === "password"
                    ? "Password must contain 12 to 256 characters"
                    : "Invalid or expired token",
              },
              400,
            )
      }),
    )

    yield* router.add("POST", "/auth/login", (request) =>
      Effect.gen(function* () {
        const parsed = yield* parseBody(request, decodeLogin)
        if (Option.isNone(parsed)) return json({ authenticated: false, error: "Invalid credentials" }, 401)

        if (UserAuth.enabled(userConfig)) {
          const result = yield* UserAuth.login(db, userConfig, {
            email: parsed.value.email ?? parsed.value.username ?? "",
            password: parsed.value.password,
            ip: loginAttemptKey(UserAuth.trustProxy(userConfig) ? request.headers["x-forwarded-for"] : undefined),
            userAgent: request.headers["user-agent"] ?? "",
          })
          if (!result.ok) {
            const status = result.reason === "blocked" ? 429 : result.reason === "unverified" ? 403 : 401
            return json(
              {
                authenticated: false,
                error: result.reason === "unverified" ? "Email verification required" : "Invalid credentials",
              },
              status,
              result.retryAfter ? { "retry-after": String(result.retryAfter) } : undefined,
            )
          }
          return json(
            {
              authenticated: true,
              sessionRequired: true,
              mode: "users",
              user: { id: result.principal.userID, email: result.principal.email },
              tenant: { id: result.principal.tenantID, role: result.principal.role },
              expiresAt: result.expiresAt,
            },
            200,
            {
              "set-cookie": UserAuth.sessionCookie(
                result.token,
                result.expiresAt,
                UserAuth.secureForHost(request.headers.host),
              ),
            },
          )
        }

        if (!ServerAuth.required(serverConfig)) return json({ authenticated: true, sessionRequired: false })
        const attemptKey = loginAttemptKey(request.headers["x-forwarded-for"])
        const now = Date.now()
        const attempt = currentLoginAttempt(attemptKey, now)
        if (attempt.blockedUntil > now) {
          return json({ authenticated: false, error: "Invalid credentials" }, 429, {
            "retry-after": `${Math.ceil((attempt.blockedUntil - now) / 1000)}`,
          })
        }
        if (
          !ServerAuth.authorized(
            {
              username: parsed.value.username ?? "",
              password: Redacted.make(parsed.value.password),
            },
            serverConfig,
          )
        ) {
          recordLoginFailure(attemptKey, now)
          return json({ authenticated: false, error: "Invalid credentials" }, 401)
        }
        loginAttempts.delete(attemptKey)
        const session = SessionAuth.issue(serverConfig, { secure: SessionAuth.secureForHost(request.headers.host) })
        if (!session) return json({ authenticated: false, error: "Authentication unavailable" }, 503)
        return json(
          {
            authenticated: true,
            sessionRequired: true,
            mode: "private",
            username: serverConfig.username,
            expiresAt: session.expiresAt,
          },
          200,
          { "set-cookie": session.cookie },
        )
      }),
    )

    yield* router.add("POST", "/auth/logout", (request) =>
      Effect.gen(function* () {
        if (UserAuth.enabled(userConfig)) {
          if (
            !UserAuth.sameOrigin({
              host: request.headers.host ?? new URL(userConfig.publicUrl).host,
              url: request.url,
              expectedOrigin: new URL(userConfig.publicUrl).origin,
              method: request.method,
              origin: request.headers.origin,
            })
          ) {
            return json({ authenticated: false, error: "Origin required" }, 403)
          }
          yield* UserAuth.logout(db, userConfig, request.headers.cookie)
          return json({ authenticated: false, sessionRequired: true, mode: "users" }, 200, {
            "set-cookie": UserAuth.clearCookie(UserAuth.secureForHost(request.headers.host)),
          })
        }
        SessionAuth.revoke(request.headers.cookie, serverConfig)
        return json(
          { authenticated: false, sessionRequired: ServerAuth.required(serverConfig), mode: "private" },
          200,
          { "set-cookie": SessionAuth.clearCookie(SessionAuth.secureForHost(request.headers.host)) },
        )
      }),
    )

    yield* router.add("POST", "/auth/logout-all", (request) =>
      Effect.gen(function* () {
        if (!UserAuth.enabled(userConfig)) return json({ loggedOut: false }, 404)
        if (
          !UserAuth.sameOrigin({
            host: request.headers.host ?? new URL(userConfig.publicUrl).host,
            url: request.url,
            expectedOrigin: new URL(userConfig.publicUrl).origin,
            method: request.method,
            origin: request.headers.origin,
          })
        ) {
          return json({ loggedOut: false, error: "Origin required" }, 403)
        }
        const principal = yield* UserAuth.authenticate(db, userConfig, request.headers.cookie)
        if (Option.isNone(principal)) return json({ loggedOut: false }, 401)
        yield* UserAuth.logoutAll(db, principal.value.userID)
        return json({ loggedOut: true }, 200, {
          "set-cookie": UserAuth.clearCookie(UserAuth.secureForHost(request.headers.host)),
        })
      }),
    )
  }),
)

function parseBody<A>(
  request: { readonly headers: Record<string, string | undefined>; readonly text: Effect.Effect<string, unknown> },
  decode: (input: unknown) => Option.Option<A>,
) {
  if (Number(request.headers["content-length"] ?? 0) > 8_192) return Effect.succeed(Option.none<A>())
  return request.text.pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.map((text) => Option.flatMap(decodeJson(text), decode)),
  )
}

function loginAttemptKey(forwardedFor: string | undefined) {
  const forwarded = forwardedFor
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  return forwarded?.at(-1) ?? "direct"
}

function currentLoginAttempt(key: string, now: number) {
  for (const [candidate, attempt] of loginAttempts) {
    if (attempt.blockedUntil <= now && now - attempt.windowStartedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(candidate)
  }
  return loginAttempts.get(key) ?? { failures: 0, windowStartedAt: now, blockedUntil: 0 }
}

function recordLoginFailure(key: string, now: number) {
  const current = currentLoginAttempt(key, now)
  const failures = current.failures + 1
  loginAttempts.set(key, {
    failures,
    windowStartedAt: current.windowStartedAt,
    blockedUntil: failures >= LOGIN_FAILURE_LIMIT ? now + LOGIN_BLOCK_MS : current.blockedUntil,
  })
}

function json(body: unknown, status = 200, headers?: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  })
}
