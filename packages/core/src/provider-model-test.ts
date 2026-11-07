import { Clock, Effect, Option, Schema } from "effect"
import { Catalog } from "@arforge-ai/core/catalog"
import { Credential } from "@arforge-ai/core/credential"
import { Integration } from "@arforge-ai/core/integration"
import { SecretProvider } from "@arforge-ai/core/secret-provider"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { providerCredentialTarget, providerCredentialTargetKey } from "@arforge-ai/core/provider-credential-target"
import { LLM, LLMError } from "@arforge-ai/llm"
import { Probe } from "@arforge-ai/llm/probe"
import { LLMClient, RequestExecutor } from "@arforge-ai/llm/route"
import * as ProviderConfiguration from "@arforge-ai/schema/provider-configuration"
import type { ConfigProvider } from "./config/provider"
type ProviderConfig = typeof ConfigProvider.Info.Type

export const TEST_TIMEOUT_MS = 25000
export const TEST_OUTPUT_CAP = 512
type Result = ProviderConfiguration.TestResult
type Category = Result["category"]

function classify(error: unknown): { category: Category; httpStatus?: number } {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    ["TimeoutError", "TimeoutException"].includes(String(error._tag))
  )
    return { category: "timeout" }
  if (!Schema.is(LLMError)(error)) return { category: "unknown" }
  const reason = error.reason
  const httpStatus = "http" in reason ? reason.http?.response?.status : undefined
  if (httpStatus === 401 || httpStatus === 403) return { category: "authentication", httpStatus }
  if (httpStatus === 404) return { category: "model-not-found", httpStatus }
  const category: Category =
    reason._tag === "Authentication"
      ? "authentication"
      : reason._tag === "RateLimit"
        ? "rate-limit"
        : reason._tag === "QuotaExceeded"
          ? "quota"
          : reason._tag === "Transport"
            ? "transport"
            : ["InvalidProviderOutput", "InvalidRequest"].includes(reason._tag)
              ? "invalid-response"
              : "unknown"
  return { category, ...(httpStatus === undefined ? {} : { httpStatus }) }
}

/** One explicit saved-model diagnostic. No Session, history, catalog mutation or retry. */
export function runSavedModelTest<E, R, C>(
  input: { providerID: string; modelID: string; revision: string },
  dependencies: {
    read: Effect.Effect<ProviderConfig | undefined, E, R>
    revision: (provider: ProviderConfig) => string
    conflict: () => C
  },
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const fence = Effect.gen(function* () {
        const current = yield* dependencies.read
        if (!current || dependencies.revision(current) !== input.revision)
          return yield* Effect.fail(dependencies.conflict())
        return current
      })
      const provider = yield* fence
      const finish = Effect.fn(function* (category: Category, httpStatus?: number) {
        yield* fence
        return {
          ...input,
          outcome: category === "ok" ? ("success" as const) : ("failure" as const),
          category,
          latencyMs: Math.max(0, Math.floor((yield* Clock.currentTimeMillis) - started)),
          ...(httpStatus === undefined ? {} : { httpStatus }),
        }
      })
      const configured =
        provider.models && Object.hasOwn(provider.models, input.modelID) ? provider.models[input.modelID] : undefined
      if (!configured || provider.disabled || configured.disabled) return yield* finish("unavailable")
      const catalog = yield* Catalog.Service
      const selected = yield* catalog.model.get(ProviderV2.ID.make(input.providerID), ModelV2.ID.make(input.modelID))
      if (!selected || !selected.enabled) return yield* finish("unavailable")
      if (!SessionRunnerModel.supported(selected)) return yield* finish("unsupported")
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const catalogProvider = yield* catalog.provider.get(selected.providerID)
      const integrationID = catalogProvider?.integrationID ?? Integration.ID.make(input.providerID)
      const active = yield* integrations.connection.active(integrationID)
      const stored = yield* credentials.list(integrationID)
      if (!active && stored.length) return yield* finish("reconnect-required")
      const inline =
        typeof selected.request.body.apiKey === "string" || typeof selected.api.settings?.apiKey === "string"
      if (!active && !inline && (provider.authentication === "required" || !!provider.env?.length))
        return yield* finish("authentication")
      const snapshot = active
        ? yield* integrations.connection.resolveSnapshot(active).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      if (active && !snapshot) return yield* finish("authentication")
      let value = snapshot?.value
      if (value?.type === "key") {
        const target = value.metadata?.[providerCredentialTargetKey]
        if (target !== undefined && target !== providerCredentialTarget(input.providerID, selected.api))
          return yield* finish("reconnect-required")
        const env = value.metadata?.["arforge.provider.key-env.v1"]
        if (!value.key && typeof env === "string") {
          const secrets = Option.getOrUndefined(yield* Effect.serviceOption(SecretProvider.Service))
          const key = secrets
            ? yield* secrets.resolve(env).pipe(Effect.catch(() => Effect.succeed(undefined)))
            : undefined
          if (!key) return yield* finish("authentication")
          value = Credential.Key.make({ ...value, key })
        }
      }
      const checkCredential = Effect.gen(function* () {
        if (!snapshot?.identity) return
        const current = yield* credentials.get(snapshot.identity.id)
        if (!current || current.version !== snapshot.identity.version)
          return yield* Effect.fail(dependencies.conflict())
      })
      yield* fence
      yield* checkCredential
      const model = yield* SessionRunnerModel.fromConfiguredModel(selected, value).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (!model) return yield* finish("unsupported")
      const limit = model.defaults?.limits?.output ?? model.route.defaults.limits?.output
      const maxTokens =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
          ? Math.min(TEST_OUTPUT_CAP, Math.floor(limit))
          : TEST_OUTPUT_CAP
      if (maxTokens < 1) return yield* finish("output-limit")
      const request = LLM.request({ model, prompt: Probe.FIXED_PROMPT, generation: { maxTokens } })
      const execution = LLM.generate(request).pipe(
        Effect.provide(LLMClient.layer),
        Effect.provide(RequestExecutor.singleAttemptLayer),
        Effect.timeout(TEST_TIMEOUT_MS),
      )
      const result = yield* execution.pipe(
        Effect.map((response) => ({
          category:
            response.finishReason === "length"
              ? ("output-limit" as Category)
              : response.text.trim().length
                ? ("ok" as Category)
                : ("invalid-response" as Category),
        })),
        Effect.catch((error) => Effect.succeed(classify(error))),
        Effect.catchDefect(() => Effect.succeed({ category: "unknown" as Category })),
      )
      yield* checkCredential
      return yield* finish(result.category, "httpStatus" in result ? result.httpStatus : undefined)
    }),
  )
}
