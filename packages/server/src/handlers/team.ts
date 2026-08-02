import { TeamV2 } from "@arforge-ai/core/team"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  TeamMemberNotFoundError,
  TeamNotFoundError,
} from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const TeamHandler = HttpApiBuilder.group(Api, "server.team", (handlers) =>
  handlers
      .handle(
        "team.create",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return { data: yield* mapErrors(teams.create({ ...ctx.params, ...ctx.payload })) }
        }),
      )
      .handle(
        "team.get",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return { data: yield* mapErrors(teams.get(ctx.params.sessionID)) }
        }),
      )
      .handle(
        "team.memberAdd",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return {
            data: yield* mapErrors(
              teams.addMember({
                sessionID: ctx.params.sessionID,
                name: ctx.payload.memberName,
                agentID: ctx.payload.agentID,
              }),
            ),
          }
        }),
      )
      .handle(
        "team.memberRemove",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return {
            data: yield* mapErrors(
              teams.removeMember({
                sessionID: ctx.params.sessionID,
                member: ctx.params.memberName,
              }),
            ),
          }
        }),
      )
      .handle(
        "team.messageSend",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return {
            data: yield* mapErrors(teams.sendMessage({ ...ctx.params, ...ctx.payload })),
          }
        }),
      )
      .handle(
        "team.messageList",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return {
            data: yield* mapErrors(teams.listMessages({ ...ctx.params, ...ctx.query })),
          }
        }),
      )
      .handle(
        "team.shutdownRequest",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          return {
            data: yield* mapErrors(
              teams.requestShutdown({
                sessionID: ctx.params.sessionID,
                member: ctx.params.memberName,
                reason: ctx.payload.reason,
              }),
            ),
          }
        }),
      )
      .handle(
        "team.delete",
        Effect.fn(function* (ctx) {
          const teams = yield* TeamV2.Service
          yield* mapErrors(teams.delete(ctx.params))
          return HttpApiSchema.NoContent.make()
        }),
      ),
)

type ApiError<E> = E extends TeamV2.NotFoundError
  ? TeamNotFoundError
  : E extends TeamV2.MemberNotFoundError
    ? TeamMemberNotFoundError
    : E extends TeamV2.AccessDeniedError
      ? ForbiddenError
      : E extends TeamV2.InvalidRecipientError | TeamV2.InvalidRoleError
        ? InvalidRequestError
        : E extends
              | TeamV2.ExistsError
              | TeamV2.InvalidStateError
              | TeamV2.LimitError
              | TeamV2.MemberExistsError
              | TeamV2.MemberStoppedError
              | TeamV2.RoleInUseError
          ? ConflictError
          : E

function mapErrors<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ApiError<E>, R> {
  return effect.pipe(Effect.catch((error) => Effect.fail(toApiError(error)))) as Effect.Effect<A, ApiError<E>, R>
}

function toApiError(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return error
  switch (error._tag) {
    case "Team.NotFoundError": {
      const value = error as TeamV2.NotFoundError
      return new TeamNotFoundError({
        sessionID: value.sessionID,
        message: "The session does not own a durable team.",
      })
    }
    case "Team.MemberNotFoundError": {
      const value = error as TeamV2.MemberNotFoundError
      return new TeamMemberNotFoundError({
        sessionID: value.sessionID,
        member: value.member,
        message: `Team member not found: ${value.member}`,
      })
    }
    case "Team.AccessDeniedError": {
      const value = error as TeamV2.AccessDeniedError
      return new ForbiddenError({ message: `Team member ${value.actor} cannot ${value.action}.` })
    }
    case "Team.InvalidRecipientError": {
      const value = error as TeamV2.InvalidRecipientError
      return new InvalidRequestError({ message: value.message, field: "recipient" })
    }
    case "Team.InvalidRoleError": {
      const value = error as TeamV2.InvalidRoleError
      return new InvalidRequestError({
        message: `Agent ${value.agentID} does not exist or is not configured as a subagent.`,
        field: "agentID",
      })
    }
    case "Team.ExistsError": {
      const value = error as TeamV2.ExistsError
      return new ConflictError({
        resource: value.sessionID,
        message: "This session already owns a durable team.",
      })
    }
    case "Team.InvalidStateError": {
      const value = error as TeamV2.InvalidStateError
      return new ConflictError({ resource: value.member, message: value.message })
    }
    case "Team.LimitError": {
      const value = error as TeamV2.LimitError
      return new ConflictError({
        resource: value.sessionID,
        message: `A team may contain at most ${value.limit} collaborators.`,
      })
    }
    case "Team.MemberExistsError": {
      const value = error as TeamV2.MemberExistsError
      return new ConflictError({ resource: value.member, message: `Team member already exists: ${value.member}` })
    }
    case "Team.MemberStoppedError": {
      const value = error as TeamV2.MemberStoppedError
      return new ConflictError({ resource: value.member, message: `Team member has stopped: ${value.member}` })
    }
    case "Team.RoleInUseError": {
      const value = error as TeamV2.RoleInUseError
      return new ConflictError({
        resource: value.agentID,
        message: `Subagent role is already assigned to a team member: ${value.agentID}`,
      })
    }
    default:
      return error
  }
}
