import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@arforge-ai/core/schema"
import { Global } from "@arforge-ai/core/global"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { ProtectedJson } from "@arforge-ai/core/protected-json"
import { SecretProvider } from "@arforge-ai/core/secret-provider"

export const OAUTH_DUMMY_KEY = "arforge-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const secrets = yield* SecretProvider.Service
    const decode = Schema.decodeUnknownOption(Info)
    const readProtected = (target: string) =>
      ProtectedJson.read(target).pipe(
        Effect.provideService(FSUtil.Service, fsys),
        Effect.provideService(SecretProvider.Service, secrets),
      )
    const writeProtected = (target: string, value: unknown, mode?: number) =>
      ProtectedJson.write(target, value, mode).pipe(
        Effect.provideService(FSUtil.Service, fsys),
        Effect.provideService(SecretProvider.Service, secrets),
      )

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.ARFORGE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.ARFORGE_AUTH_CONTENT)
        } catch (err) {}
      }

      const loaded = yield* readProtected(file).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed({ value: {}, needsMigration: false as const }),
        ),
        Effect.mapError(fail("Failed to decrypt auth data")),
      )
      const data = loaded.value as Record<string, unknown>
      const valid = Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
      if (loaded.needsMigration)
        yield* writeProtected(file, valid, 0o600).pipe(Effect.mapError(fail("Failed to migrate auth data")))
      return valid
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* writeProtected(file, { ...data, [norm]: info }, 0o600).pipe(
        Effect.mapError(fail("Failed to write auth data")),
      )
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* writeProtected(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, SecretProvider.node] })

export * as Auth from "."
