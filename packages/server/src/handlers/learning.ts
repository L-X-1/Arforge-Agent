import { LearningV2 } from "@arforge-ai/core/learning"
import { InvalidRequestError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LearningHandler = HttpApiBuilder.group(Api, "server.learning", (handlers) =>
  handlers
    .handle(
      "learning.status",
      Effect.fn(function* () {
        return { data: yield* (yield* LearningV2.Service).status() }
      }),
    )
    .handle(
      "learning.record",
      Effect.fn(function* (ctx) {
        return { data: yield* (yield* LearningV2.Service).record(ctx.payload) }
      }),
    )
    .handle(
      "learning.undo",
      Effect.fn(function* (ctx) {
        return { data: yield* (yield* LearningV2.Service).undo(ctx.params.outcomeID) }
      }),
    )
    .handle(
      "learning.syncDogfood",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* LearningV2.Service).syncDogfood(ctx.payload.candidates).pipe(
            Effect.catchTag(
              "Learning.SyncLimitError",
              (error) =>
                new InvalidRequestError({
                  field: "candidates",
                  message: `At most ${error.limit} dogfood outcomes may be synchronized at once.`,
                }),
            ),
          ),
        }
      }),
    ),
)
