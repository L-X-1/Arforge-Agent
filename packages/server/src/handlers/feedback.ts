import { FeedbackV2 } from "@arforge-ai/core/feedback"
import { InvalidRequestError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const FeedbackHandler = HttpApiBuilder.group(Api, "server.feedback", (handlers) =>
  handlers
    .handle(
      "feedback.submit",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* FeedbackV2.Service).submit(ctx.payload).pipe(
            Effect.catchTag(
              "Feedback.InvalidMessageError",
              (error) => new InvalidRequestError({ field: "message", message: error.message }),
            ),
            Effect.catchTag(
              "Feedback.InvalidSessionError",
              (error) => new InvalidRequestError({ field: "sessionID", message: error.message }),
            ),
          ),
        }
      }),
    )
    .handle(
      "feedback.list",
      Effect.fn(function* (ctx) {
        return {
          data: yield* (yield* FeedbackV2.Service).list({
            limit: ctx.query.limit,
            category: ctx.query.category,
          }),
        }
      }),
    )
    .handle(
      "feedback.summary",
      Effect.fn(function* () {
        return { data: yield* (yield* FeedbackV2.Service).summary() }
      }),
    )
    .handle(
      "feedback.delete",
      Effect.fn(function* (ctx) {
        return { data: yield* (yield* FeedbackV2.Service).delete(ctx.params.feedbackID) }
      }),
    ),
)
