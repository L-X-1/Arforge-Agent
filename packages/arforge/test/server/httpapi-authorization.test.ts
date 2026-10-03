import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  ServerAuthorization,
  serverAuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"
import { Database } from "@arforge-ai/core/database/database"
import { UserAuth } from "@arforge-ai/server/user-auth"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { LocalIdentityPrincipal } from "../../src/server/routes/instance/httpapi/middleware/authorization"

const PrincipalResponse = Schema.Struct({ tenantID: Schema.String, userID: Schema.String, sessionID: Schema.String })

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
      HttpApiEndpoint.get("principal", "/principal", {
        success: PrincipalResponse,
      }),
    )
    .middleware(Authorization),
)

const ServerApi = HttpApi.make("test-server-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(ServerAuthorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({})))
    .handle("principal", () =>
      Effect.gen(function* () {
        const current = yield* Effect.serviceOption(IdentityContext.Current)
        if (Option.isNone(current)) return yield* Effect.die("IdentityContext was not injected")
        const principal = current.value
        return {
          tenantID: principal.tenantID,
          userID: principal.userID,
          sessionID: principal.sessionID,
        }
      }),
    ),
)

const serverHandlers = HttpApiBuilder.group(ServerApi, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(ServerApi).pipe(Layer.provide(serverHandlers), Layer.provide(serverAuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.configLayer({ password: Option.none(), username: "arforge" })
const secretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "arforge" })
const kitSecretLayer = ServerAuth.Config.configLayer({ password: Option.some("secret"), username: "kit" })
const identityLayer = Layer.mergeAll(UserAuth.Config.privateLayer, Database.layerFromPath(":memory:"))
const userAuthConfig: UserAuth.Info = {
  mode: "users",
  secret: Option.some("test-only-auth-secret-with-at-least-32-characters"),
  publicUrl: "http://localhost",
  emailWebhookUrl: Option.none(),
  emailWebhookToken: Option.none(),
  exposeTokens: "true",
  trustProxy: "false",
}
const userIdentityLayer = Layer.mergeAll(
  UserAuth.Config.configLayer(userAuthConfig),
  Database.layerFromPath(":memory:"),
)

const it = testEffect(apiLayer.pipe(Layer.provide([noAuthLayer, identityLayer])))
const itSecret = testEffect(apiLayer.pipe(Layer.provide([secretLayer, identityLayer])))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide([kitSecretLayer, identityLayer])))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide([secretLayer, identityLayer])))
const itUsers = testEffect(
  Layer.merge(apiLayer.pipe(Layer.provide([noAuthLayer, userIdentityLayer])), userIdentityLayer),
)

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

const getPrincipal = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/principal").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  it.live("injects the stable server-owned principal in no-auth private mode", () =>
    Effect.gen(function* () {
      const response = yield* getPrincipal()
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        tenantID: LocalIdentityPrincipal.tenantID,
        userID: LocalIdentityPrincipal.userID,
        sessionID: LocalIdentityPrincipal.sessionID,
      })
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("arforge", "wrong") }),
          getProbe({ authorization: basic("arforge", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itSecret.live("injects the same server-owned principal only after valid Basic auth", () =>
    Effect.gen(function* () {
      const missing = yield* getPrincipal()
      expect(missing.status).toBe(401)
      const response = yield* getPrincipal({ authorization: basic("arforge", "secret") })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        tenantID: "ten_local",
        userID: "usr_local",
        sessionID: LocalIdentityPrincipal.sessionID,
      })
    }),
  )

  itUsers.live("injects the authenticated tenant member in user-auth mode", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const registered = yield* UserAuth.register(database.db, userAuthConfig, {
        email: "principal@example.test",
        password: "correct horse battery staple",
      })
      if (!registered.delivery) return yield* Effect.die("Expected a development verification token")
      expect(yield* UserAuth.verifyEmail(database.db, registered.delivery.token)).toBe(true)
      const login = yield* UserAuth.login(database.db, userAuthConfig, {
        email: "principal@example.test",
        password: "correct horse battery staple",
        ip: "127.0.0.1",
        userAgent: "authorization-test",
      })
      if (!login.ok) return yield* Effect.die(`Expected login, got ${login.reason}`)

      const response = yield* getPrincipal({ cookie: `${UserAuth.COOKIE_NAME}=${login.token}` })
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        tenantID: login.principal.tenantID,
        userID: login.principal.userID,
        sessionID: login.principal.sessionID,
      })
      expect(login.principal.tenantID).not.toBe(LocalIdentityPrincipal.tenantID)
      expect(login.principal.userID).not.toBe(LocalIdentityPrincipal.userID)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("arforge", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("arforge", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("arforge", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("arforge", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("arforge", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("arforge", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )
})
