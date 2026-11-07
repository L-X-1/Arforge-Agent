import { expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import type { OperationsApi } from "@/utils/server"
import { Arforge } from "@arforge-ai/sdk-next/remote"
import { modelRow, validateCustomProvider } from "./dialog-custom-provider-form"
import {
  createProviderConfigurationSave,
  refreshProviderConfiguration,
  providerCredentialRetry,
  providerConfigurationReadonly,
} from "./provider-configuration"

const draft = {
  providerID: "owned",
  name: "Owned",
  key: undefined as string | undefined,
  config: {
    npm: "@ai-sdk/openai-compatible",
    name: "Owned",
    options: { baseURL: "http://127.0.0.1:1/v1", headers: undefined as Record<string, string> | undefined },
    models: { model: { name: "Model" } },
  },
}
function fixture() {
  const calls: { kind: string; input?: unknown }[] = []
  let revision: string | undefined,
    canWrite = true,
    credentialFails = false
  const api: Pick<OperationsApi["providers"], "save" | "capability" | "credential"> = {
    capability: async () => ({
      location: {} as never,
      data: {
        canWrite,
        reason: canWrite ? "host_owner" : "host_configuration_readonly",
        providers: revision ? [{ id: "owned", revision, disabled: false, canDisconnect: true }] : [],
      },
    }),
    save: async (input) => {
      calls.push({ kind: "save", input })
      revision = "revision-1"
      return { location: {} as never, data: { providerID: input.providerID, revision, disabled: false } }
    },
    credential: async (input) => {
      calls.push({ kind: "credential", input })
      if (credentialFails) throw new Error("private failure details")
      return { location: {} as never, data: { providerID: input.providerID, revision: "revision-1", disabled: false } }
    },
  }
  return {
    api,
    calls,
    readonly: () => {
      canWrite = false
    },
    fail: (value: boolean) => {
      credentialFails = value
    },
    conflict: () => {
      revision = "changed"
    },
  }
}
test("no-key saves nonsecret configuration without creating credentials", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  await save.save(draft, () => {})
  expect(f.calls.map((call) => call.kind)).toEqual(["save"])
  expect(f.calls[0]?.input).toMatchObject({ authentication: "optional" })
})

