import { Learning } from "@arforge-ai/schema/learning"
import { NonNegativeInt } from "@arforge-ai/schema/schema"
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

export const makeLearningGroup = <I extends HttpApiMiddleware.AnyId, S>(locationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.learning")
    .add(
      HttpApiEndpoint.get("learning.dream", "/api/learning/dream", {
        query: location,
        success: Schema.Struct({ data: Learning.Dream }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.get("learning.status", "/api/learning/status", {
        query: location,
        success: Schema.Struct({ data: Learning.Status }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("learning.record", "/api/learning/outcome", {
        payload: Schema.Struct({
          userInput: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
          intent: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100)).pipe(Schema.optional),
          route: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100)).pipe(Schema.optional),
          tools: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100))).pipe(Schema.optional),
          success: Schema.Boolean,
          errorType: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(100)).pipe(Schema.optional),
          errorMessage: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)).pipe(Schema.optional),
          userFeedback: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)).pipe(Schema.optional),
          fixStrategy: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)).pipe(Schema.optional),
          regression: Schema.Boolean.pipe(Schema.optional),
          tokenCount: NonNegativeInt.pipe(Schema.optional),
          responseTimeMs: NonNegativeInt.pipe(Schema.optional),
          tags: Schema.Array(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(64))).pipe(Schema.optional),
          importance: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })).pipe(Schema.optional),
          injectedContextSize: NonNegativeInt.pipe(Schema.optional),
        }),
        query: location,
        success: Schema.Struct({ data: Learning.Outcome }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.delete("learning.undo", "/api/learning/outcome/:outcomeID", {
        params: { outcomeID: Learning.OutcomeID },
        query: location,
        success: Schema.Struct({ data: Learning.UndoResult }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .add(
      HttpApiEndpoint.post("learning.syncDogfood", "/api/learning/dogfood/sync", {
        payload: Schema.Struct({
          candidates: Schema.Array(
            Schema.Struct({
              task: Schema.String,
              success: Schema.Boolean,
              timestamp: Schema.String,
              steps: NonNegativeInt.pipe(Schema.optional),
              toolCalls: Schema.Array(Schema.String).pipe(Schema.optional),
              error: Schema.String.pipe(Schema.optional),
            }),
          ).check(Schema.isMaxLength(1_000)),
        }),
        query: location,
        success: Schema.Struct({ data: Learning.SyncResult }),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "learning",
        description:
          "Workspace-isolated learning outcomes and failure patterns with reversible records and non-causal impact reporting.",
      }),
    )
