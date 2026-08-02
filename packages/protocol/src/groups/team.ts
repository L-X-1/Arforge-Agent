import { Team } from "@arforge-ai/schema/team"
import { Agent } from "@arforge-ai/schema/agent"
import { Session } from "@arforge-ai/schema/session"
import { NonNegativeInt, PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  SessionNotFoundError,
  TeamMemberNotFoundError,
  TeamNotFoundError,
} from "../errors"

const root = "/api/session/:sessionID/team"
const params = { sessionID: Session.ID }
const mutationErrors = [
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  SessionNotFoundError,
  TeamMemberNotFoundError,
  TeamNotFoundError,
]

export const makeTeamGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.team")
    .add(
      HttpApiEndpoint.post("team.create", root, {
        params,
        payload: Schema.Struct({
          name: Team.Name,
          description: Team.Description.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Team.Info }),
        error: [ConflictError, ForbiddenError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.create",
            summary: "Create session team",
            description: "Create the one durable collaboration team owned by this lead session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("team.get", root, {
        params,
        success: Schema.Struct({ data: Team.Info }),
        error: [SessionNotFoundError, TeamNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.team.get", summary: "Get session team" })),
    )
    .add(
      HttpApiEndpoint.post("team.memberAdd", `${root}/member`, {
        params,
        payload: Schema.Struct({
          memberName: Team.CollaboratorName,
          agentID: Agent.ID,
        }),
        success: Schema.Struct({ data: Team.Member }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.memberAdd",
            summary: "Add team member",
            description: "Bind a unique member name to an existing subagent-mode agent configuration.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("team.memberRemove", `${root}/member/:memberName`, {
        params: { ...params, memberName: Team.CollaboratorName },
        success: Schema.Struct({ data: Team.Member }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.memberRemove",
            summary: "Remove stopped team member",
            description: "Remove a member only after that member explicitly approved shutdown.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("team.messageSend", `${root}/message`, {
        params,
        payload: Schema.Struct({
          recipient: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(32)),
          message: Team.MessageText,
          summary: Team.Summary.pipe(Schema.optional),
          kind: Schema.Literals(["info", "request", "result", "alert"]).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Team.Message }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.messageSend",
            summary: "Send lead team message",
            description: "Send directly or to '*' within the current session team. Cross-team addressing is impossible.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("team.messageList", `${root}/message`, {
        params,
        query: {
          afterSequence: NonNegativeInt.pipe(Schema.optional),
          limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Team.Inbox }),
        error: [SessionNotFoundError, TeamMemberNotFoundError, TeamNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.messageList",
            summary: "List lead inbox",
            description: "List only messages addressed to the implicit lead member.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("team.shutdownRequest", `${root}/member/:memberName/shutdown`, {
        params: { ...params, memberName: Team.CollaboratorName },
        payload: Schema.Struct({ reason: Team.ShutdownReason.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Team.Shutdown }),
        error: mutationErrors,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.shutdownRequest",
            summary: "Request member shutdown",
            description: "Start the required graceful shutdown handshake. Only that member can answer through its tool context.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("team.delete", root, {
        params,
        success: HttpApiSchema.NoContent,
        error: [ConflictError, ForbiddenError, SessionNotFoundError, TeamNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.team.delete",
            summary: "Delete session team",
            description: "Atomically delete the team, mailbox, and shutdown metadata after all collaborators stopped.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "teams",
        description: "Session-owned durable team, isolated mailbox, and graceful shutdown lifecycle.",
      }),
    )
