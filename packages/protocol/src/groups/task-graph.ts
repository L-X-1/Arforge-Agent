import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Session } from "@arforge-ai/schema/session"
import { PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, SessionNotFoundError, TaskNotFoundError } from "../errors"

const root = "/api/session/:sessionID/task"
const params = { sessionID: Session.ID }
const itemParams = { ...params, taskID: TaskGraph.ID }
const mutationErrors = [ConflictError, InvalidRequestError, SessionNotFoundError, TaskNotFoundError]
const revisionPayload = Schema.Struct({ expectedRevision: PositiveInt })

export const makeTaskGraphGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.taskGraph")
    .add(
      HttpApiEndpoint.post("taskGraph.create", root, {
        params,
        payload: Schema.Struct({
          title: TaskGraph.Title,
          description: TaskGraph.Description.pipe(Schema.optional),
          activeForm: TaskGraph.ActiveForm.pipe(Schema.optional),
          metadata: TaskGraph.Metadata.pipe(Schema.optional),
          blockedBy: Schema.Array(TaskGraph.ID).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError, TaskNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.create",
            summary: "Create durable task",
            description:
              "Create a session-owned task. Blockers must belong to the same session and the resulting graph must remain acyclic.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("taskGraph.list", root, {
        params,
        query: {
          status: TaskGraph.Status.pipe(Schema.optional),
          owner: TaskGraph.Owner.pipe(Schema.optional),
          search: Schema.String.pipe(Schema.optional),
        },
        success: Schema.Struct({ data: TaskGraph.Page }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.taskGraph.list", summary: "List durable tasks" })),
    )
    .add(
      HttpApiEndpoint.get("taskGraph.get", `${root}/:taskID`, {
        params: itemParams,
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: [SessionNotFoundError, TaskNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.taskGraph.get", summary: "Get durable task" })),
    )
    .add(
      HttpApiEndpoint.patch("taskGraph.update", `${root}/:taskID`, {
        params: itemParams,
        payload: Schema.Struct({
          expectedRevision: PositiveInt,
          title: TaskGraph.Title.pipe(Schema.optional),
          description: TaskGraph.Description.pipe(Schema.optional),
          activeForm: TaskGraph.ActiveForm.pipe(Schema.optional),
          metadata: TaskGraph.Metadata.pipe(Schema.optional),
          blocks: Schema.Array(TaskGraph.ID).pipe(Schema.optional),
          blockedBy: Schema.Array(TaskGraph.ID).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.update",
            summary: "Update durable task",
            description: "Replace task fields and dependency sets using optimistic concurrency.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("taskGraph.claim", `${root}/:taskID/claim`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt, owner: TaskGraph.Owner }),
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.claim",
            summary: "Claim durable task",
            description: "Atomically claim an unblocked task. One owner may hold at most one in-progress task per session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("taskGraph.release", `${root}/:taskID/release`, {
        params: itemParams,
        payload: Schema.Struct({ expectedRevision: PositiveInt, owner: TaskGraph.Owner }),
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.taskGraph.release", summary: "Release durable task" })),
    )
    .add(
      HttpApiEndpoint.post("taskGraph.complete", `${root}/:taskID/complete`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.complete",
            summary: "Complete durable task",
            description: "Complete a task after the host task_completed policy gate accepts it.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("taskGraph.cancel", `${root}/:taskID/cancel`, {
        params: itemParams,
        payload: revisionPayload,
        success: Schema.Struct({ data: TaskGraph.Info }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.taskGraph.cancel", summary: "Cancel durable task" })),
    )
    .add(
      HttpApiEndpoint.delete("taskGraph.delete", `${root}/:taskID`, {
        params: itemParams,
        payload: revisionPayload,
        success: HttpApiSchema.NoContent,
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.delete",
            summary: "Delete durable task",
            description: "Delete the task and atomically remove its incoming and outgoing dependency edges.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("taskGraph.clear", `${root}/clear`, {
        params,
        payload: Schema.Struct({ terminalOnly: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({
          data: Schema.Struct({ deleted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
        }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.taskGraph.clear",
            summary: "Clear durable tasks",
            description: "Delete completed and cancelled tasks by default. Explicitly set terminalOnly=false to clear all tasks.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "task graph",
        description: "Durable session task lifecycle, ownership, dependency, and policy-gate operations.",
      }),
    )
