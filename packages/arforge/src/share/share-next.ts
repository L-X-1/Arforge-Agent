import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { serviceUse } from "@arforge-ai/core/effect/service-use"
import { Effect, Layer, Option, Schema, Context } from "effect"
import { Account } from "@/account/account"
import { InstanceState } from "@/effect/instance-state"

import type { SessionID } from "@/session/schema"
import { Config } from "@/config/config"
import { Database } from "@arforge-ai/core/database/database"

const disabled = process.env["ARFORGE_DISABLE_SHARE"] === "true" || process.env["ARFORGE_DISABLE_SHARE"] === "1"

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Req = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  shared: Map<SessionID, Share | null>
}

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Req, unknown>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, MutationUnavailableError>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, MutationUnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/ShareNext") {}

export class EndpointNotConfiguredError extends Schema.TaggedErrorClass<EndpointNotConfiguredError>()(
  "ShareEndpointNotConfiguredError",
  {},
) {
  override get message() {
    return "Sharing requires an explicit enterprise.url or an active organization account"
  }
}

export class MutationUnavailableError extends Schema.TaggedErrorClass<MutationUnavailableError>()(
  "ShareNext.MutationUnavailableError",
  {
    operation: Schema.Literals(["create", "remove"]),
  },
) {
  override get message() {
    return `ShareNext ${this.operation} is disabled until controlled publishing runs through a sealed ControlRun worker`
  }
}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

const legacyApi = api("share")
const consoleApi = api("shares")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const cfg = yield* Config.Service

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareNext.state")(function* () {
        const cache: State = { shared: new Map() }
        yield* Effect.addFinalizer(() => Effect.sync(() => cache.shared.clear()))
        return cache
      }),
    )

    const request = Effect.fn("ShareNext.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url
        if (!baseUrl) return yield* new EndpointNotConfiguredError()
        return { headers, api: legacyApi, baseUrl } satisfies Req
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) {
        throw new Error("No active account token available for sharing")
      }

      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: consoleApi, baseUrl: active.value.url } satisfies Req
    })

    const init = Effect.fn("ShareNext.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareNext.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareNext.create")(function* (_sessionID: SessionID) {
      return yield* new MutationUnavailableError({ operation: "create" })
    })

    const remove = Effect.fn("ShareNext.remove")(function* (_sessionID: SessionID) {
      return yield* new MutationUnavailableError({ operation: "remove" })
    })

    return Service.of({ init, url, request, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Account.node, Config.node, Database.node],
})

export * as ShareNext from "./share-next"
