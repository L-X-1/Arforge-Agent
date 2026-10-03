export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionTodo } from "../session/todo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { majorImpact } from "./effect-semantics"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.BuiltIns
    const todos = yield* SessionTodo.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.",
          input: Input,
          output: Output,
          effects: majorImpact({
            expectedArtifacts: ["session todo projection"],
            successCriteria: ["the complete session-local todo list is replaced atomically"],
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* context.permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(
              Effect.mapError(
                (error) => Tool.toToolFailure(error) ?? new ToolFailure({ message: "Unable to update todos" }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.builtInsNode, SessionTodo.node],
})
