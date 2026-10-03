import { PermissionV1 } from "@arforge-ai/core/v1/permission"
import { PermissionV2 } from "@arforge-ai/core/permission"
import { Permission } from "@/permission"
import { InstanceState } from "@/effect/instance-state"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { Location } from "@arforge-ai/core/location"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const locations = yield* LocationServiceMap.Service
    const inLocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return yield* effect.pipe(
          Effect.provide(
            locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) })),
          ),
        )
      })

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      const [legacy, next] = yield* Effect.all([
        svc.list(),
        inLocation(PermissionV2.Service.use((current) => current.list())),
      ])
      const ids = new Set(legacy.map((request) => request.id))
      return [
        ...legacy,
        ...next.flatMap((request): PermissionV1.Request[] => {
          if (ids.has(request.id as unknown as PermissionV1.ID)) return []
          return [
            {
              id: request.id as unknown as PermissionV1.ID,
              sessionID: request.sessionID,
              permission: request.action,
              patterns: [...request.resources],
              metadata: request.metadata ?? {},
              always: [...(request.save ?? [])],
              tool:
                request.source?.type === "tool"
                  ? { messageID: request.source.messageID, callID: request.source.callID }
                  : undefined,
              requiresHumanConfirmation: request.requiresHumanConfirmation === true,
            },
          ]
        }),
      ]
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      const requestID = ctx.params.requestID as unknown as PermissionV2.ID
      const modern = yield* inLocation(PermissionV2.Service.use((current) => current.get(requestID)))
      if (modern) {
        yield* inLocation(
          PermissionV2.Service.use((current) =>
            current.reply({
              requestID,
              reply: ctx.payload.reply,
              message: ctx.payload.message,
            }),
          ),
        )
          .pipe(
            Effect.catchTag("PermissionV2.NotFoundError", (error) =>
              Effect.fail(
                new PermissionNotFoundError({
                  requestID: String(error.requestID),
                  message: `Permission request not found: ${error.requestID}`,
                }),
              ),
            ),
          )
        return true
      }
      yield* svc.reply({
        requestID: ctx.params.requestID,
        reply: ctx.payload.reply,
        message: ctx.payload.message,
      }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
