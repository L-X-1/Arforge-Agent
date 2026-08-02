import { MultimodalDiagnosisV2 } from "@arforge-ai/core/multimodal-diagnosis"
import { InvalidRequestError } from "@arforge-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const MultimodalDiagnosisHandler = HttpApiBuilder.group(Api, "server.multimodalDiagnosis", (handlers) =>
  handlers.handle(
    "multimodalDiagnosis.diagnose",
    Effect.fn(function* (ctx) {
      return {
        data: yield* (yield* MultimodalDiagnosisV2.Service)
          .diagnose(ctx.payload)
          .pipe(
            Effect.catchTag(
              "MultimodalDiagnosis.PathError",
              (error) => new InvalidRequestError({ field: "filename", message: error.message }),
            ),
          ),
      }
    }),
  ),
)
