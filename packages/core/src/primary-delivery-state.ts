export * as PrimaryDeliveryState from "./primary-delivery-state"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"

export interface Interface {
  readonly mark: (sessionID: SessionSchema.ID) => void
  readonly delivered: (sessionID: SessionSchema.ID) => boolean
  readonly consume: (sessionID: SessionSchema.ID) => boolean
  readonly clear: (sessionID: SessionSchema.ID) => void
  readonly withinRun: <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PrimaryDeliveryState") {}

const layer = Layer.sync(Service, () => {
  const delivered = new Set<SessionSchema.ID>()
  return Service.of({
    mark: (sessionID) => delivered.add(sessionID),
    delivered: (sessionID) => delivered.has(sessionID),
    consume: (sessionID) => {
      const present = delivered.has(sessionID)
      delivered.delete(sessionID)
      return present
    },
    clear: (sessionID) => delivered.delete(sessionID),
    withinRun: (sessionID, effect) =>
      Effect.sync(() => delivered.delete(sessionID)).pipe(
        Effect.andThen(effect),
        Effect.ensuring(Effect.sync(() => delivered.delete(sessionID))),
      ),
  })
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
