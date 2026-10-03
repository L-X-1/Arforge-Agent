import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@arforge-ai/protocol/errors"
import { Authorization } from "@arforge-ai/protocol/middleware/authorization"
export { Authorization } from "@arforge-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@arforge-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { SessionAuth } from "../session-auth"
import { UserAuth } from "../user-auth"
import { IdentityContext } from "../identity-context"
import { Database } from "@arforge-ai/core/database/database"
import { Option } from "effect"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

/** Private mode is a server-owned owner principal, never a request-derived identity. */
const LocalIdentityPrincipal = IdentityContext.LocalPrincipal

function localAuthorized<A, E, R>(effect: Effect.Effect<A, E, R>, database: Database.Interface) {
  return database.runAsPrincipal(
    LocalIdentityPrincipal,
    Effect.provideService(effect, IdentityContext.Current, LocalIdentityPrincipal),
  )
}

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

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
          if (
            !UserAuth.sameOrigin({
              host: request.headers.host ?? new URL(userConfig.publicUrl).host,
              url: request.url,
              expectedOrigin: new URL(userConfig.publicUrl).origin,
              method: request.method,
              origin: request.headers.origin,
            })
          )
            return yield* new UnauthorizedError({ message: "Authentication required" })
          const principal = yield* UserAuth.authenticate(database.db, userConfig, request.headers.cookie)
          if (Option.isNone(principal)) return yield* new UnauthorizedError({ message: "Authentication required" })
          return yield* database.runAsPrincipal(
            principal.value,
            Effect.provideService(effect, IdentityContext.Current, principal.value),
          )
        }),
      )
    }
    if (!ServerAuth.required(config)) return Authorization.of((effect) => localAuthorized(effect, database))
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost")))
          return yield* localAuthorized(effect, database)
        if (
          SessionAuth.requestAuthorized(
            {
              cookie: request.headers.cookie,
              host: request.headers.host,
              method: request.method,
              origin: request.headers.origin,
            },
            config,
          )
        )
          return yield* localAuthorized(effect, database)
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* localAuthorized(effect, database)
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
