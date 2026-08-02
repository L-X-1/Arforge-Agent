import { ScheduledPromptV2 } from "@arforge-ai/core/scheduled-prompt"
import { SessionV2 } from "@arforge-ai/core/session"
import {
  ConflictError,
  InvalidRequestError,
  ScheduledPromptNotFoundError,
  SessionNotFoundError,
} from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ScheduledPromptHandler = HttpApiBuilder.group(Api, "server.scheduledPrompt", (handlers) =>
  Effect.gen(function* () {
    const schedules = yield* ScheduledPromptV2.Service

    return handlers
      .handle(
        "scheduledPrompt.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.create({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "scheduledPrompt.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.list(ctx.params.sessionID)),
          }
        }),
      )
      .handle(
        "scheduledPrompt.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.get(ctx.params)),
          }
        }),
      )
      .handle(
        "scheduledPrompt.update",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.update({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "scheduledPrompt.delete",
        Effect.fn(function* (ctx) {
          yield* mapErrors(schedules.delete({ ...ctx.params, expectedRevision: ctx.payload.expectedRevision }))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "scheduledPrompt.run",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.run({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "scheduledPrompt.runMissed",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(schedules.runMissed({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
  }),
)

type ApiError<E> = E extends ScheduledPromptV2.InvalidCronError
  ? InvalidRequestError
  : E extends
        | ScheduledPromptV2.InvalidStateError
        | ScheduledPromptV2.LimitError
        | ScheduledPromptV2.NameConflictError
        | ScheduledPromptV2.StaleRevisionError
        | SessionV2.BusyError
        | SessionV2.PromptConflictError
    ? ConflictError
    : E extends ScheduledPromptV2.NotFoundError
      ? ScheduledPromptNotFoundError
      : E extends SessionV2.NotFoundError
        ? SessionNotFoundError
        : E

function mapErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ApiError<E>, R> {
  return effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error)))) as Effect.Effect<A, ApiError<E>, R>
}

function toApiError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return error
  switch (error._tag) {
    case "ScheduledPrompt.InvalidCronError": {
      const value = error as ScheduledPromptV2.InvalidCronError
      return new InvalidRequestError({ message: value.message, field: "cron" })
    }
    case "ScheduledPrompt.LimitError": {
      const value = error as ScheduledPromptV2.LimitError
      return new ConflictError({
        message: `A session may contain at most ${value.limit} scheduled prompts.`,
        resource: value.sessionID,
      })
    }
    case "ScheduledPrompt.NameConflictError": {
      const value = error as ScheduledPromptV2.NameConflictError
      return new ConflictError({
        message: `Scheduled prompt name already exists in this session: ${value.name}`,
        resource: value.name,
      })
    }
    case "ScheduledPrompt.StaleRevisionError": {
      const value = error as ScheduledPromptV2.StaleRevisionError
      return new ConflictError({
        message: `Scheduled prompt revision is stale: expected ${value.expectedRevision}, current revision is ${value.actualRevision}.`,
        resource: value.scheduleID,
      })
    }
    case "ScheduledPrompt.InvalidStateError": {
      const value = error as ScheduledPromptV2.InvalidStateError
      return new ConflictError({
        message: `Cannot ${value.action} a scheduled prompt in ${value.status} state.`,
        resource: value.scheduleID,
      })
    }
    case "ScheduledPrompt.NotFoundError": {
      const value = error as ScheduledPromptV2.NotFoundError
      return new ScheduledPromptNotFoundError({
        sessionID: value.sessionID,
        scheduleID: value.scheduleID,
        message: `Scheduled prompt not found: ${value.scheduleID}`,
      })
    }
    case "Session.BusyError": {
      const value = error as SessionV2.BusyError
      return new ConflictError({
        message: `Session is active and cannot ${value.operation}.`,
        resource: value.sessionID,
      })
    }
    case "Session.PromptConflictError": {
      const value = error as SessionV2.PromptConflictError
      return new ConflictError({
        message: `Scheduled prompt delivery conflicts with durable message ${value.messageID}.`,
        resource: value.messageID,
      })
    }
    case "Session.NotFoundError": {
      const value = error as SessionV2.NotFoundError
      return new SessionNotFoundError({
        sessionID: value.sessionID,
        message: `Session not found: ${value.sessionID}`,
      })
    }
    default:
      return error
  }
}
