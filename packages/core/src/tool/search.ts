export * as ToolSearchTool from "./search"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { DeferredTools } from "./deferred"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "tool_search"

export const Input = Schema.Struct({
  query: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(10)).pipe(Schema.optional),
})

const Match = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const Output = Schema.Struct({
  tools: Schema.Array(Match),
  activated: Schema.Array(Schema.String),
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const registry = yield* ToolRegistry.Service
    const deferred = yield* DeferredTools.Service
    if (!deferred.enabled()) return

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search available tool schemas by keywords, +required terms, an exact name, or select:name_a,name_b. Matching tools become available on the next model step.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
          execute: (input, context) =>
            registry
              .discover({
                sessionID: context.sessionID,
                query: input.query,
                limit: input.limit ?? 8,
              })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/search",
  layer,
  deps: [ToolRegistry.node, DeferredTools.node, DeferredTools.configNode],
})
