import * as ProviderConfiguration from "@arforge-ai/schema/provider-configuration"
import { Provider } from "@arforge-ai/schema/provider"
import * as ModelPreset from "@arforge-ai/schema/model-preset"
import { Location } from "@arforge-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, ProviderNotFoundError, ServiceUnavailableError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export class ProviderConfigurationForbidden extends Schema.TaggedErrorClass<ProviderConfigurationForbidden>()(
  "ProviderConfigurationForbidden",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}
export const ProviderConfigurationCapability = Schema.Struct({
  canWrite: Schema.Boolean,
  reason: Schema.Literals(["host_owner", "host_configuration_readonly"]),
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      revision: Schema.String,
      disabled: Schema.Boolean,
      canDisconnect: Schema.Boolean,
    }),
  ),
})
export const ProviderConfigurationModelInput = ModelPreset.ConfigurationInput
export const ProviderApiFormat = ProviderConfiguration.ApiFormat
export const ProviderConfigurationDetail = ProviderConfiguration.Detail
export const ProviderConfigurationTestInput = ProviderConfiguration.TestInput
export const ProviderConfigurationTestResult = ProviderConfiguration.TestResult

export const ProviderConfigurationInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  baseURL: Schema.optional(Schema.String.check(Schema.isPattern(/^https?:\/\//), Schema.isMaxLength(4096))),
  models: Schema.Array(ProviderConfigurationModelInput).check(Schema.isMaxLength(1000)),
  authentication: Schema.optional(Schema.Literals(["optional", "required"])),
  apiFormat: Schema.optional(ProviderApiFormat),
  disabled: Schema.optional(Schema.Boolean),
  deletedModelIDs: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMinLength(1))).check(Schema.isMaxLength(1000)),
  ),
  env: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
  revision: Schema.optional(Schema.String),
})
export const ProviderConfigurationReceipt = Schema.Struct({
  providerID: Schema.String,
  revision: Schema.String,
  disabled: Schema.Boolean,
})
export const ProviderConfigurationCredential = Schema.Struct({
  revision: Schema.String,
  key: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})
const configurationErrors = [
  ProviderConfigurationForbidden,
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
] as const

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.configuration.get", "/api/provider/:providerID/configuration", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(ProviderConfigurationDetail),
      error: [...configurationErrors, ProviderNotFoundError],
    }).annotateMerge(locationQueryOpenApi),
    HttpApiEndpoint.post("provider.configuration.test", "/api/provider/:providerID/configuration/test", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      payload: ProviderConfigurationTestInput,
      success: Location.response(ProviderConfigurationTestResult),
      error: configurationErrors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("provider.configuration.capability", "/api/provider/configuration/capability", {
      query: LocationQuery,
      success: Location.response(ProviderConfigurationCapability),
      error: ServiceUnavailableError,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.put("provider.configuration.save", "/api/provider/:providerID/configuration", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      payload: ProviderConfigurationInput,
      success: Location.response(ProviderConfigurationReceipt),
      error: configurationErrors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("provider.configuration.credential", "/api/provider/:providerID/configuration/credential", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      payload: ProviderConfigurationCredential,
      success: Location.response(ProviderConfigurationReceipt),
      error: configurationErrors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.post("provider.configuration.disconnect", "/api/provider/:providerID/configuration/disconnect", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      payload: Schema.Struct({ revision: Schema.String }),
      success: Location.response(ProviderConfigurationReceipt),
      error: configurationErrors,
    }).annotateMerge(locationQueryOpenApi),
  )
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Provider.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.list",
          summary: "List providers",
          description: "Retrieve active AI providers so clients can show provider availability and configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.Info),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.provider.get",
          summary: "Get provider",
          description: "Retrieve a single AI provider so clients can inspect its availability and endpoint settings.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "providers",
      description: "Experimental provider routes.",
    }),
  )
