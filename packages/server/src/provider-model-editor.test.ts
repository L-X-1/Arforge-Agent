import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { Effect, FileSystem, Schema, Stream } from "effect"
import { Config } from "@arforge-ai/core/config"
import { ConfigProvider } from "@arforge-ai/core/config/provider"
import { FSUtil } from "@arforge-ai/core/fs-util"
import { EffectFlock } from "@arforge-ai/core/util/effect-flock"
import { IdentityContext } from "./identity-context"
import { authorizeConfiguration } from "./provider-configuration"
import { edit, safeURL } from "./provider-configuration-data"
import { providerCredentialTarget } from "@arforge-ai/core/provider-credential-target"
import { Catalog } from "@arforge-ai/core/catalog"
import { Policy } from "@arforge-ai/core/policy"
import { EventV2 } from "@arforge-ai/core/event"
import { Integration } from "@arforge-ai/core/integration"
import { Credential } from "@arforge-ai/core/credential"
import { ModelsDev } from "@arforge-ai/core/models-dev"
import { ModelsDevPlugin } from "@arforge-ai/core/plugin/models-dev"
import { ConfigProviderPlugin } from "@arforge-ai/core/config/plugin/provider"
import { PluginEvents } from "@arforge-ai/core/plugin/events"
import { SessionRunnerModel } from "@arforge-ai/core/session/runner/model"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProviderV2 } from "@arforge-ai/core/provider"
import snapshot from "../../core/assets/models.json"

const api = {
  type: "aisdk" as const,
  package: "@ai-sdk/openai-compatible",
  url: "https://owned.invalid/v1",
  settings: {},
}
const base = Schema.decodeUnknownSync(ConfigProvider.Info)({
  name: "Owned",
  api,
  authentication: "required",
  disabled: true,
  request: { headers: { "x-custom": "kept" }, body: { custom_flag: true } },
  models: {
    wire: {
      name: "Wire",
      api: { id: "wire-unchanged" },
      limit: { context: 91000, output: 384 },
      request: { headers: { "x-model": "kept" }, body: { custom_mode: true }, variant: "max" },
      variants: [{ id: "max", headers: { "x-variant": "kept" }, body: { reasoning_effort: "max" } }],
      cost: [{ input: 1, output: 2 }],
      disabled: true,
    },
  },
})
const payload = { name: "Renamed", models: [{ id: "wire", name: "Edited", limit: { output: 192 } }], revision: "r1" }

test("ordinary metadata and blank-key optional edit preserve adapter, auth, disabled state, secret target and advanced fields", () => {
  const saved = edit({ ...payload, authentication: "optional" }, base)
  expect(saved.authentication).toBe("required")
  expect(saved.disabled).toBe(true)
  expect(saved.api).toEqual(base.api)
  expect(providerCredentialTarget("owned", saved.api!)).toBe(providerCredentialTarget("owned", base.api!))
  expect(String(saved.models!.wire.api!.id)).toBe("wire-unchanged")
  expect(saved.models!.wire.cost).toEqual(base.models!.wire.cost)
  expect(saved.models!.wire.request).toEqual(base.models!.wire.request)
  expect(saved.request).toEqual(base.request)
  expect(saved.models!.wire.limit).toMatchObject({ context: 91000, output: 192 })
})

test("provider/model disable and re-enable are canonical and do not delete configuration", () => {
  const saved = edit({ ...payload, disabled: false, models: [{ id: "wire", name: "Wire", disabled: false }] }, base)
  expect(saved.disabled).toBe(false)
  expect(saved.models!.wire.disabled).toBe(false)
  expect(saved.models!.wire.variants).toEqual(base.models!.wire.variants)
})

test("timestamped complete existing Profile and priceCatalog survive a limit-only edit and real config codec readback", () => {
  const profile = {
    version: "v1",
    providerID: "owned",
    modelID: "wire",
    modality: { input: ["text"], output: ["text"] },
    limits: { context: 100, output: 96 },
    capabilities: { tools: "unknown", structured: "unknown", reasoning: "unknown", cache: "unknown" },
    tokenizer: "owned-test",
    estimator: "owned-test",
    priceCatalogRevision: "owned-price",
    observations: [
      {
        kind: "capability",
        status: "inconclusive",
        source: "local",
        sourceID: "owned-fixture",
        observedAt: 1793842445254,
        value: null,
      },
    ],
    policy: {
      region: { mode: "unknown", regions: [] },
      egress: { mode: "unknown", origins: [] },
      data: { retention: "unknown", training: "unknown" },
    },
  } as const
  const priceCatalog = {
    revision: "owned-price",
    currency: "CNY",
    minorUnit: 2,
    unit: "1m-tokens",
    effectiveFrom: 1793842445254,
    source: "owned-synthetic-existing",
    rates: { textOutput: { amountMinor: 456 } },
  } as const
  const previous = Schema.decodeUnknownSync(ConfigProvider.Info)({
    ...Schema.encodeSync(ConfigProvider.Info)(base),
    models: { wire: { ...Schema.encodeSync(ConfigProvider.Model)(base.models!.wire), profile, priceCatalog } },
  })
  const saved = edit(payload, previous)
  const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ConfigProvider.Info))(
    Schema.encodeSync(Schema.fromJsonString(ConfigProvider.Info))(saved),
  )
  const encoded = Schema.encodeSync(ConfigProvider.Model)(decoded.models!.wire)
  expect(encoded.profile).toEqual(profile)
  expect(encoded.priceCatalog).toEqual(priceCatalog)
  expect(decoded.models!.wire.limit!.output).toBe(192)
})

