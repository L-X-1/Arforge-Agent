export * as GoalUpdateTool from "./goal-update"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { GoalV2 } from "../goal"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { majorImpact } from "./effect-semantics"

export const name = "goal_update"

export const Input = Schema.Struct({
  goalID: GoalV2.ID,
  expectedRevision: PositiveInt,
  status: Schema.Literals(["completed", "blocked"]),
  error: Schema.String.check(Schema.isMaxLength(1_000)).pipe(Schema.optional),
})

export const Output = Schema.Struct({
  goal: GoalV2.Info,
  next: GoalV2.Info.pipe(Schema.optional),
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const goals = yield* GoalV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Mark the current durable autonomous goal completed after verification, or blocked when progress genuinely requires user input or an external state change.",
          input: Input,
          output: Output,
          effects: (input) =>
            majorImpact({
              externalServices: ["goal-store"],
              expectedArtifacts: [`goal:${input.goalID}`],
              successCriteria: [`goal:${input.goalID} reaches ${input.status} at revision ${input.expectedRevision + 1}`],
            }),
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* context.permission.assert({
                action: name,
                resources: [input.goalID],
                save: [input.goalID],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const blockedError = input.error?.trim()
              if (input.status === "blocked" && !blockedError)
                return yield* Effect.fail(new Error("Blocked goals require a factual error"))
              const goal =
                input.status === "completed"
                  ? yield* goals.complete({
                      sessionID: context.sessionID,
                      goalID: input.goalID,
                      expectedRevision: input.expectedRevision,
                    })
                  : yield* goals.block({
                      sessionID: context.sessionID,
                      goalID: input.goalID,
                      expectedRevision: input.expectedRevision,
                      error: blockedError!,
                    })
              return {
                goal,
                next: (yield* goals.list({ sessionID: context.sessionID, includeHistory: false })).active,
              }
            }).pipe(
              Effect.mapError((error) => Tool.toToolFailure(error) ?? new ToolFailure({ message: describe(error) })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/goal-update",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, GoalV2.node],
})

function describe(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "Goal.NotFoundError") return "The goal does not belong to this session"
    if (error._tag === "Goal.StaleRevisionError")
      return "The goal changed; inspect its current revision before retrying"
    if (error._tag === "Goal.InvalidStateError") return "The goal cannot be updated from its current state"
  }
  return "Unable to update the autonomous goal"
}
