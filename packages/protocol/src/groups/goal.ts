import { Goal } from "@arforge-ai/schema/goal"
import { SessionInput } from "@arforge-ai/schema/session-input"
import { SessionID } from "@arforge-ai/schema/session-id"
import { PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, GoalNotFoundError, SessionNotFoundError } from "../errors"

const GoalParams = {
  sessionID: SessionID,
  goalID: Goal.ID,
}

const RevisionPayload = Schema.Struct({
  expectedRevision: PositiveInt,
})

export const makeGoalGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.goal")
    .add(
      HttpApiEndpoint.get("goal.list", "/api/session/:sessionID/goal", {
        params: { sessionID: SessionID },
        query: { history: Schema.Literals(["true", "false"]).pipe(Schema.optional) },
        success: Schema.Struct({ data: Goal.Page }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.list", summary: "List autonomous goals" })),
    )
    .add(
      HttpApiEndpoint.post("goal.create", "/api/session/:sessionID/goal", {
        params: { sessionID: SessionID },
        payload: Schema.Struct({
          objective: Goal.Objective,
          queue: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Goal.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.create", summary: "Create autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.get("goal.get", "/api/session/:sessionID/goal/:goalID", {
        params: GoalParams,
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.get", summary: "Get autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.run", "/api/session/:sessionID/goal/:goalID/run", {
        params: GoalParams,
        payload: RevisionPayload,
        success: Schema.Struct({
          data: Schema.Struct({
            goal: Goal.Info,
            input: SessionInput.Admitted,
          }),
        }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.goal.run",
            summary: "Run autonomous goal",
            description:
              "Associate the goal with one durable queued Session prompt and wake normal Session execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("goal.pause", "/api/session/:sessionID/goal/:goalID/pause", {
        params: GoalParams,
        payload: RevisionPayload,
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.pause", summary: "Pause autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.resume", "/api/session/:sessionID/goal/:goalID/resume", {
        params: GoalParams,
        payload: RevisionPayload,
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.resume", summary: "Resume autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.complete", "/api/session/:sessionID/goal/:goalID/complete", {
        params: GoalParams,
        payload: RevisionPayload,
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.complete", summary: "Complete autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.block", "/api/session/:sessionID/goal/:goalID/block", {
        params: GoalParams,
        payload: Schema.Struct({
          expectedRevision: PositiveInt,
          error: Schema.String.check(Schema.isMaxLength(1_000)),
        }),
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.block", summary: "Block autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.cancel", "/api/session/:sessionID/goal/:goalID/cancel", {
        params: GoalParams,
        payload: RevisionPayload,
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.cancel", summary: "Cancel autonomous goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.replace", "/api/session/:sessionID/goal/:goalID/replace", {
        params: GoalParams,
        payload: Schema.Struct({
          expectedRevision: PositiveInt,
          objective: Goal.Objective,
        }),
        success: Schema.Struct({ data: Goal.Info }),
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.replace", summary: "Replace goal objective" })),
    )
    .add(
      HttpApiEndpoint.delete("goal.deleteQueued", "/api/session/:sessionID/goal/:goalID", {
        params: GoalParams,
        payload: RevisionPayload,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, GoalNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.deleteQueued", summary: "Delete queued goal" })),
    )
    .add(
      HttpApiEndpoint.post("goal.reorder", "/api/session/:sessionID/goal/reorder", {
        params: { sessionID: SessionID },
        payload: Schema.Struct({
          goals: Schema.Array(
            Schema.Struct({
              id: Goal.ID,
              revision: PositiveInt,
            }),
          ),
        }),
        success: Schema.Struct({ data: Goal.Page }),
        error: [SessionNotFoundError, ConflictError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.goal.reorder", summary: "Reorder queued goals" })),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "goals",
        description: "Durable Session-owned autonomous goal lifecycle.",
      }),
    )
