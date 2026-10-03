export * as ControlOperationNode from "./node"

import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as ControlClaimIndex from "@arforge-ai/core/runtime/control-claim-index"
import { Effect, Layer } from "effect"
import { ControlOperation } from "./service"
import { WorktreeControlScheduler } from "./worktree-scheduler"

/**
 * The production control-operation service is app-scoped.  Its scheduler is
 * deliberately supplied by a sibling node so an HTTP request cannot create a
 * request-owned worker or claim durable state before a worker is available.
 */
export const node = LayerNode.make({
  service: ControlOperation.Service,
  layer: Layer.effect(
    ControlOperation.Service,
    Effect.gen(function* () {
      const claims = yield* ControlClaimIndex.Service
      const scheduler = yield* WorktreeControlScheduler.Service
      return ControlOperation.Service.of(ControlOperation.make({ claims, scheduler }))
    }),
  ),
  deps: [ControlClaimIndex.node, WorktreeControlScheduler.node],
})
