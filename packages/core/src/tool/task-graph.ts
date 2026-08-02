export * as TaskGraphTools from "./task-graph"

import { ToolFailure } from "@arforge-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { TaskGraphV2 } from "../task-graph"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const TaskOutput = Schema.Struct({ task: TaskGraphV2.Info })
const PageOutput = Schema.Struct({ page: TaskGraphV2.Page })
const DeletedOutput = Schema.Struct({ deleted: TaskGraphV2.ID })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const tasks = yield* TaskGraphV2.Service
    const permission = yield* PermissionV2.Service

    const authorize = (
      action: string,
      resources: ReadonlyArray<string>,
      context: Tool.Context,
    ) =>
      permission.assert({
        action,
        resources: [...resources],
        save: [...resources],
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })

    yield* tools
      .register({
        create_task: Tool.make({
          description:
            "Create a durable session task with optional blockers. Dependency relations are symmetric and cycles are rejected.",
          input: Schema.Struct({
            title: TaskGraphV2.Title,
            description: TaskGraphV2.Description.pipe(Schema.optional),
            activeForm: TaskGraphV2.ActiveForm.pipe(Schema.optional),
            metadata: TaskGraphV2.Metadata.pipe(Schema.optional),
            blockedBy: Schema.Array(TaskGraphV2.ID).pipe(Schema.optional),
          }),
          output: TaskOutput,
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* authorize("create_task", ["task-graph"], context)
              return { task: yield* tasks.create({ ...input, sessionID: context.sessionID }) }
            }).pipe(toolError),
        }),
        list_tasks: Tool.make({
          description:
            "List durable tasks and their blockers, downstream tasks, owner, lifecycle state, and optimistic revision.",
          input: Schema.Struct({
            status: TaskGraphV2.Status.pipe(Schema.optional),
            owner: TaskGraphV2.Owner.pipe(Schema.optional),
          }),
          output: PageOutput,
          toModelOutput: json,
          execute: (input, context) =>
            tasks.list({ ...input, sessionID: context.sessionID }).pipe(
              Effect.map((page) => ({ page })),
              toolError,
            ),
        }),
        search_tasks: Tool.make({
          description: "Search durable task titles, descriptions, and active-form labels in the current session.",
          input: Schema.Struct({
            query: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(240)),
          }),
          output: PageOutput,
          toModelOutput: json,
          execute: (input, context) =>
            tasks.list({ sessionID: context.sessionID, search: input.query }).pipe(
              Effect.map((page) => ({ page })),
              toolError,
            ),
        }),
        update_task: Tool.make({
          description:
            "Revision-safely update task content or replace its blocks/blockedBy relations. Cycles and cross-session relations fail closed.",
          input: Schema.Struct({
            taskID: TaskGraphV2.ID,
            expectedRevision: PositiveInt,
            title: TaskGraphV2.Title.pipe(Schema.optional),
            description: TaskGraphV2.Description.pipe(Schema.optional),
            activeForm: TaskGraphV2.ActiveForm.pipe(Schema.optional),
            metadata: TaskGraphV2.Metadata.pipe(Schema.optional),
            blocks: Schema.Array(TaskGraphV2.ID).pipe(Schema.optional),
            blockedBy: Schema.Array(TaskGraphV2.ID).pipe(Schema.optional),
          }),
          output: TaskOutput,
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* authorize("update_task", [input.taskID], context)
              return { task: yield* tasks.update({ ...input, sessionID: context.sessionID }) }
            }).pipe(toolError),
        }),
        claim_task: Tool.make({
          description:
            "Claim an unblocked durable task for one owner. An owner may hold only one in-progress task in this session.",
          input: Schema.Struct({
            taskID: TaskGraphV2.ID,
            expectedRevision: PositiveInt,
            owner: TaskGraphV2.Owner,
          }),
          output: TaskOutput,
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* authorize("claim_task", [input.taskID], context)
              return { task: yield* tasks.claim({ ...input, sessionID: context.sessionID }) }
            }).pipe(toolError),
        }),
        complete_task: Tool.make({
          description:
            "Mark a durable task completed using its current revision. Completion first passes the host's task_completed policy gate.",
          input: Schema.Struct({
            taskID: TaskGraphV2.ID,
            expectedRevision: PositiveInt,
          }),
          output: TaskOutput,
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* authorize("complete_task", [input.taskID], context)
              return { task: yield* tasks.complete({ ...input, sessionID: context.sessionID }) }
            }).pipe(toolError),
        }),
        delete_task: Tool.make({
          description: "Delete a durable task and atomically remove every incoming and outgoing dependency.",
          input: Schema.Struct({
            taskID: TaskGraphV2.ID,
            expectedRevision: PositiveInt,
          }),
          output: DeletedOutput,
          toModelOutput: json,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* authorize("delete_task", [input.taskID], context)
              yield* tasks.delete({ ...input, sessionID: context.sessionID })
              return { deleted: input.taskID }
            }).pipe(toolError),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task-graph",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, TaskGraphV2.node],
})

function json({ output }: { output: unknown }) {
  return [{ type: "text" as const, text: JSON.stringify(output, null, 2) }]
}

const toolError = Effect.mapError((error: unknown) => new ToolFailure({ message: describe(error) }))

function describe(error: unknown) {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "TaskGraph.NotFoundError":
        return "The task does not belong to this session"
      case "TaskGraph.StaleRevisionError":
        return "The task changed; list tasks and retry with its current revision"
      case "TaskGraph.InvalidDependencyError":
        return "The task dependency is missing, cross-session, self-referential, or cyclic"
      case "TaskGraph.NameConflictError":
        return "A task with this title already exists in the current session"
      case "TaskGraph.LimitError":
        return "The current session reached its durable task limit"
      case "TaskGraph.MetadataLimitError":
        return "Task metadata exceeds its key or byte limit"
      case "TaskGraph.BlockedError":
        return "The task still has unresolved blockers"
      case "TaskGraph.OwnerConflictError":
        return "The task or requested owner already has a conflicting claim"
      case "TaskGraph.MutationRejectedError":
        return "The host policy rejected this task mutation before persistence"
      case "TaskGraph.InvalidStateError":
        return "The task cannot perform this action from its current state"
    }
  }
  return error instanceof Error ? error.message : "Unable to mutate the durable task graph"
}