test("three explicit API formats roundtrip; target changes require reconnect and unsupported old adapters stay readonly", () => {
  for (const [format, packageName] of [
    ["openai-chat", "@ai-sdk/openai-compatible"],
    ["openai-responses", "@ai-sdk/openai"],
    ["anthropic-messages", "@ai-sdk/anthropic"],
  ] as const) {
    const saved = edit({ ...payload, apiFormat: format }, base)
    expect(saved.api!.type).toBe("aisdk")
    expect("package" in saved.api! && saved.api.package).toBe(packageName)
    expect(saved.models!.wire.api).toEqual(base.models!.wire.api)
    if (format !== "openai-chat")
      expect(providerCredentialTarget("owned", saved.api!)).not.toBe(providerCredentialTarget("owned", base.api!))
  }
  const unsupported = Schema.decodeUnknownSync(ConfigProvider.Info)({
    api: { type: "aisdk", package: "@unsupported/adapter", url: api.url },
  })
  expect(() => edit(payload, unsupported)).toThrow()
})

test("masked endpoint omitted on update remains byte-exact; create still needs a valid explicit URL", () => {
  const privateURL = "https://owned.invalid/v1?api_key=owned-private-fixture"
  const provider = ConfigProvider.Info.make({ ...base, api: { ...api, url: privateURL } })
  expect(safeURL(privateURL)).toBeUndefined()
  expect(edit(payload, provider).api!.url).toBe(privateURL)
  const nativeDefault = ConfigProvider.Info.make({
    ...base,
    api: { type: "aisdk", package: "@ai-sdk/openai", settings: {} },
  })
  expect(edit(payload, nativeDefault).api!.url).toBeUndefined()
  expect(() => edit({ name: "New", models: [] })).toThrow()
})

test("deletion is explicit/revision-bound, rejects overlaps/duplicates/reserved IDs, and allows deleting the last model", () => {
  expect(
    Object.keys(edit({ name: "Owned", models: [], revision: "r1", deletedModelIDs: ["wire"] }, base).models!),
  ).toEqual([])
  expect(edit({ name: "Owned", models: [] }, base).models!.wire).toBeDefined()
  for (const input of [
    { ...payload, deletedModelIDs: ["wire"] },
    { name: "Owned", models: [], deletedModelIDs: ["wire"] },
    { name: "Owned", models: [], revision: "r1", deletedModelIDs: ["wire", "wire"] },
    { name: "Owned", models: [], revision: "r1", deletedModelIDs: ["__proto__"] },
  ])
    expect(() => edit(input, base)).toThrow()
})

test("actual canonical JSONC writer deletes a model/default leaf instead of resurrecting via deep merge; CAS preserves unrelated data", async () => {
  let text =
    "// owned synthetic fixture\n" +
    JSON.stringify({ unrelated: "kept", providers: { owned: Schema.encodeSync(ConfigProvider.Info)(base) } }, null, 2)
  const writes: string[] = []
  const filesystem = {
    ...FileSystem.makeNoop({}),
    exists: () => Effect.succeed(true),
    readFileString: () => Effect.sync(() => text),
    writeIfUnchanged: (_file: string, expected: Uint8Array, after: string | Uint8Array) =>
      Effect.sync(() => {
        if (new TextDecoder().decode(expected) !== text) throw Error("owned-cas-conflict")
        text = String(after)
        writes.push(text)
      }),
  } as unknown as FSUtil.Interface
  const flock = { withLock: (effect: Effect.Effect<unknown>) => effect } as unknown as EffectFlock.Interface
  const apply = (patch: Record<string, unknown>, removePaths: string[][], expected: string) =>
    Config.updateDocument(resolve("owned-memory-fixture"), patch, {
      removePaths,
      beforePatch: (document) => {
        if (document.text !== expected) throw Error("owned-revision-conflict")
      },
    }).pipe(Effect.provideService(FSUtil.Service, filesystem), Effect.provideService(EffectFlock.Service, flock))
  const old = text
  await Effect.runPromise(
    apply(
      { providers: { owned: { models: { wire: { name: "Edited", request: { body: { custom_mode: true } } } } } } },
      [["providers", "owned", "models", "wire", "request", "variant"]],
      old,
    ),
  )
  const parsed = Config.decodeDocument(text)[0].info.providers!.owned
  expect(parsed.models!.wire.request!.variant).toBeUndefined()
  expect(parsed.models!.wire.request!.headers).toEqual({ "x-model": "kept" })
  expect(parsed.models!.wire.request!.body).toEqual({ custom_mode: true })
  const previous = text
  await Effect.runPromise(
    apply({ providers: { owned: { models: {} } } }, [["providers", "owned", "models", "wire"]], previous),
  )
  expect(Config.decodeDocument(text)[0].info.providers!.owned.models).toEqual({})
  expect(text).toContain("owned synthetic fixture")
  expect(text).toContain('"unrelated": "kept"')
  expect(writes.length).toBe(2)
  const failure = await Effect.runPromise(Effect.exit(apply({ providers: { owned: { name: "Wrong" } } }, [], previous)))
  expect(failure._tag).toBe("Failure")
  expect(writes.length).toBe(2)
})

