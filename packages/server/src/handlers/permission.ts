import { Location } from "@arforge-ai/core/location"
import { Authorizer } from "@arforge-ai/core/authorizer"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { PermissionSaved } from "@arforge-ai/core/permission/saved"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { PermissionNotFoundError, SessionNotFoundError } from "@arforge-ai/protocol/errors"
import { response } from "../location"

function missingRequest(id: PermissionV2.ID) {
  return new PermissionNotFoundError({ requestID: id, message: `Permission request not found: ${id}` })
}

function isSessionRequest(
  request: Authorizer.PendingRequest,
  sessionID?: PermissionV2.Request["sessionID"],
): request is PermissionV2.Request {
  return "sessionID" in request && (sessionID === undefined || request.sessionID === sessionID)
}

export const PermissionHandler = HttpApiBuilder.group(Api, "server.permission", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "permission.request.list",
        Effect.fn(function* () {
          const authorizer = yield* Authorizer.Service
          return yield* response(
            authorizer.list().pipe(Effect.map((requests) => requests.filter((request) => isSessionRequest(request)))),
          )
        }),
      )
      .handle(
        "session.permission.create",
        Effect.fn(function* (ctx) {
          const permission = yield* PermissionV2.Service
          return {
            data: yield* permission
              .ask({
                id: ctx.payload.id,
                sessionID: ctx.params.sessionID,
                action: ctx.payload.action,
                resources: ctx.payload.resources,
                save: ctx.payload.save,
                metadata: ctx.payload.metadata,
                source: ctx.payload.source,
                agent: ctx.payload.agent,
              })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.permission.list",
        Effect.fn(function* (ctx) {
          const authorizer = yield* Authorizer.Service
          return {
            data: (yield* authorizer.list()).filter((request) => isSessionRequest(request, ctx.params.sessionID)),
          }
        }),
      )
      .handle(
        "session.permission.get",
        Effect.fn(function* (ctx) {
          const request = yield* (yield* Authorizer.Service).get(ctx.params.requestID)
          if (!request || !isSessionRequest(request, ctx.params.sessionID))
            return yield* missingRequest(ctx.params.requestID)
          return { data: request }
        }),
      )
      .handle(
        "session.permission.reply",
        Effect.fn(function* (ctx) {
          const authorizer = yield* Authorizer.Service
          const request = yield* authorizer.get(ctx.params.requestID)
          if (!request || !isSessionRequest(request, ctx.params.sessionID))
            return yield* missingRequest(ctx.params.requestID)
          yield* authorizer
            .reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
            .pipe(Effect.catchTag("PermissionV2.NotFoundError", () => missingRequest(ctx.params.requestID)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "permission.saved.list",
        Effect.fn(function* (ctx) {
          const location = yield* Location.Service
          return {
            data: yield* (yield* PermissionSaved.Service).list({
              projectID: ctx.query.projectID ?? location.project.id,
            }),
          }
        }),
      )
      .handle(
        "permission.saved.remove",
        Effect.fn(function* (ctx) {
          yield* (yield* PermissionSaved.Service).remove(ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
