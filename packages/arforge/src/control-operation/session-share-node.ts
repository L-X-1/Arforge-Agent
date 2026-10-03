export * as SessionShareControlOperationNode from "./session-share-node"

import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { Effect, Layer } from "effect"
import { SessionShareControlOperation } from "./session-share-operation"
import { SessionShareControlScheduler } from "./session-share-scheduler"

export const node = LayerNode.make({
  service: SessionShareControlOperation.Service,
  layer: Layer.effect(
    SessionShareControlOperation.Service,
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const scheduler = yield* SessionShareControlScheduler.Service
      return SessionShareControlOperation.Service.of(SessionShareControlOperation.make({ claims, scheduler }))
    }),
  ),
  deps: [ControlClaimIndex.node, SessionShareControlScheduler.node],
})