test("validated model limits/capabilities survive the frontend save projection", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  const model = {
    name: "Model",
    limit: { context: 4096, output: 512 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  }
  await save.save({ ...draft, config: { ...draft.config, models: { "relay-wire-id": model } } }, () => {})
  expect(f.calls[0]?.input).toMatchObject({ models: [{ id: "relay-wire-id", ...model }] })
})
test("metadata changes participate in the retry fingerprint while explicit empty variants and preset reference survive", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  const model = {
    name: "Model",
    limit: { context: 4096, input: 3000, output: 512 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    preset: { origin: { vendorID: "origin-vendor", modelID: "canonical-model" }, revision: "preset-1" },
    variants: [],
  }
  const withMetadata = { ...draft, config: { ...draft.config, models: { "relay-wire-id": model } } }
  await save.save(withMetadata, () => {})
  await save.save(withMetadata, () => {})
  expect(f.calls.map((call) => call.kind)).toEqual(["save"])
  await save.save(
    {
      ...withMetadata,
      config: {
        ...withMetadata.config,
        models: { "relay-wire-id": { ...model, limit: { ...model.limit, output: 333 } } },
      },
    },
    () => {},
  )
  expect(f.calls.map((call) => call.kind)).toEqual(["save", "save"])
  expect(f.calls[0].input).toMatchObject({ models: [{ id: "relay-wire-id", ...model }] })
  expect(f.calls[1].input).toMatchObject({
    models: [{ id: "relay-wire-id", limit: { context: 4096, input: 3000, output: 333 }, variants: [] }],
    revision: "revision-1",
  })
})
test("the real generated client serializes validated limits, capabilities, preset reference and existing canonical variants", async () => {
  const requests: { method: string; path: string; body: unknown }[] = []
  const location = {
    directory: "E:/fixtures/provider-save",
    project: { id: "fixture-project", directory: "E:/fixtures/provider-save" },
  }
  const api = Arforge.make({
    baseUrl: "http://configuration-fixture.invalid",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: request.method === "PUT" ? await request.json() : undefined,
        })
        const data =
          request.method === "GET"
            ? { canWrite: true, reason: "host_owner", providers: [] }
            : { providerID: "fixture-relay", revision: "fixture-revision", disabled: false }
        return new Response(JSON.stringify({ location, data }), { headers: { "content-type": "application/json" } })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  })
  const model = modelRow({
    id: "unchanged-relay-alias",
    name: "Manual label",
    limit: { context: 24680, input: 20000, output: 1234 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    preset: { origin: { vendorID: "fixture-origin", modelID: "fixture-canonical" }, revision: "fixture-catalog" },
    variants: [{ id: "existing-low", body: { reasoning_effort: "low" } }],
    defaultVariant: "existing-low",
  })
  const validated = validateCustomProvider({
    form: {
      providerID: "fixture-relay",
      name: "Fixture relay",
      baseURL: "https://relay.invalid/v1",
      apiKey: "",
      models: [model],
      headers: [],
      err: {},
    },
    t: (key) => key,
    disabledProviders: [],
    existingProviderIDs: new Set(),
  }).result
  if (!validated) throw new Error("Fixture form must validate")
  await createProviderConfigurationSave(api.providers, () => true).save(validated, () => {})
  expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
    { method: "GET", path: "/api/provider/configuration/capability" },
    { method: "PUT", path: "/api/provider/fixture-relay/configuration" },
  ])
  expect(requests[1].body).toEqual({
    name: "Fixture relay",
    baseURL: "https://relay.invalid/v1",
    authentication: "optional",
    models: [
      {
        id: "unchanged-relay-alias",
        name: "Manual label",
        limit: { context: 24680, input: 20000, output: 1234 },
        capabilities: model.capabilities,
        preset: model.preset,
        variants: model.variants,
        defaultVariant: "existing-low",
      },
    ],
  })
})
test("partial credential failure retries the same committed provider without duplicate save or secret-bearing config", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  const withKey = {
    ...draft,
    key: "owned-private-key",
    config: { ...draft.config, options: { ...draft.config.options, headers: { "X-Owned-Key": "owned-header" } } },
  }
  f.fail(true)
  await expect(save.save(withKey, () => {})).rejects.toThrow(providerCredentialRetry)
  expect(save.acknowledged("owned")).toBe(true)
  expect(JSON.stringify(f.calls[0]?.input)).not.toContain("owned-private-key")
  expect(JSON.stringify(f.calls[0]?.input)).not.toContain("owned-header")
  f.fail(false)
  await save.save(withKey, () => {})
  expect(f.calls.map((call) => call.kind)).toEqual(["save", "credential", "credential"])
})
test("missing permission cannot mutate and a changed source cannot continue to credentials", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  f.readonly()
  await expect(save.save(draft, () => {})).rejects.toThrow(providerConfigurationReadonly)
  expect(f.calls).toHaveLength(0)
  const next = fixture()
  let current = true
  const guarded = createProviderConfigurationSave(next.api, () => current)
  await expect(
    guarded.save({ ...draft, key: "owned-key" }, () => {
      current = false
    }),
  ).rejects.toThrow("source changed")
  expect(next.calls.map((call) => call.kind)).toEqual(["save"])
})
test("a changed committed revision fails closed before retrying credentials", async () => {
  const f = fixture(),
    save = createProviderConfigurationSave(f.api, () => true)
  await save.save(draft, () => {})
  f.conflict()
  await expect(save.save({ ...draft, key: "owned-key" }, () => {})).rejects.toThrow("configuration changed")
  expect(f.calls.map((call) => call.kind)).toEqual(["save"])
})

test("strict list refresh exposes a real query failure and can retry without changing default callers", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  let failed = true
  const key = ["owned-source", null, "providers"] as const
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: async () => {
      if (failed) throw new Error("owned catalog read failed")
      return ["owned-provider"]
    },
  })
  const unsubscribe = observer.subscribe(() => {})
  try {
    const error = await refreshProviderConfiguration({ queryClient: client }, "owned-source", {
      reportErrors: true,
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error instanceof Error ? error.message : "").toBe("owned catalog read failed")
    await refreshProviderConfiguration({ queryClient: client }, "owned-source")
    expect(client.getQueryState(key)?.status).toBe("error")
    failed = false
    await refreshProviderConfiguration({ queryClient: client }, "owned-source", { reportErrors: true })
    expect(client.getQueryData<string[]>(key)).toEqual(["owned-provider"])
    expect(client.getQueryState(key)?.status).toBe("success")
  } finally {
    unsubscribe()
    client.clear()
  }
})
