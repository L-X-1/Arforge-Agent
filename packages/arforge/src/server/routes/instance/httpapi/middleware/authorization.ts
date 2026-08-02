import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { hasPtyConnectTicketURL } from "@/server/shared/pty-ticket"
import { isPublicUIPath } from "@/server/shared/public-ui"
import { SessionAuth } from "@arforge-ai/server/session-auth"
import { UserAuth } from "@arforge-ai/server/user-auth"
import { IdentityContext } from "@arforge-ai/server/identity-context"
import { Database } from "@arforge-ai/core/database/database"
import { Option } from "effect"
export {
  Authorization as ServerAuthorization,
  authorizationLayer as serverAuthorizationLayer,
} from "@arforge-ai/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function sessionAuthorized(request: HttpServerRequest.HttpServerRequest, config: ServerAuth.Info) {
  return SessionAuth.requestAuthorized(
    {
      cookie: request.headers.cookie,
      host: request.headers.host,
      method: request.method,
      origin: request.headers.origin,
    },
    config,
  )
}

function userAuthorized<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  config: UserAuth.Info,
  database: Database.Interface,
) {
  return Effect.gen(function* () {
    if (
      !UserAuth.sameOrigin({
        host: request.headers.host ?? new URL(config.publicUrl).host,
        url: request.url,
        expectedOrigin: new URL(config.publicUrl).origin,
        method: request.method,
        origin: request.headers.origin,
      })
    )
      return yield* new HttpApiError.Unauthorized({})
    const principal = yield* UserAuth.authenticate(database.db, config, request.headers.cookie)
    if (Option.isNone(principal)) return yield* new HttpApiError.Unauthorized({})
    return yield* database.runAsPrincipal(
      principal.value,
      Effect.provideService(effect, IdentityContext.Current, principal.value),
    )
  })
}

function userAuthorizedRaw<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: HttpServerRequest.HttpServerRequest,
  config: UserAuth.Info,
  database: Database.Interface,
) {
  return Effect.gen(function* () {
    if (
      !UserAuth.sameOrigin({
        host: request.headers.host ?? new URL(config.publicUrl).host,
        url: request.url,
        expectedOrigin: new URL(config.publicUrl).origin,
        method: request.method,
        origin: request.headers.origin,
      })
    )
      return HttpServerResponse.empty({ status: UNAUTHORIZED })
    const principal = yield* UserAuth.authenticate(database.db, config, request.headers.cookie)
    if (Option.isNone(principal)) return HttpServerResponse.empty({ status: UNAUTHORIZED })
    return yield* database.runAsPrincipal(
      principal.value,
      Effect.provideService(effect, IdentityContext.Current, principal.value),
    )
  })
}

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@arforge/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

export class PtyConnectAuthorization extends HttpApiMiddleware.Service<PtyConnectAuthorization>()(
  "@arforge/ExperimentalHttpApiPtyConnectAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  if (!ServerAuth.required(config)) return effect
  if (!ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const userConfig = yield* UserAuth.Config
    const database = yield* Database.Service
    if (UserAuth.enabled(userConfig)) {
      return (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          if (isPublicUIPath(request.method, url.pathname)) return yield* effect
          return yield* userAuthorizedRaw(effect, request, userConfig, database)
        })
    }
    if (!ServerAuth.required(config)) return (effect) => effect

    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        if (sessionAuthorized(request, config)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const userConfig = yield* UserAuth.Config
    const database = yield* Database.Service
    if (UserAuth.enabled(userConfig)) {
      return Authorization.of((effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          return yield* userAuthorized(effect, request, userConfig, database)
        }),
      )
    }
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (sessionAuthorized(request, config)) return yield* effect
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)

export const ptyConnectAuthorizationLayer = Layer.effect(
  PtyConnectAuthorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    const userConfig = yield* UserAuth.Config
    const database = yield* Database.Service
    if (UserAuth.enabled(userConfig)) {
      return PtyConnectAuthorization.of((effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(request.url, "http://localhost")
          if (hasPtyConnectTicketURL(url)) return yield* effect
          return yield* userAuthorized(effect, request, userConfig, database)
        }),
      )
    }
    if (!ServerAuth.required(config)) return PtyConnectAuthorization.of((effect) => effect)
    return PtyConnectAuthorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url)) return yield* effect
        if (sessionAuthorized(request, config)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)
