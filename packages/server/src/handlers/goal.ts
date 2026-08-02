import { GoalV2 } from "@arforge-ai/core/goal"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { ConflictError, GoalNotFoundError, SessionNotFoundError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const GoalHandler = HttpApiBuilder.group(Api, "server.goal", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers
      .handle(
        "goal.list",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* goals.list({
              sessionID: ctx.params.sessionID,
              includeHistory: ctx.query.history !== "false",
            }),
          }
        }),
      )
      .handle(
        "goal.create",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* goals.create({
              sessionID: ctx.params.sessionID,
              objective: ctx.payload.objective,
              queue: ctx.payload.queue,
            }),
          }
        }),
      )
      .handle(
        "goal.get",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* withGoalNotFound(goals.get(ctx.params)),
          }
        }),
      )
      .handle(
        "goal.run",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          const current = yield* withGoalNotFound(goals.get(ctx.params))
          const promptID = SessionMessage.ID.create()
          const goal = yield* withGoalMutationErrors(
            goals.start({
              ...ctx.params,
              expectedRevision: ctx.payload.expectedRevision,
              promptID,
            }),
          )
          const input = yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              id: promptID,
              prompt: { text: current.objective },
              delivery: "queue",
            })
            .pipe(
              Effect.tapError((error) =>
                goals
                  .block({
                    ...ctx.params,
                    expectedRevision: goal.revision,
                    error: error.message,
                  })
                  .pipe(Effect.ignore),
              ),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.PromptConflictError",
                (error) =>
                  new ConflictError({
                    resource: error.messageID,
                    message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                  }),
              ),
            )
          return { data: { goal, input } }
        }),
      )
      .handle(
        "goal.pause",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          const current = yield* withGoalNotFound(goals.get(ctx.params))
          const goal = yield* withGoalMutationErrors(goals.pause({ ...ctx.params, ...ctx.payload }))
          if (current.status === "running") yield* session.interrupt(ctx.params.sessionID)
          return { data: goal }
        }),
      )
      .handle(
        "goal.resume",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* withGoalMutationErrors(goals.resume({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "goal.complete",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          const current = yield* withGoalNotFound(goals.get(ctx.params))
          const goal = yield* withGoalMutationErrors(goals.complete({ ...ctx.params, ...ctx.payload }))
          if (current.status === "running") yield* session.interrupt(ctx.params.sessionID)
          return { data: goal }
        }),
      )
      .handle(
        "goal.block",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          const current = yield* withGoalNotFound(goals.get(ctx.params))
          const goal = yield* withGoalMutationErrors(goals.block({ ...ctx.params, ...ctx.payload }))
          if (current.status === "running") yield* session.interrupt(ctx.params.sessionID)
          return { data: goal }
        }),
      )
      .handle(
        "goal.cancel",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          const current = yield* withGoalNotFound(goals.get(ctx.params))
          const goal = yield* withGoalMutationErrors(goals.cancel({ ...ctx.params, ...ctx.payload }))
          if (current.status === "running") yield* session.interrupt(ctx.params.sessionID)
          return { data: goal }
        }),
      )
      .handle(
        "goal.replace",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* withGoalMutationErrors(goals.replace({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "goal.deleteQueued",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          yield* withGoalMutationErrors(goals.deleteQueued({ ...ctx.params, ...ctx.payload }))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "goal.reorder",
        Effect.fn(function* (ctx) {
          const goals = yield* GoalV2.Service
          return {
            data: yield* withGoalQueueErrors(
              goals.reorder({
                sessionID: ctx.params.sessionID,
                goals: ctx.payload.goals,
              }),
            ),
          }
        }),
      )
  }),
)

function withGoalNotFound<A, R>(effect: Effect.Effect<A, GoalV2.NotFoundError, R>) {
  return effect.pipe(
    Effect.catchTag(
      "Goal.NotFoundError",
      (error) =>
        new GoalNotFoundError({
          sessionID: error.sessionID,
          goalID: error.goalID,
          message: `Goal not found: ${error.goalID}`,
        }),
    ),
  )
}

function withGoalMutationErrors<A, R>(
  effect: Effect.Effect<A, GoalV2.NotFoundError | GoalV2.InvalidStateError | GoalV2.StaleRevisionError, R>,
) {
  return effect.pipe(
    Effect.catchTags({
      "Goal.NotFoundError": (error) =>
        new GoalNotFoundError({
          sessionID: error.sessionID,
          goalID: error.goalID,
          message: `Goal not found: ${error.goalID}`,
        }),
      "Goal.InvalidStateError": (error) =>
        new ConflictError({
          resource: error.goalID,
          message: `Goal status ${error.status} cannot perform ${error.action}`,
        }),
      "Goal.StaleRevisionError": (error) =>
        new ConflictError({
          resource: error.goalID,
          message: `Goal revision changed from ${error.expectedRevision} to ${error.actualRevision}`,
        }),
    }),
  )
}

function withGoalQueueErrors<A, R>(
  effect: Effect.Effect<A, GoalV2.InvalidQueueError | GoalV2.StaleRevisionError, R>,
) {
  return effect.pipe(
    Effect.catchTags({
      "Goal.StaleRevisionError": (error) =>
        new ConflictError({
          resource: error.goalID,
          message: `Goal revision changed from ${error.expectedRevision} to ${error.actualRevision}`,
        }),
      "Goal.InvalidQueueError": (error) =>
        new ConflictError({
          message: error.message,
          resource: "goal-queue",
        }),
    }),
  )
}
