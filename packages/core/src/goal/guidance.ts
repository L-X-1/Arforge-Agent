export * as GoalGuidance from "./guidance"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { GoalV2 } from "../goal"
import { SessionSchema } from "../session/schema"
import { SystemContext } from "../system-context/index"

const Summary = Schema.Struct({
  id: GoalV2.ID,
  objective: GoalV2.Objective,
  status: GoalV2.Status,
  revision: Schema.Int,
})
type Summary = typeof Summary.Type

export interface Interface {
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/GoalGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* GoalV2.Service

    return Service.of({
      load: Effect.fn("GoalGuidance.load")(function* (sessionID) {
        const active = (yield* goals.list({ sessionID, includeHistory: false })).active
        if (!active) return SystemContext.empty
        return SystemContext.make({
          key: SystemContext.Key.make("arforge/active-goal"),
          codec: Schema.toCodecJson(Summary),
          load: Effect.succeed({
            id: active.id,
            objective: active.objective,
            status: active.status,
            revision: active.revision,
          }),
          baseline: render,
          update: (_previous, current) =>
            [
              "The active autonomous goal changed. This state supersedes the previous goal state.",
              render(current),
            ].join("\n"),
          removed: () => "There is no longer an active autonomous goal. Do not update a previously active goal.",
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [GoalV2.node] })

function render(goal: Summary) {
  return [
    "You are executing a durable autonomous goal.",
    "<active_goal>",
    `  <id>${goal.id}</id>`,
    `  <revision>${goal.revision}</revision>`,
    `  <status>${goal.status}</status>`,
    `  <objective>${escapeXml(goal.objective)}</objective>`,
    "</active_goal>",
    "Work toward the objective through the normal plan, permission, tool, and verification boundaries.",
    "When the objective is genuinely achieved, call goal_update with status completed and the current revision.",
    "If progress cannot continue without user input or an external state change, call goal_update with status blocked and a concise factual error.",
    "Do not call deliver_user_message while this Goal is running. The backend rejects primary delivery until the Goal is completed or blocked.",
    "A plan, partial implementation, or unverified claim is not completion.",
  ].join("\n")
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
