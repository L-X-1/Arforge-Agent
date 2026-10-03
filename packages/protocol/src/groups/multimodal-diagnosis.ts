import { MultimodalDiagnosis } from "@arforge-ai/schema/multimodal-diagnosis"
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

export const makeMultimodalDiagnosisGroup = <I extends HttpApiMiddleware.AnyId, S>(
  locationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.multimodalDiagnosis")
    .add(
      HttpApiEndpoint.post("multimodalDiagnosis.diagnose", "/api/diagnostics/multimodal", {
        query: location,
        payload: Schema.Struct({
          filename: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
          extractedText: Schema.String.check(Schema.isMaxLength(500_000)).pipe(Schema.optional),
          limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).pipe(Schema.optional),
          mode: Schema.Literals(["error", "frontend", "javascript"]).pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: MultimodalDiagnosis.Result }),
        error: InvalidRequestError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "multimodal diagnostics",
        description:
          "Read-only local diagnosis for error documents, frontend HTML, and JavaScript. Frontend/JavaScript modes replace the legacy validators with bounded deterministic checks; no network fetches or writes are performed.",
      }),
    )
