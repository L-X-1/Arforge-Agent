import { Model } from "@arforge-ai/schema/model"
import * as ModelPreset from "@arforge-ai/schema/model-preset"
import { optional } from "@arforge-ai/schema/schema"
import { Location } from "@arforge-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const ModelGroup = HttpApiGroup.make("server.model")
  .add(
    HttpApiEndpoint.get("model.default", "/api/model/default", {
      query: LocationQuery,
      success: Location.response(Schema.NullOr(Model.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.default",
          summary: "Get default model",
          description: "Retrieve the default available model, or null when no model is available.",
        }),
      ),
    HttpApiEndpoint.get("model.list", "/api/model", {
      query: Schema.Struct({ ...LocationQuery.fields, includePresets: Schema.Boolean.pipe(optional) }),
      success: Schema.Struct({
        ...Location.response(Schema.Array(Model.Info)).fields,
        presets: ModelPreset.Catalog.pipe(optional),
      }),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.model.list",
          summary: "List models",
          description: "Retrieve available models ordered by release date.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "models",
      description: "Experimental model routes.",
    }),
  )
