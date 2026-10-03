import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"

export class MutationUnavailableError extends Schema.TaggedErrorClass<MutationUnavailableError>()(
  "SessionShare.MutationUnavailableError",
  {
    operation: Schema.Literals(["share", "unshare"]),
  },
) {
  override get message() {
    return `Legacy session ${this.operation} is disabled until controlled publishing runs through a sealed ControlRun worker`
  }
}

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, MutationUnavailableError>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, MutationUnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionShare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const flags = yield* RuntimeFlags.Service

    const share = Effect.fn("SessionShare.share")(function* (_sessionID: SessionID) {
      return yield* new MutationUnavailableError({ operation: "share" })
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (_sessionID: SessionID) {
      return yield* new MutationUnavailableError({ operation: "unshare" })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const result = yield* session.create(input)
      if (result.parentID) return result
      const conf = yield* cfg.get()
      if (!(flags.autoShare || conf.share === "auto")) return result
      yield* Effect.logWarning("automatic session sharing suppressed until controlled publishing is available", {
        sessionID: result.id,
        configuredAutoShare: conf.share === "auto",
        environmentAutoShare: flags.autoShare,
        outcome: "suppressed",
      })
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Session.node, RuntimeFlags.node],
})

export * as SessionShare from "./session"
