import { createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import { readFile } from "node:fs/promises"
import { Effect, Option, RcMap, Schema } from "effect"
import { Config } from "@arforge-ai/core/config"
import { ConfigProvider } from "@arforge-ai/core/config/provider"
import * as ModelsDev from "@arforge-ai/core/models-dev"
import { ModelPresets } from "@arforge-ai/core/model-presets"
import * as ConfigurationData from "./provider-configuration-data"
import { runSavedModelTest } from "@arforge-ai/core/provider-model-test"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { HttpClient } from "effect/unstable/http"
import { Global } from "@arforge-ai/core/global"
import { Integration } from "@arforge-ai/core/integration"
import { Credential } from "@arforge-ai/core/credential"
import { providerCredentialTarget, providerCredentialTargetKey } from "@arforge-ai/core/provider-credential-target"
import { LocationServiceMap } from "@arforge-ai/core/location-services"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { IdentityContext } from "./identity-context"
import {
  ConflictError,
  InvalidRequestError,
  ServiceUnavailableError,
  ProviderNotFoundError,
} from "@arforge-ai/protocol/errors"
import {
  ProviderConfigurationForbidden,
  ProviderConfigurationInput,
  ProviderConfigurationCredential,
} from "@arforge-ai/protocol/groups/provider"

const revisionKey = randomBytes(32)
// Both the standalone server and the embedded CLI/Desktop factory must expose
// these route-construction dependencies. Keep one declaration for both graphs.
export const providerConfigurationDependencies = LayerNode.group([
  Global.node,
  FSUtil.node,
  EffectFlock.node,
  LocationServiceMap.node,
])
// Location middleware intentionally replaces the request context. Capture only
// host dependencies at route construction; principal and Integration stay per request.
export const providerConfigurationScope = Effect.gen(function* () {
  const global = yield* Global.Service,
    fs = yield* FSUtil.Service,
    flock = yield* EffectFlock.Service,
    locations = yield* LocationServiceMap.Service,
    modelsDev = yield* ModelsDev.Service,
    http = yield* HttpClient.HttpClient
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Global.Service, global),
      Effect.provideService(FSUtil.Service, fs),
      Effect.provideService(EffectFlock.Service, flock),
      Effect.provideService(LocationServiceMap.Service, locations),
      Effect.provideService(ModelsDev.Service, modelsDev),
      Effect.provideService(HttpClient.HttpClient, http),
    )
})
type ProviderConfig = typeof ConfigProvider.Info.Type
export const hostConfigurationAllowed = (principal?: IdentityContext.Principal) =>
  !!principal &&
  principal.userID === IdentityContext.LocalPrincipal.userID &&
  principal.tenantID === IdentityContext.LocalPrincipal.tenantID &&
  principal.sessionID === IdentityContext.LocalPrincipal.sessionID &&
  principal.role === "owner"
const principalAllowed = Effect.gen(function* () {
  const principal = yield* Effect.serviceOption(IdentityContext.Current)
  return hostConfigurationAllowed(Option.getOrUndefined(principal))
})
export const authorizeConfiguration = Effect.gen(function* () {
  if (!(yield* principalAllowed))
    return yield* new ProviderConfigurationForbidden({
      message: "Host provider configuration is read-only for this source.",
    })
})
const revision = (provider: ProviderConfig) =>
  createHmac("sha256", revisionKey).update(JSON.stringify(provider)).digest("hex")
