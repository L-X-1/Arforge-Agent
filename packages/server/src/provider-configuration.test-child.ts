import { expect } from "bun:test"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
const root = Bun.argv[2]!
process.env.ARFORGE_HOME = join(root, "home")
process.env.ARFORGE_CONFIG_DIR = join(root, "home", "config")
process.env.ARFORGE_TEST_HOME = join(root, "home")
process.env.ARFORGE_CONFIG = ""
process.env.ARFORGE_DB = join(root, "provider.db")
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_CONFIG_CONTENT = ""
process.env.ARFORGE_DISABLE_MODELS_FETCH = "true"
process.env.ARFORGE_AUTH_MODE = "private"
process.env.ARFORGE_MODELS_URL = ""
const { DateTime, Effect, Layer, Scope, Exit, Option, Deferred, Fiber, Schema, Stream } = await import("effect")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { Database } = await import("@arforge-ai/core/database/database")
const { CredentialTable } = await import("@arforge-ai/core/credential/sql")
const { Catalog } = await import("@arforge-ai/core/catalog")
const { Credential } = await import("@arforge-ai/core/credential")
const { Global } = await import("@arforge-ai/core/global")
const { Integration } = await import("@arforge-ai/core/integration")
const { Location } = await import("@arforge-ai/core/location")
const { LocationServiceMap } = await import("@arforge-ai/core/location-service-map")
const { AbsolutePath } = await import("@arforge-ai/core/schema")
const { ProjectV2 } = await import("@arforge-ai/core/project")
const { Git } = await import("@arforge-ai/core/git")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { SecretProvider } = await import("@arforge-ai/core/secret-provider")
const { SessionExecution } = await import("@arforge-ai/core/session/execution")
const { SessionRunnerModel } = await import("@arforge-ai/core/session/runner/model")
const { LLM } = await import("../../llm/src/index")
const { LLMClient, RequestExecutor } = await import("../../llm/src/route/index")
const { applicationServices } = await import("./routes")
const { IdentityContext } = await import("./identity-context")
const {
  saveConfiguration,
  configurationCapability,
  connectConfigurationCredential,
  disconnectConfiguration,
  hostConfigurationAllowed,
  providerConfigurationScope,
} = await import("./provider-configuration")
const workspace = AbsolutePath.make(join(root, "workspace"))
const git = Layer.effect(
  Git.Service,
  Effect.map(Git.Service, (service) =>
    Git.Service.of({ ...service, repo: { ...service.repo, discover: () => Effect.succeed(undefined) } }),
  ),
).pipe(Layer.provide(LayerNode.compile(Git.node)))
const services = AppNodeBuilder.build(applicationServices, [
  [Database.node, Database.layerFromPath(join(root, "provider.db"))],
  [
    ProjectV2.node,
    Layer.succeed(
      ProjectV2.Service,
      ProjectV2.Service.of({
        resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
        directories: () => Effect.succeed([]),
        commit: () => Effect.void,
      }),
    ),
  ],
  [Git.node, { ...Git.node, implementation: git }],
  [SessionExecution.node, SessionExecution.noopLayer],
  [
    SecretProvider.node,
    Layer.succeed(
      SecretProvider.Service,
      SecretProvider.makeAes256Gcm(
        process.env.ARFORGE_PROVIDER_FIXTURE_KEY
          ? Buffer.from(process.env.ARFORGE_PROVIDER_FIXTURE_KEY, "hex")
          : randomBytes(32),
        "owned-provider-aes",
      ),
    ),
  ],
])
let expectedKey: string | undefined,
  expectedHeader: string | undefined,
  requests = 0
