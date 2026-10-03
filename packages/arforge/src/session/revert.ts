import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export class MutationUnavailableError extends Schema.TaggedErrorClass<MutationUnavailableError>()(
  "SessionRevert.MutationUnavailableError",
  {
    operation: Schema.Literals(["revert", "unrevert"]),
  },
) {
  override get message() {
    return `Legacy session ${this.operation} is disabled until controlled restore runs through a sealed ControlRun worker`
  }
}

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, MutationUnavailableError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, MutationUnavailableError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/SessionRevert") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (_input: RevertInput) {
      return yield* new MutationUnavailableError({ operation: "revert" })
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (_input: { sessionID: SessionID }) {
      return yield* new MutationUnavailableError({ operation: "unrevert" })
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as SessionV1.WithParts[]
      let target: SessionV1.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        yield* sessions.removeMessage({ sessionID, messageID: msg.info.id })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.removePart({ sessionID, messageID: target.info.id, partID: part.id })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node],
})

export * as SessionRevert from "./revert"
