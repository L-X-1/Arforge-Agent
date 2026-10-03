import { PersonalJobV2 } from "@arforge-ai/core/personal-job"
import { PersonalJobExecutor } from "@arforge-ai/core/personal-job-executor"
import { SessionV2 } from "@arforge-ai/core/session"
import { PersonalJob } from "@arforge-ai/schema/personal-job"
import {
  ConflictError,
  InvalidRequestError,
  PersonalJobNotFoundError,
  SessionNotFoundError,
} from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const PersonalJobHandler = HttpApiBuilder.group(Api, "server.personalJob", (handlers) =>
  Effect.gen(function* () {
    const jobs = yield* PersonalJobV2.Service
    const executor = yield* PersonalJobExecutor.Service

    const scoped = <A, E>(sessionID: string, jobID: PersonalJob.ID, action: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const notFound = () =>
          new PersonalJobNotFoundError({
            sessionID,
            jobID,
            message: `Personal background job not found: ${jobID}`,
          })
        const current = yield* jobs.get(jobID).pipe(
          Effect.mapError((error) => (error instanceof PersonalJobV2.NotFoundError ? notFound() : error)),
        )
        if (current.sessionID !== sessionID) return yield* notFound()
        return yield* action.pipe(Effect.mapError((error) => (error instanceof PersonalJobV2.NotFoundError ? notFound() : error)))
      })

    return handlers
      .handle(
        "personalJob.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(jobs.create({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "personalJob.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(jobs.list({ sessionID: ctx.params.sessionID, status: ctx.query.status })),
          }
        }),
      )
      .handle(
        "personalJob.get",
        Effect.fn(function* (ctx) {
          return { data: yield* mapErrors(scoped(ctx.params.sessionID, ctx.params.jobID, jobs.get(ctx.params.jobID))) }
        }),
      )
      .handle(
        "personalJob.approve",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                jobs.approve({ jobID: ctx.params.jobID, expectedRevision: ctx.payload.expectedRevision }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.reject",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                jobs.reject({ ...ctx.params, ...ctx.payload }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.start",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                jobs.start({ jobID: ctx.params.jobID, expectedRevision: ctx.payload.expectedRevision }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.execute",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                executor.launch({
                  jobID: ctx.params.jobID,
                  expectedRevision: ctx.payload.expectedRevision,
                  allowEarly: true,
                }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.dispatch",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              executor.dispatchDue({ sessionID: SessionV2.ID.make(ctx.params.sessionID), limit: ctx.payload.limit }),
            ),
          }
        }),
      )
      .handle(
        "personalJob.pause",
        Effect.fn(function* (ctx) {
          const data = yield* mapErrors(
            scoped(
              ctx.params.sessionID,
              ctx.params.jobID,
              jobs.pause({ jobID: ctx.params.jobID, expectedRevision: ctx.payload.expectedRevision }),
            ),
          )
          yield* executor.interrupt({
            jobID: ctx.params.jobID,
            sessionID: SessionV2.ID.make(ctx.params.sessionID),
          })
          return {
            data,
          }
        }),
      )
      .handle(
        "personalJob.resume",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                jobs.resume({ jobID: ctx.params.jobID, expectedRevision: ctx.payload.expectedRevision }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.cancel",
        Effect.fn(function* (ctx) {
          const data = yield* mapErrors(
            scoped(
              ctx.params.sessionID,
              ctx.params.jobID,
              jobs.cancel({ ...ctx.params, ...ctx.payload }),
            ),
          )
          yield* executor.interrupt({
            jobID: ctx.params.jobID,
            sessionID: SessionV2.ID.make(ctx.params.sessionID),
          })
          return {
            data,
          }
        }),
      )
      .handle(
        "personalJob.notifications",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(ctx.params.sessionID, ctx.params.jobID, jobs.notifications(ctx.params.jobID)),
            ),
          }
        }),
      )
      .handle(
        "personalJob.notificationRead",
        Effect.fn(function* (ctx) {
          return {
            data: yield* mapErrors(
              scoped(
                ctx.params.sessionID,
                ctx.params.jobID,
                jobs.markNotificationRead({ ...ctx.params, ...ctx.payload }),
              ),
            ),
          }
        }),
      )
      .handle(
        "personalJob.delete",
        Effect.fn(function* (ctx) {
          yield* mapErrors(
            scoped(
              ctx.params.sessionID,
              ctx.params.jobID,
              jobs.delete({ jobID: ctx.params.jobID, expectedRevision: ctx.payload.expectedRevision }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

type ApiError<E> = E extends PersonalJobV2.NotFoundError
  ? PersonalJobNotFoundError
  : E extends
        | PersonalJobV2.IdempotencyConflictError
        | PersonalJobV2.StaleRevisionError
        | PersonalJobV2.InvalidStateError
        | PersonalJobV2.ApprovalError
        | PersonalJobV2.ScheduleNotDueError
        | PersonalJobV2.BudgetExhaustedError
        | PersonalJobV2.RetentionActiveError
        | PersonalJobV2.CorruptHistoryError
        | PersonalJobExecutor.NotRunnableError
        | PersonalJobExecutor.CredentialBindingUnavailableError
    ? ConflictError
    : E extends PersonalJobV2.InvalidInputError | PersonalJobV2.CredentialScopeError
      ? InvalidRequestError
      : E extends SessionV2.NotFoundError
        ? SessionNotFoundError
        : E

function mapErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ApiError<E>, R> {
  return effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error)))) as Effect.Effect<A, ApiError<E>, R>
}

function toApiError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return error
  switch (error._tag) {
    case "PersonalJob.NotFoundError": {
      // Item operations translate this error in `scoped`, where the route
      // session is available. Keep an unexpected unscoped error unchanged so
      // a fabricated session identity can never cross the API boundary.
      return error
    }
    case "PersonalJob.InvalidInputError": {
      const value = error as PersonalJobV2.InvalidInputError
      return new InvalidRequestError({ message: value.message })
    }
    case "PersonalJob.CredentialScopeError": {
      const value = error as PersonalJobV2.CredentialScopeError
      return new InvalidRequestError({
        field: "credentialIDs",
        message: `Credential IDs are not available to this user: ${value.missing.join(", ")}`,
      })
    }
    case "PersonalJob.IdempotencyConflictError":
    case "PersonalJob.StaleRevisionError":
    case "PersonalJob.InvalidStateError":
    case "PersonalJob.ApprovalError":
    case "PersonalJob.ScheduleNotDueError":
    case "PersonalJob.BudgetExhaustedError":
    case "PersonalJob.RetentionActiveError":
    case "PersonalJob.CorruptHistoryError":
    case "PersonalJobExecutor.NotRunnableError":
    case "PersonalJobExecutor.CredentialBindingUnavailableError": {
      const value = error as { readonly jobID?: string; readonly message?: string; readonly reason?: string }
      return new ConflictError({
        resource: value.jobID,
        message: value.message ?? value.reason ?? "The personal background job changed and must be refreshed.",
      })
    }
    case "Session.NotFoundError": {
      const value = error as SessionV2.NotFoundError
      return new SessionNotFoundError({ sessionID: value.sessionID, message: `Session not found: ${value.sessionID}` })
    }
    default:
      return error
  }
}
