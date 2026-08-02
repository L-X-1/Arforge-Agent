import { TaskGraphV2 } from "@arforge-ai/core/task-graph"
import {
  ConflictError,
  InvalidRequestError,
  TaskNotFoundError,
} from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const TaskGraphHandler = HttpApiBuilder.group(Api, "server.taskGraph", (handlers) =>
  handlers
      .handle(
        "taskGraph.create",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.create({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.list",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* tasks.list({ ...ctx.params, ...ctx.query }) }
        }),
      )
      .handle(
        "taskGraph.get",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.get(ctx.params)) }
        }),
      )
      .handle(
        "taskGraph.update",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.update({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.claim",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.claim({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.release",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.release({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.complete",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.complete({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.cancel",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: yield* mapErrors(tasks.cancel({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "taskGraph.delete",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          yield* mapErrors(tasks.delete({ ...ctx.params, ...ctx.payload }))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "taskGraph.clear",
        Effect.fn(function* (ctx) {
          const tasks = yield* TaskGraphV2.Service
          return { data: { deleted: yield* tasks.clear({ ...ctx.params, ...ctx.payload }) } }
        }),
      ),
)

type ApiError<E> = E extends
  | TaskGraphV2.InvalidDependencyError
  | TaskGraphV2.MetadataLimitError
  ? InvalidRequestError
  : E extends
        | TaskGraphV2.BlockedError
        | TaskGraphV2.InvalidStateError
        | TaskGraphV2.LimitError
        | TaskGraphV2.MutationRejectedError
        | TaskGraphV2.NameConflictError
        | TaskGraphV2.OwnerConflictError
        | TaskGraphV2.StaleRevisionError
    ? ConflictError
    : E extends TaskGraphV2.NotFoundError
      ? TaskNotFoundError
      : E

function mapErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ApiError<E>, R> {
  return effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error)))) as Effect.Effect<A, ApiError<E>, R>
}

function toApiError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return error
  switch (error._tag) {
    case "TaskGraph.NotFoundError": {
      const value = error as TaskGraphV2.NotFoundError
      return new TaskNotFoundError({
        sessionID: value.sessionID,
        taskID: value.taskID,
        message: `Task not found: ${value.taskID}`,
      })
    }
    case "TaskGraph.InvalidDependencyError": {
      const value = error as TaskGraphV2.InvalidDependencyError
      return new InvalidRequestError({
        message: value.message,
        field: value.relatedTaskID ? "dependency" : undefined,
      })
    }
    case "TaskGraph.MetadataLimitError": {
      const value = error as TaskGraphV2.MetadataLimitError
      return new InvalidRequestError({ message: value.message, field: "metadata" })
    }
    case "TaskGraph.StaleRevisionError": {
      const value = error as TaskGraphV2.StaleRevisionError
      return new ConflictError({
        resource: value.taskID,
        message: `Task revision is stale: expected ${value.expectedRevision}, current revision is ${value.actualRevision}.`,
      })
    }
    case "TaskGraph.NameConflictError": {
      const value = error as TaskGraphV2.NameConflictError
      return new ConflictError({
        resource: value.title,
        message: `Task title already exists in this session: ${value.title}`,
      })
    }
    case "TaskGraph.LimitError": {
      const value = error as TaskGraphV2.LimitError
      return new ConflictError({
        resource: value.sessionID,
        message: `A session may contain at most ${value.limit} durable tasks.`,
      })
    }
    case "TaskGraph.InvalidStateError": {
      const value = error as TaskGraphV2.InvalidStateError
      return new ConflictError({
        resource: value.taskID,
        message: `Task status ${value.status} cannot perform ${value.action}.`,
      })
    }
    case "TaskGraph.BlockedError": {
      const value = error as TaskGraphV2.BlockedError
      return new ConflictError({
        resource: value.taskID,
        message: `Task has unresolved blockers: ${value.blockers.join(", ")}`,
      })
    }
    case "TaskGraph.OwnerConflictError": {
      const value = error as TaskGraphV2.OwnerConflictError
      return new ConflictError({
        resource: value.taskID,
        message: `Owner ${value.owner} already conflicts with task ${value.conflictingTaskID}.`,
      })
    }
    case "TaskGraph.MutationRejectedError": {
      const value = error as TaskGraphV2.MutationRejectedError
      return new ConflictError({
        resource: value.event,
        message: value.message,
      })
    }
    default:
      return error
  }
}
