import { Feedback } from "@arforge-ai/schema/feedback"
import { Session } from "@arforge-ai/schema/session"
import { PositiveInt } from "@arforge-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { locationQueryOpenApi } from "./location"

const location = {
  location: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      workspace: Schema.optional(Schema.String),
    }),
  ),
}

export const makeFeedbackGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.feedback")
    .add(
      HttpApiEndpoint.post("feedback.submit", "/api/feedback", {
        query: location,
        payload: Schema.Struct({
          category: Feedback.Category,
          rating: Feedback.Rating,
          message: Feedback.Message,
          sessionID: Session.ID.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Feedback.SubmitResult }),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("feedback.list", "/api/feedback", {
        query: {
          ...location,
          limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(Schema.optional),
          category: Feedback.Category.pipe(Schema.optional),
        },
        success: Schema.Struct({ data: Feedback.Page }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("feedback.summary", "/api/feedback/summary", {
        query: location,
        success: Schema.Struct({ data: Feedback.Summary }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.delete("feedback.delete", "/api/feedback/:feedbackID", {
        params: { feedbackID: Feedback.ID },
        query: location,
        success: Schema.Struct({ data: Feedback.DeleteResult }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "feedback",
        description: "Explicit bounded product feedback stored only in the local database after credential redaction.",
      }),
    )