const reasoningRequests: Array<{ path: string; body: Record<string, unknown> }> = []
const receiver = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (Bun.argv[3] === "reasoning") {
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      reasoningRequests.push({ path, body })
      const events =
        path === "/v1/responses"
          ? [
              { type: "response.output_text.delta", delta: "owned reply" },
              { type: "response.completed", response: { id: "owned", status: "completed" } },
            ]
          : path === "/v1/messages"
            ? [
                { type: "message_start", message: { usage: { input_tokens: 1 } } },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "owned reply" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
              ]
            : [
                { choices: [{ index: 0, delta: { content: "owned reply" }, finish_reason: null }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    expect(request.headers.get("authorization") === (expectedKey ? `Bearer ${expectedKey}` : null)).toBe(true)
    expect(request.headers.get("x-owned-key") === (expectedHeader ?? null)).toBe(true)
    const body = (await request.json()) as { model: string }
    expect(body.model).toBe("owned-model")
    expect(JSON.stringify(body)).not.toContain("arforge.provider")
    requests++
    return new Response(
      `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", created: 1, model: "owned-model", choices: [{ index: 0, delta: { role: "assistant", content: "owned reply" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", created: 1, model: "owned-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
try {
  if (Bun.argv[3] === "relaunch") {
    await Effect.runPromise(
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const context = yield* locations.contextEffect(Location.Ref.make({ directory: workspace }))
        const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
        const integrations = yield* Integration.Service.pipe(Effect.provide(context))
        const selected = (yield* catalog.model.available()).find((model) => model.providerID === "owned-required")!
        expect(selected).toBeDefined()
        const connection = yield* integrations.connection.active(Integration.ID.make("owned-required"))
        expect(connection).toBeDefined()
        const value = yield* integrations.connection.resolve(connection!)
        expect(value?.type).toBe("key")
        const resolved = yield* SessionRunnerModel.fromCatalogModel(selected, value)
        expect(resolved.route.defaults.http?.body?.["arforge.provider.target.v1"]).toBeUndefined()
        // The target survived a process restart and decrypted through the same
        // tenant credential owner; no process-random CAS receipt is stored as it.
        expect(value?.type === "key" && typeof value.metadata?.["arforge.provider.target.v1"] === "string").toBe(true)
      }).pipe(Effect.scoped, Effect.provide(services)),
    )
    console.log("provider-configuration-relaunch-ok")
  } else if (Bun.argv[3] === "http" || Bun.argv[3] === "reasoning") {
    const { HttpRouter, HttpServer } = await import("effect/unstable/http")
    const { HttpApiBuilder } = await import("effect/unstable/httpapi")
    const { Arforge } = await import("../../client/src/index")
    const { Api } = await import("./api")
    const { handlers, RuntimeInsightPersistence } = await import("./handlers")
    const { authorizationLayer } = await import("./middleware/authorization")
    const { sessionLocationLayer } = await import("./middleware/session-location")
    const { schemaErrorLayer } = await import("./middleware/schema-error")
    const { layer: locationLayer } = await import("./location")
    const { ServerAuth } = await import("./auth")
    const { UserAuth } = await import("./user-auth")
    const { ControlClaimIndex } = await import("@arforge-ai/core/runtime")
    const identity = Layer.succeed(IdentityContext.Current, IdentityContext.LocalPrincipal)
    const routes = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(handlers),
      Layer.provide(RuntimeInsightPersistence),
      Layer.provide(sessionLocationLayer),
      Layer.provide(locationLayer),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({ username: "owned", password: Option.none() })),
      Layer.provide(UserAuth.Config.layer),
      Layer.provide(identity),
      Layer.provide(Layer.succeed(ControlClaimIndex.CurrentPrincipal, undefined)),
      Layer.provide(services),
    )
    // One shared services layer, including the actual Location map, is memoized
    // by the existing HTTP framework for handler construction and every request.
    const web = HttpRouter.toWebHandler(
      routes.pipe(
        HttpRouter.provideRequest(services),
        HttpRouter.provideRequest(identity),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    )
    const transport: typeof fetch = Object.assign(
      (input: URL | RequestInfo, init?: RequestInit) => web.handler(new Request(input, init)),
      { preconnect: () => {} },
    )
    const api = Arforge.make({ baseUrl: "http://localhost", fetch: transport })
    const location = { directory: workspace }
    try {
      if (Bun.argv[3] === "reasoning") {
        const { ModelV2 } = await import("@arforge-ai/core/model")
        const { ProviderV2 } = await import("@arforge-ai/core/provider")
        const { SessionV2 } = await import("@arforge-ai/core/session")
        const inventory = (await api.models.list({ location, includePresets: true })).presets!
        const preset = {
          origin: { vendorID: "deepseek", modelID: "deepseek-flash" },
          revision: inventory.revision,
        }
        const baseURL = `http://127.0.0.1:${receiver.port}/v1`
        const selected = async (providerID: string, id: string) =>
          Schema.decodeUnknownSync(ModelV2.Info)(
            (await api.models.list({ location })).data.find((item) => item.providerID === providerID && item.id === id),
          )
        const runtime = (target: import("@arforge-ai/core/model").ModelV2.Info, variant?: string) =>
          SessionRunnerModel.resolve(
            SessionV2.Info.make({
              id: SessionV2.ID.make("ses_owned_reasoning"),
              projectID: ProjectV2.ID.global,
              title: "Owned reasoning request",
              model: {
                id: target.id,
                providerID: target.providerID,
                variant: variant === undefined ? undefined : ModelV2.VariantID.make(variant),
              },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
              location,
            }),
            target,
          )
        const send = async (target: import("@arforge-ai/core/model").ModelV2.Info, variant?: string) => {
          const response = await Effect.runPromise(
            Effect.gen(function* () {
              const model = yield* runtime(target, variant)
              return yield* LLM.generate(
                LLM.request({ model, prompt: "Owned local reasoning check", generation: { maxTokens: 1000000 } }),
              )
            }).pipe(Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer)))),
          )
          expect(response.text).toBe("owned reply")
          const received = reasoningRequests.at(-1)!
          expect(received.body.model).toBe(target.api.id)
          expect(received.body.max_tokens ?? received.body.max_output_tokens).toBe(target.limit.output)
          return received
        }
        let saved = (
          await api.providers.save({
            location,
            providerID: "owned-reasoning-chat",
            name: "Owned Chat",
            baseURL,
            apiFormat: "openai-chat",
            authentication: "optional",
            models: [{ id: "deepseek-flash", name: "Owned Flash", preset, limit: { output: 512 } }],
          })
        ).data
        const chat = await selected("owned-reasoning-chat", "deepseek-flash")
        expect(chat.variants.map((item) => String(item.id))).toEqual(["low", "high", "max", "none"])
        expect(chat.request.variant).toBe("max")
        expect(chat.limit.context).toBe(1048576)
        for (const variant of [undefined, "default", "low", "high", "max", "none"]) {
          const received = await send(chat, variant)
          expect(received.path).toBe("/v1/chat/completions")
          expect(received.body.thinking).toEqual({ type: variant === "none" ? "disabled" : "enabled" })
          expect(received.body.reasoning_effort).toBe(
            variant === "none" ? undefined : variant === "default" || variant === undefined ? "max" : variant,
          )
        }
        // A prepared request retains its captured variant across a real typed edit/catalog generation change.
        const captured = await Effect.runPromise(
          runtime(chat).pipe(
            Effect.flatMap((model) =>
              LLMClient.prepare(
                LLM.request({ model, prompt: "Captured before edit", generation: { maxTokens: 1000000 } }),
              ),
            ),
          ),
        )
        saved = (
          await api.providers.save({
            location,
            providerID: chat.providerID,
            name: "Owned Chat",
            revision: saved.revision,
            models: [{ id: chat.id, name: chat.name, defaultVariant: "low" }],
          })
        ).data
        await Effect.runPromise(
          LLMClient.streamPrepared(captured).pipe(
            Stream.runDrain,
            Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
          ),
        )
        expect(reasoningRequests.at(-1)!.body.reasoning_effort).toBe("max")
        expect((await send(await selected(chat.providerID, chat.id))).body.reasoning_effort).toBe("low")
        saved = (
          await api.providers.save({
            location,
            providerID: chat.providerID,
            name: "Owned Chat",
            revision: saved.revision,
            models: [{ id: chat.id, name: chat.name, defaultVariant: null }],
          })
        ).data
        const cleared = await selected(chat.providerID, chat.id)
        expect(cleared.request.variant).toBeUndefined()
        expect((await send(cleared)).body.thinking).toBeUndefined()
        expect(reasoningRequests.at(-1)!.body.reasoning_effort).toBeUndefined()

        const relayID = "XINJIANGfree/DeepSeek-V4.1-Flash"
        saved = (
          await api.providers.save({
            location,
            providerID: chat.providerID,
            name: "Owned Chat",
            revision: saved.revision,
            models: [{ id: relayID, name: "DeepSeek Flash", preset }],
          })
        ).data
        const unknown = await selected(chat.providerID, relayID)
        expect(unknown.api.id).toBe(ModelV2.ID.make(relayID))
        expect(unknown.variants).toEqual([])
        expect(unknown.request.variant).toBeUndefined()

        for (const [format, variants] of [
          [
            "openai-responses",
            [
              { id: "none", body: { reasoning: { effort: "none" } } },
              { id: "low", body: { reasoning: { effort: "low" } } },
              { id: "high", body: { reasoning: { effort: "high" } } },
            ],
          ],
          [
            "anthropic-messages",
            [
              { id: "off", body: { thinking: { type: "disabled" } } },
              { id: "auto", body: {} },
              { id: "low", body: { thinking: { type: "adaptive" }, output_config: { effort: "low" } } },
              { id: "high", body: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
            ],
          ],
        ] as const) {
          const providerID = ProviderV2.ID.make(`owned-${format}`)
          await api.providers.save({
            location,
            providerID,
            name: `Owned ${format}`,
            baseURL,
            apiFormat: format,
            authentication: "optional",
            models: [
              {
                id: `owned-${format}`,
                name: format,
                limit: { context: 16000, output: 512 },
                variants: [...variants],
                defaultVariant: "high",
              },
            ],
          })
          const target = await selected(providerID, `owned-${format}`)
          expect(target.variants.map((item) => String(item.id))).toEqual(variants.map((item) => item.id))
          expect(target.request.variant).toBe("high")
          for (const variant of [undefined, ...variants.map((item) => item.id)]) {
            const received = await send(target, variant)
            expect(received.path).toBe(format === "openai-responses" ? "/v1/responses" : "/v1/messages")
            const expected = variants.find((item) => item.id === (variant ?? "high"))!.body
            for (const key of ["reasoning", "thinking", "output_config"] as const)
              expect(received.body[key]).toEqual(key in expected ? expected[key as keyof typeof expected] : undefined)
          }
        }
        // All persisted bytes belong to this test-owned profile and preserve the requested relay ID and manual cap.
        const text = await readFile(join(root, "home", "config", "arforge.jsonc"), "utf8")
        expect(text).toContain(relayID)
        expect(text).toContain('"output": 512')
        expect(reasoningRequests).toHaveLength(18)
        console.log(
          `provider-configuration-reasoning-ok (${reasoningRequests.length} loopback requests; three adapters)`,
        )
      } else {
        expect((await api.providers.list({ location })).data.some((provider) => provider.id === "http-owned")).toBe(
          false,
        )
        expect(
          (await api.integrations.list({ location })).data.some((integration) => integration.id === "http-owned"),
        ).toBe(false)
        expect((await api.providers.capability({ location })).data.canWrite).toBe(true)
        const saved = (
          await api.providers.save({
            location,
            providerID: "http-owned",
            name: "HTTP owned",
            baseURL: `http://127.0.0.1:${receiver.port}/v1`,
            models: [{ id: "owned-model", name: "Owned model" }],
            authentication: "optional",
          })
        ).data
        expect((await api.providers.list({ location })).data.some((provider) => provider.id === "http-owned")).toBe(
          true,
        )
        expect((await api.models.list({ location })).data.some((model) => model.providerID === "http-owned")).toBe(true)
        expect((await api.integrations.get({ location, integrationID: "http-owned" })).data?.methods).toContainEqual({
          type: "key",
        })
        await api.providers.credential({
          location,
          providerID: "http-owned",
          revision: saved.revision,
          key: randomBytes(16).toString("hex"),
        })
        expect((await api.integrations.get({ location, integrationID: "http-owned" })).data?.connections).toHaveLength(
          1,
        )
        await api.providers.disconnect({ location, providerID: "http-owned", revision: saved.revision })
        expect((await api.models.list({ location })).data.some((model) => model.providerID === "http-owned")).toBe(
          false,
        )
        console.log("provider-configuration-http-ok")
      }
    } finally {
      await web.dispose()
    }
  } else {
    await Effect.runPromise(
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const configure = yield* providerConfigurationScope
        const ref = Location.Ref.make({ directory: workspace })
        const lease = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(lease, Exit.void))
        const context = yield* locations.contextEffect(ref).pipe(Scope.provide(lease))
        const inLocation = <A, E, R>(effect: import("effect").Effect.Effect<A, E, R>) =>
          configure(effect).pipe(
            Effect.provide(context),
            Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal),
          )
        // Instantiate/list both owners BEFORE configuring, and retain the old lease.
        yield* inLocation(
          Effect.gen(function* () {
            expect((yield* (yield* Catalog.Service).provider.all()).some((item) => item.id === "owned-local")).toBe(
              false,
            )
            expect((yield* (yield* Integration.Service).list()).some((item) => item.id === "owned-local")).toBe(false)
          }),
        )
        const input = {
          name: "Owned local",
          baseURL: `http://127.0.0.1:${receiver.port}/v1`,
          models: [{ id: "owned-model", name: "Owned model" }],
          authentication: "optional" as const,
        }
        const capability = yield* inLocation(configurationCapability())
        expect(capability.canWrite).toBe(true)
        expect(
          (yield* configure(saveConfiguration("forbidden", input)).pipe(Effect.provide(context), Effect.flip))._tag,
        ).toBe("ProviderConfigurationForbidden")
        for (const principal of [
          undefined,
          { ...IdentityContext.LocalPrincipal, role: "member" as const },
          { ...IdentityContext.LocalPrincipal, sessionID: "tenant-owner-session" },
          { ...IdentityContext.LocalPrincipal, tenantID: "foreign" },
        ]) {
          expect(hostConfigurationAllowed(principal)).toBe(false)
          if (principal) {
            const denied = yield* saveConfiguration("forbidden", input).pipe(
              Effect.provide(context),
              Effect.provideService(IdentityContext.Current, principal),
              Effect.flip,
            )
            expect(denied._tag).toBe("ProviderConfigurationForbidden")
          }
        }
        const saved = yield* inLocation(saveConfiguration("owned-local", input))
        const next = yield* locations.contextEffect(ref)
        expect(next).not.toBe(context)
        // Existing acquired scope is alive; replacement generation belongs to SAME map.
        yield* inLocation((yield* Catalog.Service.pipe(Effect.provide(context))).provider.all())
        const inCurrent = <A, E, R>(effect: import("effect").Effect.Effect<A, E, R>) =>
          configure(effect).pipe(
            Effect.provide(next),
            Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal),
          )
        const catalog = yield* Catalog.Service.pipe(Effect.provide(next))
        const integrations = yield* Integration.Service.pipe(Effect.provide(next))
        const credentials = yield* Credential.Service
        const integrationID = Integration.ID.make("owned-local")
        expect((yield* integrations.get(integrationID))?.methods).toContainEqual({ type: "key" })
        const selected = (yield* catalog.model.available()).find((model) => model.providerID === "owned-local")!
        expect(selected).toBeDefined()
        expect(yield* credentials.list(integrationID)).toHaveLength(0)
        const send = (credential?: import("@arforge-ai/core/credential").Credential.Value, target = selected) =>
          Effect.gen(function* () {
            const model = yield* SessionRunnerModel.fromCatalogModel(target, credential)
            yield* LLM.generate(LLM.request({ model, prompt: "owned input" })).pipe(
              Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
            )
          })
        yield* send()
        expectedKey = randomBytes(16).toString("hex")
        expectedHeader = randomBytes(16).toString("hex")
        yield* inCurrent(
          connectConfigurationCredential("owned-local", {
            revision: saved.revision,
            key: expectedKey,
            headers: { "X-Owned-Key": expectedHeader },
          }),
        )
        const stored = yield* credentials.list(integrationID)
        expect(stored).toHaveLength(1)
        const connection = yield* integrations.connection.active(integrationID)
        expect(connection).toBeDefined()
        const value = yield* integrations.connection.resolve(connection!)
        yield* send(value)
        const retry = yield* inCurrent(
          connectConfigurationCredential("owned-local", {
            revision: saved.revision,
            key: expectedKey,
            headers: { "X-Owned-Key": expectedHeader },
          }),
        )
        expect(retry.providerID).toBe("owned-local")
        expect(yield* credentials.list(integrationID)).toHaveLength(1)
        const global = yield* Global.Service
        const configText = yield* Effect.promise(() => readFile(join(global.config, "arforge.jsonc"), "utf8"))
        expect(configText.includes("forbidden")).toBe(false)
        expect(configText.includes(expectedKey)).toBe(false)
        expect(configText.includes(expectedHeader)).toBe(false)
        expect(JSON.stringify(yield* catalog.provider.all()).includes(expectedKey)).toBe(false)
        const { db } = yield* Database.Service
        const rows = yield* db.select().from(CredentialTable).all().pipe(Effect.orDie)
        expect(rows).toHaveLength(1)
        expect(rows[0]!.encrypted_value).toBeTruthy()
        expect(JSON.stringify(rows).includes(expectedKey)).toBe(false)
        expect(JSON.stringify(rows).includes(expectedHeader)).toBe(false)
        const disconnected = yield* inCurrent(disconnectConfiguration("owned-local", saved.revision))
        expect(disconnected.disabled).toBe(true)
        const after = yield* locations.contextEffect(ref)
        expect(
          (yield* (yield* Catalog.Service.pipe(Effect.provide(after))).model.available()).some(
            (model) => model.providerID === "owned-local",
          ),
        ).toBe(false)
        expect(yield* credentials.list(integrationID)).toHaveLength(0)
        // Retrying the same disconnect receipt is safe after partial credential removal.
        expect((yield* inCurrent(disconnectConfiguration("owned-local", saved.revision))).disabled).toBe(true)
        const required = yield* inCurrent(saveConfiguration("owned-required", { ...input, authentication: "required" }))
        const requiredContext = yield* locations.contextEffect(ref)
        const requiredCatalog = yield* Catalog.Service.pipe(Effect.provide(requiredContext))
        const requiredIntegrations = yield* Integration.Service.pipe(Effect.provide(requiredContext))
        const requiredID = Integration.ID.make("owned-required")
        expect((yield* requiredIntegrations.get(requiredID))?.methods).toContainEqual({ type: "key" })
        expect((yield* requiredCatalog.model.available()).some((model) => model.providerID === "owned-required")).toBe(
          false,
        )
        const failing = Integration.Service.of({
          ...requiredIntegrations,
          connection: { ...requiredIntegrations.connection, key: () => Effect.die(new Error("owned-private-failure")) },
        })
        const failed = yield* configure(
          connectConfigurationCredential(requiredID, { revision: required.revision, key: expectedKey }),
        ).pipe(
          Effect.provideService(Integration.Service, failing),
          Effect.provide(requiredContext),
          Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal),
          Effect.flip,
        )
        expect(failed._tag).toBe("ServiceUnavailableError")
        expect(failed.message.includes("owned-private-failure")).toBe(false)
        expect(yield* credentials.list(requiredID)).toHaveLength(0)
        yield* configure(
          connectConfigurationCredential(requiredID, {
            revision: required.revision,
            key: expectedKey,
            headers: { "X-Owned-Key": expectedHeader },
          }),
        ).pipe(
          Effect.provide(requiredContext),
          Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal),
        )
        const requiredModel = (yield* requiredCatalog.model.available()).find(
          (model) => model.providerID === "owned-required",
        )!
        expect(requiredModel).toBeDefined()
        const requiredConnection = yield* requiredIntegrations.connection.active(requiredID)
        yield* send(yield* requiredIntegrations.connection.resolve(requiredConnection!), requiredModel)
        expect(requests).toBe(3)

        // Hold at the same owner boundaries as the independent review. The
        // configuration and encrypted credential owners remain real throughout.
        const bind = <A, E, R>(
          current: typeof context,
          service: import("@arforge-ai/core/integration").Integration.Interface,
          operation: import("effect").Effect.Effect<A, E, R>,
        ) =>
          configure(operation).pipe(
            Effect.provideService(Integration.Service, service),
            Effect.provide(current),
            Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal),
          )
        const raceID = Integration.ID.make("owned-connect-race")
        const raceSaved = yield* inLocation(saveConfiguration(raceID, input))
        const raceContext = yield* locations.contextEffect(ref)
        const raceIntegration = yield* Integration.Service.pipe(Effect.provide(raceContext))
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>()
        const gate = Integration.Service.of({
          ...raceIntegration,
          connection: {
            ...raceIntegration.connection,
            key: (value) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return yield* raceIntegration.connection.key(value)
              }),
          },
        })
        const connecting = yield* bind(
          raceContext,
          gate,
          connectConfigurationCredential(raceID, { revision: raceSaved.revision, key: "owned-stale-target" }),
        ).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
        yield* inLocation(
          saveConfiguration(raceID, { ...input, baseURL: "http://127.0.0.1:1/other", revision: raceSaved.revision }),
        )
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.join(connecting))).toBe(true)
        const movedContext = yield* locations.contextEffect(ref)
        const movedIntegration = yield* Integration.Service.pipe(Effect.provide(movedContext))
        expect(yield* movedIntegration.connection.active(raceID)).toBeUndefined()
        expect((yield* movedIntegration.get(raceID))?.connections).toHaveLength(0)

        const disconnectID = Integration.ID.make("owned-disconnect-race")
        const disconnectSaved = yield* inLocation(
          saveConfiguration(disconnectID, { ...input, authentication: "required" }),
        )
        const disconnectContext = yield* locations.contextEffect(ref)
        const disconnectIntegration = yield* Integration.Service.pipe(Effect.provide(disconnectContext))
        yield* bind(
          disconnectContext,
          disconnectIntegration,
          connectConfigurationCredential(disconnectID, {
            revision: disconnectSaved.revision,
            key: "owned-old-generation",
          }),
        )
        const old = (yield* credentials.list(disconnectID))[0]!
        const dentered = yield* Deferred.make<void>(),
          drelease = yield* Deferred.make<void>()
        const dgate = Integration.Service.of({
          ...disconnectIntegration,
          get: (id) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(dentered, undefined)
              yield* Deferred.await(drelease)
              return yield* disconnectIntegration.get(id)
            }),
        })
        const disconnecting = yield* bind(
          disconnectContext,
          dgate,
          disconnectConfiguration(disconnectID, disconnectSaved.revision),
        ).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(dentered).pipe(Effect.timeout("10 seconds"))
        const disabled = (yield* inLocation(configurationCapability())).providers.find(
          (provider) => provider.id === disconnectID,
        )!
        expect(disabled.disabled).toBe(true)
        const reenabled = yield* inLocation(
          saveConfiguration(disconnectID, { ...input, authentication: "required", revision: disabled.revision }),
        )
        const renewedContext = yield* locations.contextEffect(ref)
        const renewedIntegration = yield* Integration.Service.pipe(Effect.provide(renewedContext))
        yield* bind(
          renewedContext,
          renewedIntegration,
          connectConfigurationCredential(disconnectID, { revision: reenabled.revision, key: "owned-fresh-generation" }),
        )
        const fresh = (yield* credentials.list(disconnectID))[0]!
        expect(fresh.id !== old.id).toBe(true)
        yield* Deferred.succeed(drelease, undefined)
        yield* Fiber.join(disconnecting)
        expect((yield* credentials.list(disconnectID)).some((item) => item.id === fresh.id)).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(services)),
    )
    console.log("provider-configuration-owner-ok")
  }
} finally {
  await receiver.stop(true)
}
