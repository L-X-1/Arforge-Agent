import { Context, Effect, Layer } from "effect"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"

/** Read-only event observation for internal plugins; the raw publisher stays in the TCB. */
export interface Interface {
  readonly subscribe: EventV2.Interface["subscribe"]
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PluginEventObserver") {}

const layer = Layer.effect(
  Service,
  Effect.map(EventV2.Service, (events) => Service.of({ subscribe: events.subscribe })),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })

export * as PluginEvents from "./events"
