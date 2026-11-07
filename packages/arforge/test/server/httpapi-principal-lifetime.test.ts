import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Database } from "@arforge-ai/core/database/database"
import { ServerAuth as NativeServerAuth } from "@arforge-ai/server/auth"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { UserAuth } from "@arforge-ai/server/user-auth"
import {
  Authorization as NativeAuthorization,
  authorizationLayer as nativeAuthorization,
} from "@arforge-ai/server/middleware/authorization"
import { ServerAuth } from "../../src/server/auth"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { Authorization, authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { makeAuthorizedBackground } from "../../src/server/routes/instance/httpapi/authorized-background"
import { testEffect } from "../lib/effect"

const info: UserAuth.Info = {
  mode: "users",
  secret: Option.some("test-only-principal-lifetime-secret-at-least-32"),
  publicUrl: "http://localhost",
  emailWebhookUrl: Option.none(),
  emailWebhookToken: Option.none(),
  exposeTokens: "true",
  trustProxy: "false",
}
// Only the transaction lifetime is real here. SQLite transports the production
// PostgreSQL principal scope with SET LOCAL intercepted; no PostgreSQL/RLS claim.
const databaseLayer = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const client = new Proxy(database.db.$client, {
      get(source, property, receiver) {
        if (property !== "unsafe") return Reflect.get(source, property, receiver)
        return (query: string, params: ReadonlyArray<unknown> = []) =>
          query.startsWith("SELECT set_config(") ? Effect.succeed([]) : source.unsafe(query, params)
      },
    })
    return Database.Service.of({ ...database, runAsPrincipal: Database.postgresPrincipalScope(client) })
  }),
).pipe(Layer.provide(Database.layerFromPath(":memory:")))
const it = testEffect(
  Layer.mergeAll(
    databaseLayer,
    UserAuth.Config.configLayer(info),
    ServerAuth.Config.configLayer({ password: Option.none(), username: "arforge" }),
    NativeServerAuth.Config.configLayer({ password: Option.none(), username: "arforge" }),
  ),
)
const authenticatedRequest = Effect.gen(function* () {
  const database = yield* Database.Service
  const registration = yield* UserAuth.register(database.db, info, {
    email: "lifetime@example.test",
    password: "test-only password for lifetime",
  })
  if (!registration.delivery) return yield* Effect.die("Expected test verification token")
  yield* UserAuth.verifyEmail(database.db, registration.delivery.token)
  const login = yield* UserAuth.login(database.db, info, {
    email: "lifetime@example.test",
    password: "test-only password for lifetime",
    ip: "127.0.0.1",
    userAgent: "lifetime-test",
  })
  if (!login.ok) return yield* Effect.die("Test login failed")
  return {
    principal: login.principal,
    request: HttpServerRequest.fromWeb(
      new Request("http://localhost/probe", { headers: { cookie: `${UserAuth.COOKIE_NAME}=${login.token}` } }),
    ),
  }
})

describe("Authorized execution lifetime", () => {
  for (const native of [false, true]) {
    it.live(
      `authenticated ${native ? "native" : "web"} middleware binds identity without enclosing execution in SQL`,
      () =>
        Effect.gen(function* () {
          const database = yield* Database.Service
          const { principal, request } = yield* authenticatedRequest
          const authorize = native
            ? Context.get(yield* Layer.build(nativeAuthorization), NativeAuthorization)
            : Context.get(yield* Layer.build(authorizationLayer), Authorization)
          const entered = yield* Deferred.make<boolean>()
          const release = yield* Deferred.make<void>()
          const waiting = yield* authorize(
            Effect.gen(function* () {
              expect(Context.getOption(yield* Effect.context(), IdentityContext.Current)).toEqual(
                Option.some(principal),
              )
              expect(yield* Database.CurrentPrincipal).toMatchObject({
                tenantID: principal.tenantID,
                userID: principal.userID,
              })
              yield* Deferred.succeed(
                entered,
                Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService)),
              )
              yield* Deferred.await(release)
              return HttpServerResponse.empty()
            }),
            { endpoint: HttpApiEndpoint.get("probe", "/probe"), group: HttpApiGroup.make("probe") },
          ).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
            Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
            Effect.provideService(HttpRouter.RouteContext, {
              params: {},
              route: HttpRouter.route("GET", "/probe", HttpServerResponse.empty()),
            }),
            Effect.forkChild,
          )
          expect(yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))).toBe(true)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(waiting)
        }),
    )
  }

  it.live("background launch waits for commit, drops expired runtime SQL, and discards rollback", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const principal = { ...IdentityContext.LocalPrincipal, tenantID: "ten_background", userID: "usr_background" }
      const entered = yield* Deferred.make<void>()
      const terminal = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      let runs = 0
      const background = yield* database.runAsPrincipal(principal, makeAuthorizedBackground)
      const work = Effect.gen(function* () {
        runs++
        expect(Option.isNone(yield* Effect.serviceOption(database.db.$client.transactionService))).toBe(true)
        expect(Context.getOption(yield* Effect.context(), IdentityContext.Current)).toEqual(Option.some(principal))
        expect(yield* Database.CurrentPrincipal).toEqual(principal)
        expect(yield* InstanceRef).toBeUndefined()
        expect(yield* WorkspaceRef).toBeUndefined()
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(terminal)
        yield* Deferred.succeed(done, undefined)
      })
      yield* database.runAsPrincipal(
        principal,
        Effect.gen(function* () {
          yield* background.launch(principal, work)
          yield* Effect.yieldNow
          expect(runs).toBe(0)
        }),
      )
      yield* Deferred.await(entered).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(terminal, undefined)
      yield* Deferred.await(done)
      const failed = yield* database
        .runAsPrincipal(
          principal,
          background
            .launch(
              principal,
              Effect.sync(() => {
                runs++
              }),
            )
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      yield* Effect.yieldNow
      expect(runs).toBe(1)
    }),
  )
})
