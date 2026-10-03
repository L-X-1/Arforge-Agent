import { describe, expect } from "bun:test"
import { LLM } from "@arforge-ai/llm"
import { LLMClient } from "@arforge-ai/llm/route"
import { DateTime, Effect, Exit, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { Catalog } from "@arforge-ai/core/catalog"
import { Credential } from "@arforge-ai/core/credential"
import { Integration } from "@arforge-ai/core/integration"
import { IntegrationConnection } from "@arforge-ai/core/integration/connection"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { ProjectV2 } from "@arforge-ai/core/project"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { SessionV2 } from "@arforge-ai/core/session"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { it } from "./lib/effect"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: ModelV2.Info["variants"] = []) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test-provider"),
    name: "Test model",
    api: { id: ModelV2.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { apiKey: "secret", custom_extension: { enabled: true } },
    },
    variants,
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

describe("SessionRunnerModel", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          http: { body: { custom_extension: { enabled: true } } },
        },
      })
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("overlays selected OpenAI Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: {
            store: false,
            service_tier: "priority",
            temperature: 0.2,
            reasoning: { effort: "high" },
          },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header", "x-variant": "high" })
      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        service_tier: "priority",
        temperature: 0.2,
        reasoning: { effort: "high" },
      })
    }),
  )

  it.effect("overlays selected OpenAI-compatible Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model(
        { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://compatible.example/v1" },
        [
          {
            id: ModelV2.VariantID.make("high"),
            headers: {},
            body: { store: false, reasoning_effort: "high" },
          },
        ],
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_compatible_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        store: false,
        reasoning_effort: "high",
      })
    }),
  )

  it.effect("rejects an explicit unavailable Session variant during model resolution", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_model_variant_unavailable"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: ModelV2.VariantID.make("unknown"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const failure = yield* SessionRunnerModel.resolve(session, catalog).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.VariantUnavailableError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "unknown",
      })
      expect(failure.message).toBe("Variant unavailable for test-provider/test-model: unknown")
    }),
  )

  it.effect("overlays selected Anthropic Session variant bodies", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: ModelV2.VariantID.make("high"),
          headers: {},
          body: { thinking: { type: "enabled", budget_tokens: 12000 } },
        },
      ])
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_anthropic_variant"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalog.id, providerID: catalog.providerID, variant: ModelV2.VariantID.make("high") },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })

      const resolved = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolved.route.defaults.http?.body).toEqual({
        custom_extension: { enabled: true },
        thinking: { type: "enabled", budget_tokens: 12000 },
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("uses resolved credentials for bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.Key.make({ type: "key", key: "secret" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("prefers stored credentials over configured auth", () =>
    Effect.gen(function* () {
      const credential = Credential.Key.make({ type: "key", key: "stored-secret", metadata: { tenant: "work" } })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: { apiKey: "configured-secret" } },
        }),
        credential,
      )
      const headers = yield* resolved.route.auth.apply({
        request: LLM.request({ model: resolved, prompt: "Hello" }),
        method: "POST",
        url: "https://openai.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer stored-secret")
      expect(resolved.route.defaults.http?.body).toEqual({ tenant: "work" })
    }),
  )

  it.effect("does not project OAuth account metadata into the request body", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        ModelV2.Info.make({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("device"),
          access: "secret",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          metadata: { server: "https://console.example", orgID: "org_123" },
        }),
      )

      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
      expect(failure.message).toBe("Unsupported API for test-provider/test-model: aisdk:@ai-sdk/google")
    }),
  )

  it.effect("reports whether a catalog model has a supported native route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )

  for (const purpose of ["primary", "small"] as const)
    it.effect(`resolves only a credential explicitly scoped to the job: ${purpose}`, () =>
      Effect.gen(function* () {
        const catalogModel = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
        const integrationID = Integration.ID.make("test-integration")
        const provider = ProviderV2.Info.make({
          id: catalogModel.providerID,
          integrationID,
          name: "Test provider",
          api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" },
          request: { headers: {}, body: {} },
        })
        const session = SessionV2.Info.make({
          id: SessionV2.ID.make("ses_scoped_credential"),
          projectID: ProjectV2.ID.global,
          title: "test",
          model: { id: catalogModel.id, providerID: catalogModel.providerID },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/project") },
        })
        const wrongID = Credential.ID.make("cred_wrong_integration")
        const selectedID = Credential.ID.make("cred_selected")
        const selected = Credential.Info.make({
          id: selectedID,
          integrationID,
          label: "selected",
          version: "fixture-selected-v1",
          value: Credential.Key.make({ type: "key", key: "scoped-secret" }),
        })
        const wrong = Credential.Info.make({
          id: wrongID,
          integrationID: Integration.ID.make("other-integration"),
          label: "wrong",
          version: "fixture-wrong-v1",
          value: Credential.Key.make({ type: "key", key: "wrong-secret" }),
        })
        let availableModels = [catalogModel]
        const catalogLayer = Layer.succeed(Catalog.Service, {
          transform: () => Effect.succeed({ dispose: Effect.void }),
          reload: () => Effect.void,
          provider: {
            get: () => Effect.succeed(provider),
            all: () => Effect.succeed([provider]),
            available: () => Effect.succeed([provider]),
          },
          model: {
            get: () => Effect.succeed(catalogModel),
            all: () => Effect.succeed([catalogModel]),
            available: () => Effect.succeed(availableModels),
            default: () => Effect.succeed(catalogModel),
            small: () => Effect.succeed(catalogModel),
          },
        } as Catalog.Interface)
        let currentCredential: Credential.Info | undefined = selected
        const credentialLayer = Layer.succeed(Credential.Service, {
          get: (id: Credential.ID) =>
            Effect.succeed(id === selected.id ? currentCredential : id === wrong.id ? wrong : undefined),
        } as unknown as Credential.Interface)
        let resolvedConnection: unknown
        const integrationLayer = Layer.succeed(Integration.Service, {
          connection: {
            active: () => Effect.die("active connection must not be consulted for a scoped run"),
            resolveSnapshot: (connection: IntegrationConnection.Info) => {
              resolvedConnection = connection
              return Effect.succeed(
                connection.type === "credential" && connection.id === selectedID
                  ? { value: selected.value, identity: { id: selected.id, version: selected.version } }
                  : undefined,
              )
            },
          },
        } as unknown as Integration.Interface)
        const location = SessionRunnerModel.locationLayer.pipe(
          Layer.provide(catalogLayer),
          Layer.provide(integrationLayer),
          Layer.provide(credentialLayer),
        )
        const resolved = yield* Effect.gen(function* () {
          const service = yield* SessionRunnerModel.Service
          if (purpose === "primary") return yield* service.resolve(session)
          if (!service.resolveSmall) return yield* Effect.die("Small model resolution is not connected")
          const resolved = yield* service.resolveSmall(session, ["text"])
          if (!resolved) return yield* Effect.die("Small model was not resolved")
          expect(yield* service.resolveSmall(session, ["image/png"])).toBeUndefined()
          expect(
            yield* service.resolveSmall(
              {
                ...session,
                model: {
                  providerID: catalogModel.providerID,
                  id: catalogModel.id,
                  variant: ModelV2.VariantID.make("main-only"),
                },
              },
              ["text"],
            ),
          ).toBeDefined()
          const denied = yield* service
            .resolveSmall(session, ["text"])
            .pipe(Effect.provideService(SessionRunnerModel.CredentialScope, []), Effect.flip)
          expect(denied._tag).toBe("SessionRunnerModel.CredentialScopeError")
          availableModels = []
          expect(yield* service.resolveSmall(session, ["text"])).toBeUndefined()
          return resolved
        }).pipe(
          Effect.provideService(SessionRunnerModel.CredentialScope, [wrongID, selectedID]),
          Effect.provide(location),
        )

        expect(resolvedConnection).toEqual({ type: "credential", id: selectedID, label: "selected" })
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })
        expect(headers.authorization).toBe("Bearer scoped-secret")
        expect(SessionRunnerModel.credentialIdentity(resolved)).toEqual({ id: selectedID, version: selected.version })
        yield* SessionRunnerModel.validateCredential(resolved)
        currentCredential = Credential.Info.make({ ...selected, version: "fixture-selected-v2" })
        expect(Exit.isFailure(yield* SessionRunnerModel.validateCredential(resolved).pipe(Effect.exit))).toBe(true)
        expect(SessionRunnerModel.credentialIdentity(resolved)?.version).toBe(selected.version)
        currentCredential = undefined
        expect(Exit.isFailure(yield* SessionRunnerModel.validateCredential(resolved).pipe(Effect.exit))).toBe(true)
      }),
    )

  it.effect("fails closed when a scoped credential cannot serve the selected provider", () =>
    Effect.gen(function* () {
      const catalogModel = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" })
      const integrationID = Integration.ID.make("test-integration")
      const provider = ProviderV2.Info.make({
        id: catalogModel.providerID,
        integrationID,
        name: "Test provider",
        api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" },
        request: { headers: {}, body: {} },
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_scoped_credential_missing"),
        projectID: ProjectV2.ID.global,
        title: "test",
        model: { id: catalogModel.id, providerID: catalogModel.providerID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/project") },
      })
      const otherID = Credential.ID.make("cred_other_integration")
      const other = Credential.Info.make({
        id: otherID,
        integrationID: Integration.ID.make("other-integration"),
        label: "other",
        version: "fixture-other-v1",
        value: Credential.Key.make({ type: "key", key: "other-secret" }),
      })
      const catalogLayer = Layer.succeed(Catalog.Service, {
        transform: () => Effect.succeed({ dispose: Effect.void }),
        reload: () => Effect.void,
        provider: {
          get: () => Effect.succeed(provider),
          all: () => Effect.succeed([provider]),
          available: () => Effect.succeed([provider]),
        },
        model: {
          get: () => Effect.succeed(catalogModel),
          all: () => Effect.succeed([catalogModel]),
          available: () => Effect.succeed([catalogModel]),
          default: () => Effect.succeed(catalogModel),
          small: () => Effect.succeed(catalogModel),
        },
      } as Catalog.Interface)
      const credentialLayer = Layer.succeed(Credential.Service, {
        get: (id: Credential.ID) => Effect.succeed(id === other.id ? other : undefined),
      } as unknown as Credential.Interface)
      const integrationLayer = Layer.succeed(Integration.Service, {
        connection: { active: () => Effect.die("unexpected active connection") },
      } as unknown as Integration.Interface)
      const location = SessionRunnerModel.locationLayer.pipe(
        Layer.provide(catalogLayer),
        Layer.provide(integrationLayer),
        Layer.provide(credentialLayer),
      )
      const failure = yield* Effect.gen(function* () {
        const service = yield* SessionRunnerModel.Service
        return yield* service.resolve(session)
      }).pipe(
        Effect.provideService(SessionRunnerModel.CredentialScope, [otherID]),
        Effect.provide(location),
        Effect.flip,
      )

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.CredentialScopeError",
        sessionID: session.id,
        providerID: catalogModel.providerID,
        credentialIDs: [otherID],
      })
    }),
  )
})
