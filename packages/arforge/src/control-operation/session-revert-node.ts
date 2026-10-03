export * as SessionRevertControlOperationNode from "./session-revert-node"

import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { Effect, Layer } from "effect"
import { SessionRevertControlOperation } from "./session-revert-operation"
import { SessionRevertControlScheduler } from "./session-revert-scheduler"

export const node = LayerNode.make({
  service: SessionRevertControlOperation.Service,
  layer: Layer.effect(
    SessionRevertControlOperation.Service,
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const scheduler = yield* SessionRevertControlScheduler.Service
      return SessionRevertControlOperation.Service.of(SessionRevertControlOperation.make({ claims, scheduler }))
    }),
  ),
  deps: [ControlClaimIndex.node, SessionRevertControlScheduler.node],
})