test("real host-owner authorization denies foreign/readonly principals before configuration or probes", () => {
  for (const principal of [
    { ...IdentityContext.LocalPrincipal, role: "member" as const },
    { ...IdentityContext.LocalPrincipal, userID: "foreign" },
  ]) {
    const result = Effect.runSync(
      Effect.result(authorizeConfiguration.pipe(Effect.provideService(IdentityContext.Current, principal))),
    )
    expect(result._tag).toBe("Failure")
  }
  expect(
    Effect.runSync(
      Effect.result(
        authorizeConfiguration.pipe(Effect.provideService(IdentityContext.Current, IdentityContext.LocalPrincipal)),
      ),
    )._tag,
  ).toBe("Success")
})

test("deleting a bundled-model override excludes inherited catalog/runtime availability; explicit re-add restores it",async()=>{
  const source=Schema.decodeUnknownSync(ModelsDev.Provider)(snapshot.deepseek)
  const victim="deepseek-v4-pro"
  const other=Object.keys(source.models).find(id=>id!==victim)!
  const original=Schema.decodeUnknownSync(ConfigProvider.Info)({name:source.name,api:{type:"aisdk",package:source.npm,url:source.api,settings:{}},authentication:"optional",models:{[victim]:{name:"Override",request:{headers:{"x-deleted":"old-owned-metadata"}}}}})
  const deleted=edit({name:source.name,models:[],revision:"r1",deletedModelIDs:[victim]},original)
  const encoded=Schema.encodeSync(ConfigProvider.Info)(deleted)
  expect(encoded.models?.[victim]).toBeUndefined()
  expect(encoded.excludedModels).toEqual([victim])
  expect(JSON.stringify(encoded)).not.toContain("old-owned-metadata")
  const restored=edit({name:source.name,models:[{id:victim,name:"Re-added"}],revision:"r2"},deleted)
  expect(restored.excludedModels).toEqual([])
  const inspect=(provider:typeof ConfigProvider.Info.Type)=>Effect.scoped(Effect.gen(function*(){
    const catalog=yield* Catalog.Service
    const ctx={catalog,integration:{transform:()=>Effect.void,reload:()=>Effect.void}}
    yield* ModelsDevPlugin.effect(ctx as never)
    yield* ConfigProviderPlugin.Plugin.effect(ctx as never)
    const ids=(yield* catalog.model.available()).map(model=>String(model.id))
    const result=yield* Effect.result(Effect.gen(function*(){const runtime=yield* SessionRunnerModel.Service;return yield* runtime.resolve({model:ModelV2.Ref.make({providerID:ProviderV2.ID.make("deepseek"),id:ModelV2.ID.make(victim)})} as never)}).pipe(Effect.provide(SessionRunnerModel.locationLayer)))
    return {ids,status:result._tag}
  }).pipe(
    Effect.provide(Catalog.layer),
    Effect.provideService(Config.Service,{entries:()=>Effect.succeed(Config.decodeDocument(JSON.stringify({providers:{deepseek:Schema.encodeSync(ConfigProvider.Info)(provider)}})))}),
    Effect.provideService(ModelsDev.Service,{get:()=>Effect.succeed({deepseek:source}),refresh:()=>Effect.void}),
    Effect.provideService(PluginEvents.Service,{subscribe:()=>Stream.never}),
    Effect.provideService(EventV2.Service,{publish:()=>Effect.void} as never),
    Effect.provideService(Policy.Service,{hasStatements:()=>false,evaluate:()=>Effect.succeed("allow"),load:()=>Effect.void}),
    Effect.provideService(Integration.Service,{transform:()=>Effect.void,list:()=>Effect.succeed([]),connection:{active:()=>Effect.succeed(undefined)}} as never),
    Effect.provideService(Credential.Service,{list:()=>Effect.succeed([])} as never),
  ))
  const missing=await Effect.runPromise(inspect(deleted))
  expect(missing.ids).not.toContain(victim);expect(missing.ids).toContain(other);expect(missing.status).toBe("Failure")
  const present=await Effect.runPromise(inspect(restored))
  expect(present.ids).toContain(victim);expect(present.ids).toContain(other);expect(present.status).toBe("Success")
})