const managed = ConfigurationData.managed
const decodeProviders = (text: string, file?: string) => {
  const documents = Config.decodeDocument(text, file)
  if (!documents.length) throw new Error("invalid-configuration")
  return Object.assign({}, ...documents.map((document) => document.info.providers ?? {})) as Record<
    string,
    ProviderConfig
  >
}
const readProviders = Effect.fn(function* () {
  const global = yield* Global.Service
  return yield* Effect.tryPromise({
    try: async () => {
      for (const name of ["arforge.jsonc", "arforge.json", "config.json"]) {
        const file = path.join(global.config, name)
        try {
          return decodeProviders(await readFile(file, "utf8"), file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      return {} as Record<string, ProviderConfig>
    },
    catch: () =>
      new ServiceUnavailableError({
        message: "Provider configuration could not be read.",
        service: "provider-configuration",
      }),
  })
})
const invalid = (message: string) => new InvalidRequestError({ message, kind: "provider_configuration" })
const conflict = () =>
  new ConflictError({
    message: "Provider configuration changed. Read the source again before retrying.",
    resource: "provider-configuration",
  })
const receipt = (id: string, config: ProviderConfig) => ({
  providerID: id,
  revision: revision(config),
  disabled: config.disabled === true,
})
const invalidate = Effect.fn(function* () {
  const locations = yield* LocationServiceMap.Service
  for (const key of Array.from(yield* RcMap.keys(locations.rcMap))) yield* locations.invalidate(key)
})
const write = Effect.fn(function* (
  id: string,
  provider: ProviderConfig,
  expected: string | undefined,
  removed: readonly string[] = [],
  clearedDefaults: readonly string[] = [],
) {
  const global = yield* Global.Service
  // Schema optional fields encode as undefined. They are absent JSON fields,
  // not delete commands for the canonical partial-document writer.
  const patch: Record<string, unknown> = JSON.parse(
    Schema.encodeSync(Schema.fromJsonString(ConfigProvider.Info))(provider),
  )
  const result = yield* Config.updateDocument(
    global.config,
    { providers: { [id]: patch } },
    {
      removePaths: [
        ...removed.map((modelID) => ["providers", id, "models", modelID]),
        ...clearedDefaults.map((modelID) => ["providers", id, "models", modelID, "request", "variant"]),
      ],
      beforePatch: (document) => {
        const previous = decodeProviders(document.text, document.path)[id]
        if (
          previous &&
          (!managed(previous) ||
            (expected ? revision(previous) !== expected : revision(previous) !== revision(provider)))
        )
          throw new Error("provider-configuration-conflict")
        if (!previous && expected) throw new Error("provider-configuration-conflict")
      },
    },
  ).pipe(
    Effect.catch(() =>
      Effect.fail(
        new ServiceUnavailableError({
          message: "Provider configuration could not be saved.",
          service: "provider-configuration",
        }),
      ),
    ),
    Effect.catchDefect(
      (error): Effect.Effect<never, ConflictError | ServiceUnavailableError> =>
        String(error).includes("provider-configuration-conflict")
          ? Effect.fail(conflict())
          : Effect.fail(
              new ServiceUnavailableError({
                message: "Provider configuration could not be saved.",
                service: "provider-configuration",
              }),
            ),
    ),
  )
  if (result.changed) yield* invalidate()
  const saved = decodeProviders(result.text, result.path)[id]
  if (!saved) return yield* invalid("Provider configuration was not saved.")
  return receipt(id, saved)
})

export const configurationCapability = Effect.fn(function* () {
  if (!(yield* principalAllowed))
    return { canWrite: false, reason: "host_configuration_readonly" as const, providers: [] }
  const providers = yield* readProviders()
  return {
    canWrite: true,
    reason: "host_owner" as const,
    providers: Object.entries(providers)
      .filter(([, provider]) => managed(provider))
      .map(([id, provider]) => ({
        id,
        revision: revision(provider),
        disabled: provider.disabled === true,
        canDisconnect: !provider.env?.length,
      })),
  }
})
export const saveConfiguration = Effect.fn(function* (id: string, input: typeof ProviderConfigurationInput.Type) {
  yield* authorizeConfiguration
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) return yield* invalid("Provider ID is invalid.")
  const all = yield* readProviders()
  const previous = Object.hasOwn(all, id) ? all[id] : undefined
  const presets = input.models.some(
    (model) => model.preset !== undefined && previous?.models?.[model.id]?.variants === undefined,
  )
    ? yield* Effect.flatMap(ModelsDev.Service, (modelsDev) => modelsDev.get()).pipe(
        Effect.flatMap((snapshot) =>
          Effect.try({
            try: () => ModelPresets.project(snapshot),
            catch: () => invalid("Model presets are unavailable."),
          }),
        ),
      )
    : undefined
  const config = yield* Effect.try({
    try: () => ConfigurationData.edit(input, previous, presets),
    catch: () => invalid("Provider adapter, model metadata, deletion or variant is invalid."),
  })
  return yield* write(
    id,
    config,
    input.revision,
    input.deletedModelIDs,
    input.models.filter((model) => model.defaultVariant === null).map((model) => model.id),
  )
})

export const getConfiguration = Effect.fn(function* (id: string) {
  yield* authorizeConfiguration
  const all = yield* readProviders()
  const provider = Object.hasOwn(all, id) ? all[id] : undefined
  if (!provider)
    return yield* new ProviderNotFoundError({
      providerID: ProviderV2.ID.make(id),
      message: "Provider configuration does not exist.",
    })
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const stored = yield* credentials.list(Integration.ID.make(id))
  const active = yield* integrations.connection.active(Integration.ID.make(id))
  const inline =
    typeof provider.request?.body?.apiKey === "string" || typeof provider.api?.settings?.apiKey === "string"
  const described = ConfigurationData.safeURL(provider.api?.url)
  const format = ConfigurationData.apiFormat(provider.api)
  return {
    providerID: id,
    revision: revision(provider),
    name: provider.name ?? id,
    ...(described ? { baseURL: described } : {}),
    ...(format ? { apiFormat: format } : {}),
    adapter: {
      type: provider.api?.type ?? "unsupported",
      ...(provider.api?.type === "aisdk" ? { package: provider.api.package } : {}),
    },
    authentication: provider.authentication ?? (provider.env?.length ? ("required" as const) : ("optional" as const)),
    disabled: provider.disabled === true,
    canWrite: managed(provider),
    credential: {
      configured: stored.length > 0 || active !== undefined || inline,
      reconnectRequired: stored.length > 0 && !active,
      source:
        active?.type === "env"
          ? ("environment" as const)
          : stored.length || inline
            ? ("stored" as const)
            : ("none" as const),
    },
    ...(provider.env?.[0] ? { env: provider.env[0] } : {}),
    models: Object.entries(provider.models ?? {}).map(([modelID, model]) => {
      const api =
        model.api && "type" in model.api
          ? {
              ...model.api,
              url:
                model.api.url ??
                (model.api.type === "aisdk" &&
                provider.api?.type === "aisdk" &&
                model.api.package === provider.api.package
                  ? provider.api.url
                  : undefined),
            }
          : provider.api
      const modelFormat = ConfigurationData.apiFormat(api)
      const limit = ConfigurationData.safeLimits(model.limit)
      return {
        id: modelID,
        name: model.name ?? modelID,
        wireID: model.api?.id ?? modelID,
        disabled: model.disabled === true,
        ...(modelFormat ? { apiFormat: modelFormat } : {}),
        canTest: !!modelFormat && !provider.disabled && !model.disabled,
        ...(limit ? { limit } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
        ...(model.preset ? { preset: model.preset } : {}),
        variants: (model.variants ?? []).map((variant) => variant.id),
        ...(model.request?.variant ? { defaultVariant: model.request.variant } : {}),
      }
    }),
  }
})

export const testConfiguration = Effect.fn(function* (id: string, input: { revision: string; modelID: string }) {
  yield* authorizeConfiguration
  return yield* runSavedModelTest(
    { providerID: id, ...input },
    {
      read: Effect.map(readProviders(), (providers) => (Object.hasOwn(providers, id) ? providers[id] : undefined)),
      revision,
      conflict,
    },
  )
})

export const connectConfigurationCredential = Effect.fn(function* (
  id: string,
  input: typeof ProviderConfigurationCredential.Type,
) {
  yield* authorizeConfiguration
  const config = (yield* readProviders())[id]
  if (!managed(config) || config.disabled || revision(config) !== input.revision) return yield* conflict()
  const headers = input.headers ?? {}
  for (const [name, value] of Object.entries(headers))
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))
      return yield* invalid("Header syntax is invalid.")
  if (!input.key?.trim() && !Object.keys(headers).length)
    return yield* invalid("A key or header is required for credential connection.")
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const expectedCredentials = (yield* credentials.list(Integration.ID.make(id))).map(({ id, version }) => ({
    id,
    version,
  }))
  const target = config.api && providerCredentialTarget(id, config.api)
  if (!target) return yield* invalid("Provider credential target is unavailable.")
  yield* integrations.connection
    .key({
      integrationID: Integration.ID.make(id),
      key: input.key?.trim() ?? "",
      expectedCredentials,
      metadata: {
        [providerCredentialTargetKey]: target,
        ...(Object.keys(headers).length ? { ["arforge.provider.headers.v1"]: headers } : {}),
        ...(config.env?.[0] && !input.key?.trim() ? { ["arforge.provider.key-env.v1"]: config.env[0] } : {}),
      },
    })
    .pipe(
      Effect.catchCause(() =>
        Effect.fail(
          new ServiceUnavailableError({
            message: "Configuration is saved; credential connection failed. Retry the same provider.",
            service: "provider-credential",
          }),
        ),
      ),
    )
  const current = (yield* readProviders())[id]
  if (!managed(current) || current.disabled || revision(current) !== input.revision) return yield* conflict()
  return receipt(id, config)
})
export const disconnectConfiguration = Effect.fn(function* (id: string, expected: string) {
  yield* authorizeConfiguration
  const config = (yield* readProviders())[id]
  if (
    !managed(config) ||
    config.env?.length ||
    (revision(config) !== expected &&
      !(config.disabled && revision(ConfigProvider.Info.make({ ...config, disabled: false })) === expected))
  )
    return yield* conflict()
  const credentials = yield* Credential.Service
  const captured = (yield* credentials.list(Integration.ID.make(id))).map(({ id, version }) => ({ id, version }))
  const result = yield* write(id, ConfigProvider.Info.make({ ...config, disabled: true }), revision(config))
  const integrations = yield* Integration.Service
  // Retain the integration check, but never adopt post-await credential IDs.
  yield* integrations.get(Integration.ID.make(id))
  for (const connection of captured)
    yield* integrations.connection.remove(connection.id, { expectedVersion: connection.version }).pipe(
      Effect.catchCause(() =>
        Effect.fail(
          new ServiceUnavailableError({
            message: "Configuration is disabled; credential removal failed. Retry disconnect.",
            service: "provider-credential",
          }),
        ),
      ),
    )
  return result
})
