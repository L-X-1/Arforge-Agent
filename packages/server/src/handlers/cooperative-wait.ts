import { CooperativeWaitV2 } from "@arforge-ai/core/cooperative-wait"
import { ConflictError, WaitNotFoundError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const CooperativeWaitHandler = HttpApiBuilder.group(Api, "server.cooperativeWait", (handlers) =>
  handlers
    .handle(
      "cooperativeWait.active",
      Effect.fn(function* (ctx) {
        const waits = yield* CooperativeWaitV2.Service
        return { data: (yield* waits.active(ctx.params.sessionID)) ?? null }
      }),
    )
    .handle(
      "cooperativeWait.wake",
      Effect.fn(function* (ctx) {
        const waits = yield* CooperativeWaitV2.Service
        return {
          data: yield* waits
            .wake(ctx.params)
            .pipe(
              Effect.catchTag("CooperativeWait.NotFoundError", (error) =>
                Effect.fail(
                  new WaitNotFoundError({
                    sessionID: error.sessionID,
                    message: "The session has no active cooperative wait.",
                  }),
                ),
              ),
              Effect.catchTag("CooperativeWait.StaleIDError", (error) =>
                Effect.fail(
                  new ConflictError({
                    resource: error.waitID,
                    message: "The active cooperative wait identifier does not match.",
                  }),
                ),
              ),
            ),
        }
      }),
    ),
)
