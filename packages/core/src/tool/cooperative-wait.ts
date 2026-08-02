export * as CooperativeWaitTool from "./cooperative-wait"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { CooperativeWaitV2 } from "../cooperative-wait"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "cooperative_wait"

export const Input = Schema.Struct({
  duration_seconds: Schema.Finite.annotate({ description: "Total wait duration from 0.05 to 300 seconds" }),
  check_in_interval: Schema.Finite.pipe(Schema.optional).annotate({
    description: "Periodic host check-in interval from 0.05 to 60 seconds (default 30)",
  }),
  reason: Schema.String.pipe(Schema.optional).annotate({ description: "Brief reason for waiting" }),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const waits = yield* CooperativeWaitV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Wait cooperatively for a bounded duration without starting or occupying a shell process. The host can observe, cancel, or wake it, and periodic check-ins report liveness.",
          input: Input,
          output: CooperativeWaitV2.Result,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
          execute: (input, context) =>
            waits
              .wait({
                sessionID: context.sessionID,
                durationSeconds: input.duration_seconds,
                checkInInterval: input.check_in_interval,
                reason: input.reason,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message:
                        error instanceof CooperativeWaitV2.InvalidInputError
                          ? error.message
                          : "This session already has an active cooperative wait",
                    }),
                ),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/cooperative-wait",
  layer,
  deps: [ToolRegistry.node, CooperativeWaitV2.node],
})
