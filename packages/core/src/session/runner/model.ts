export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model } from "@arforge-ai/llm"
import * as AnthropicMessages from "@arforge-ai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@arforge-ai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@arforge-ai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@arforge-ai/llm/route"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { produce } from "immer"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import * as CredentialStore from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"
import type * as RuntimeRetry from "../../runtime/retry"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export class CredentialScopeError extends Schema.TaggedErrorClass<CredentialScopeError>()(
  "SessionRunnerModel.CredentialScopeError",
  {
    sessionID: SessionSchema.ID,
    providerID: ProviderV2.ID,
    credentialIDs: Schema.Array(Credential.ID),
  },
) {
  override get message() {
    return `No credential in the job scope is available for provider ${this.providerID}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | CredentialScopeError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
  /** Uses the existing catalog policy; never changes provider or drops required input capabilities. */
  readonly resolveSmall?: (
    session: SessionSchema.Info,
    requiredInput: readonly string[],
  ) => Effect.Effect<Model | undefined, Error>
  /** Optional policy-selected fallback. The caller must ensure no visible or executable output started. */
  readonly resolveFallback?: (
    session: SessionSchema.Info,
    failedModel: Model,
    category: RuntimeRetry.FailureCategory,
  ) => Effect.Effect<Model | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SessionRunnerModel") {}

// Runtime binding on the resolved model, not another credential store. Only
// the non-secret identity is copied into durable request envelopes.
const credentialBindings = new WeakMap<
  Model,
  {
    readonly identity: NonNullable<Integration.ResolvedCredential["identity"]>
    readonly validate: Effect.Effect<void>
  }
>()

export const credentialIdentity = (model: Model) => credentialBindings.get(model)?.identity
export const validateCredential = (model: Model): Effect.Effect<void> =>
  credentialBindings.get(model)?.validate ?? Effect.void

/** One-run credential scope; undefined preserves the normal active-integration policy. */
export const CredentialScope = Context.Reference<ReadonlyArray<Credential.ID> | undefined>(
  "@arforge/v2/SessionRunnerModel/credential-scope",
  { defaultValue: () => undefined },
)

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"], resolveFallback?: Interface["resolveFallback"]) =>
  Layer.succeed(Service, Service.of(resolveFallback === undefined ? { resolve } : { resolve, resolveFallback }))

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(resolved, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(resolved, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: resolved.api.id }),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withDefaults(resolved, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: resolved.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const credentials = yield* CredentialStore.Service
    const resolveBound = Effect.fn("SessionRunnerModel.resolveBound")(function* (
      session: SessionSchema.Info,
      selected: ModelV2.Info,
      snapshot: Integration.ResolvedCredential | undefined,
    ) {
      const model = yield* resolve(session, selected, snapshot?.value)
      if (snapshot?.identity) {
        const identity = Object.freeze({ ...snapshot.identity })
        const validate = Effect.gen(function* () {
          const current = yield* credentials.get(identity.id)
          if (!current || current.version !== identity.version)
            return yield* Effect.die(new Error("Model credential changed or was removed; resolve the model again"))
        })
        yield* validate
        credentialBindings.set(model, { identity, validate })
      }
      return model
    })
    const resolveCandidate = Effect.fn("SessionRunnerModel.resolveCandidate")(function* (
      session: SessionSchema.Info,
      selected: ModelV2.Info,
    ) {
      const provider = yield* catalog.provider.get(selected.providerID)
      const integrationID = provider?.integrationID ?? Integration.ID.make(selected.providerID)
      const scope = yield* CredentialScope
      if (scope === undefined) {
        const connection = yield* integrations.connection.active(integrationID)
        const snapshot = connection ? yield* integrations.connection.resolveSnapshot(connection) : undefined
        if (connection && !snapshot)
          return yield* Effect.die(new Error("Selected model credential is no longer available"))
        return yield* resolveBound(session, selected, snapshot)
      }

      let selectedCredential: CredentialStore.Info | undefined
      for (const credentialID of scope) {
        const candidate = yield* credentials.get(credentialID)
        if (candidate?.integrationID === integrationID) {
          selectedCredential = candidate
          break
        }
      }
      if (!selectedCredential)
        return yield* new CredentialScopeError({
          sessionID: session.id,
          providerID: selected.providerID,
          credentialIDs: [...scope],
        })
      const snapshot = yield* integrations.connection.resolveSnapshot({
        type: "credential",
        id: selectedCredential.id,
        label: selectedCredential.label,
      })
      if (!snapshot || snapshot.identity?.id !== selectedCredential.id)
        return yield* new CredentialScopeError({
          sessionID: session.id,
          providerID: selected.providerID,
          credentialIDs: [...scope],
        })
      return yield* resolveBound(session, selected, snapshot)
    })
    return Service.of({
      resolveSmall: Effect.fn("SessionRunnerModel.resolveSmall")(function* (session, requiredInput) {
        const reference = session.model ?? (yield* catalog.model.default())
        if (!reference) return undefined
        const candidate = yield* catalog.model.small(reference.providerID)
        if (!candidate || candidate.providerID !== reference.providerID || !supported(candidate)) return undefined
        const available = (yield* catalog.model.available()).find(
          (item) => item.providerID === candidate.providerID && item.id === candidate.id,
        )
        if (!available || !supported(available)) return undefined
        if (
          !requiredInput.every((mime) =>
            available.capabilities.input.some(
              (supported) =>
                supported === mime || supported === mime.split("/")[0] || supported === `${mime.split("/")[0]}/*`,
            ),
          )
        )
          return undefined
        // An automatic model switch must not inherit a variant belonging to the main model.
        return yield* resolveCandidate(
          { ...session, model: { providerID: available.providerID, id: available.id } },
          available,
        )
      }),
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        const defaultModel = session.model ? undefined : yield* catalog.model.default()
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) => model.providerID === session.model?.providerID && model.id === session.model.id,
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        return yield* resolveCandidate(session, selected)
      }),
      resolveFallback: Effect.fn("SessionRunnerModel.resolveFallback")(function* (session, failedModel) {
        if (session.model) return undefined
        const candidates = (yield* catalog.model.available()).filter(
          (candidate) =>
            supported(candidate) &&
            !(candidate.providerID === String(failedModel.provider) && candidate.id === String(failedModel.id)),
        )
        for (const candidate of candidates) {
          const resolved = yield* resolveCandidate(session, candidate).pipe(Effect.option)
          if (Option.isSome(resolved)) return resolved.value
        }
        return undefined
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, CredentialStore.node],
})
