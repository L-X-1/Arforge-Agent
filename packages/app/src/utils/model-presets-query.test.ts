import { expect, test } from "bun:test"
import { CancelledError, QueryClient } from "@tanstack/solid-query"
import { Arforge } from "@arforge-ai/sdk-next/remote"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import { loadModelPresetCatalog } from "./model-presets-query"

const directory = "E:/fixtures/model-presets"
const catalog: ModelPreset.Catalog = {
  revision: "fixture-1",
  vendors: [{ id: "origin", name: "Origin" }],
  items: [
    {
      origin: { vendorID: "origin", modelID: "canonical" },
      name: "Canonical",
      aliases: [],
      status: "active",
      limit: { context: 12345, output: 789 },
      provenance: [{ source: "bundled", sourceID: "fixture" }],
    },
  ],
}
const response = (presets?: ModelPreset.Catalog, path = directory) =>
  new Response(
    JSON.stringify({
      location: { directory: path, project: { id: "fixture-project", directory: path } },
      data: [],
      ...(presets ? { presets } : {}),
    }),
    { headers: { "content-type": "application/json" } },
  )
const models = (run: (url: URL) => Response | Promise<Response>) =>
  Arforge.make({
    baseUrl: "http://preset-fixture.invalid",
    fetch: Object.assign(
      async (request: string | URL | Request) => run(new URL(request instanceof Request ? request.url : request)),
      { preconnect: globalThis.fetch.preconnect },
    ),
  }).models
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

test("opt-in travels through the real generated client and caches separately from connected availability", async () => {
  const queryClient = client(),
    urls: URL[] = []
  const api = models((url) => {
    urls.push(url)
    return response(catalog)
  })
  const availability = ["only-the-configured-model"]
  queryClient.setQueryData(["source-a", null, "providers"], availability)
  try {
    const input = { scope: "source-a", directory, models: api, queryClient, isCurrent: () => true }
    expect(await loadModelPresetCatalog(input)).toEqual(catalog)
    expect(await loadModelPresetCatalog(input)).toEqual(catalog)
    expect(urls).toHaveLength(1)
    expect(urls[0].pathname).toBe("/api/model")
    expect(urls[0].searchParams.get("includePresets")).toBe("true")
    expect(urls[0].searchParams.get("location[directory]")).toBe(directory)
    expect(queryClient.getQueryData<string[]>(["source-a", null, "providers"])).toEqual(availability)
    await loadModelPresetCatalog({ ...input, scope: "source-b" })
    await loadModelPresetCatalog({
      ...input,
      directory: "E:/fixtures/other",
      models: models(() => response(catalog, "E:/fixtures/other")),
    })
    expect(urls).toHaveLength(2)
    expect(
      queryClient.getQueryCache().findAll({ queryKey: ["source-a", directory, "models", "presets"] }),
    ).toHaveLength(1)
  } finally {
    queryClient.clear()
  }
})

test("an older response without presets leaves metadata unknown and never replaces connected data", async () => {
  const queryClient = client()
  try {
    expect(
      await loadModelPresetCatalog({
        scope: "old",
        directory,
        models: models(() => response()),
        queryClient,
        isCurrent: () => true,
      }),
    ).toBeUndefined()
    expect(queryClient.getQueryState(["old", directory, "models", "presets"])?.status).toBe("success")
  } finally {
    queryClient.clear()
  }
})

test("mismatched directory and actual HTTP errors reject instead of falling back to another source", async () => {
  const queryClient = client()
  try {
    await expect(
      loadModelPresetCatalog({
        scope: "wrong-directory",
        directory,
        models: models(() => response(catalog, "E:/fixtures/unrelated")),
        queryClient,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("different directory")
    await expect(
      loadModelPresetCatalog({
        scope: "failed",
        directory,
        models: models(() => new Response("offline", { status: 503 })),
        queryClient,
        isCurrent: () => true,
      }),
    ).rejects.toBeDefined()
  } finally {
    queryClient.clear()
  }
})

test("stale SDK/directory generation discards a delayed response, including an ABA return", async () => {
  const queryClient = client()
  let generation = 1,
    calls = 0,
    finish!: (response: Response) => void
  const api = models(() => {
    calls++
    return new Promise<Response>((done) => {
      finish = done
    })
  })
  try {
    const pending = loadModelPresetCatalog({
      scope: "captured-sdk",
      directory,
      models: api,
      queryClient,
      isCurrent: () => generation === 1,
    })
    // The fetch is reached synchronously through the generated client before waiting.
    expect(calls).toBe(1)
    generation = 2
    finish(response(catalog))
    expect(await pending).toBeUndefined()
    expect(
      await loadModelPresetCatalog({ scope: "disposed", directory, models: api, queryClient, isCurrent: () => false }),
    ).toBeUndefined()
    expect(calls).toBe(1)
  } finally {
    queryClient.clear()
  }
})

test("query cancellation reaches the captured request and cannot publish a delayed catalog", async () => {
  const queryClient = client()
  let finish!: (response: Response) => void
  try {
    const pending = loadModelPresetCatalog({
      scope: "cancelled",
      directory,
      queryClient,
      isCurrent: () => true,
      models: models(
        () =>
          new Promise<Response>((done) => {
            finish = done
          }),
      ),
    })
    const result = pending.then(
      () => "resolved",
      () => "cancelled",
    )
    await queryClient.cancelQueries({ queryKey: ["cancelled", directory, "models", "presets"] })
    finish(response(catalog))
    expect(await result).toBe("cancelled")
    expect(queryClient.getQueryData(["cancelled", directory, "models", "presets"])).toBeUndefined()
  } finally {
    queryClient.clear()
  }
})

test("overlapping A to B to A retires the shared query without caching unsupported and current retry fetches once", async () => {
  const queryClient = client()
  const key = ["aba-source", directory, "models", "presets"]
  let generation = 1,
    oldCalls = 0,
    currentCalls = 0,
    finish!: (response: Response) => void
  try {
    const firstA = loadModelPresetCatalog({
      scope: "aba-source",
      directory,
      queryClient,
      isCurrent: () => generation === 1,
      models: models(() => {
        oldCalls++
        return new Promise<Response>((done) => {
          finish = done
        })
      }),
    })
    generation = 2
    const otherDirectory = "E:/fixtures/directory-b"
    expect(
      await loadModelPresetCatalog({
        scope: "aba-source",
        directory: otherDirectory,
        queryClient,
        isCurrent: () => generation === 2,
        models: models(() => response({ ...catalog, revision: "directory-b" }, otherDirectory)),
      }),
    ).toMatchObject({ revision: "directory-b" })
    generation = 3
    const input = {
      scope: "aba-source",
      directory,
      queryClient,
      isCurrent: () => generation === 3,
      models: models(() => {
        currentCalls++
        return response(catalog)
      }),
    }
    const returnedA = loadModelPresetCatalog(input).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    expect(currentCalls).toBe(0) // Actual QueryClient deduplicates onto the pending first A.
    finish(response({ ...catalog, revision: "retired-a" }))
    expect(await firstA).toBeUndefined()
    expect((await returnedA).error).toBeInstanceOf(CancelledError)
    expect(queryClient.getQueryState(key)).toMatchObject({ status: "pending", fetchStatus: "idle", dataUpdatedAt: 0 })
    expect(queryClient.getQueryData(key)).toBeUndefined()
    expect(await loadModelPresetCatalog(input)).toEqual(catalog) // Same call used by the current form's Retry action.
    expect(await loadModelPresetCatalog(input)).toEqual(catalog) // Normal successful freshness is retained.
    expect([oldCalls, currentCalls]).toEqual([1, 1])
    expect(queryClient.getQueryCache().findAll({ queryKey: key, exact: true })).toHaveLength(1)
  } finally {
    queryClient.clear()
  }
})

test("retirement reverts an in-flight refetch to its existing valid cache before a fresh current retry", async () => {
  const queryClient = client()
  const key = ["cached-a", directory, "models", "presets"]
  const cached = { catalog: { ...catalog, revision: "previous-valid-a" } }
  let generation = 1,
    currentCalls = 0,
    finish!: (response: Response) => void
  try {
    queryClient.setQueryData(key, cached)
    await queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" })
    const previousState = queryClient.getQueryState(key)!
    const firstA = loadModelPresetCatalog({
      scope: "cached-a",
      directory,
      queryClient,
      isCurrent: () => generation === 1,
      models: models(
        () =>
          new Promise<Response>((done) => {
            finish = done
          }),
      ),
    })
    generation = 3
    const input = {
      scope: "cached-a",
      directory,
      queryClient,
      isCurrent: () => generation === 3,
      models: models(() => {
        currentCalls++
        return response(catalog)
      }),
    }
    const returnedA = loadModelPresetCatalog(input)
    finish(response({ ...catalog, revision: "retired-a" }))
    expect(await firstA).toBeUndefined()
    expect(await returnedA).toEqual(cached.catalog)
    expect(queryClient.getQueryData<typeof cached>(key)).toBe(cached)
    expect(queryClient.getQueryState(key)).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      isInvalidated: true,
      dataUpdatedAt: previousState.dataUpdatedAt,
      dataUpdateCount: previousState.dataUpdateCount,
      errorUpdateCount: previousState.errorUpdateCount,
    })
    expect(currentCalls).toBe(0)
    expect(await loadModelPresetCatalog(input)).toEqual(catalog)
    expect(currentCalls).toBe(1)
  } finally {
    queryClient.clear()
  }
})

test("a retired HTTP failure cannot publish an error over the previous valid source cache", async () => {
  const queryClient = client()
  const key = ["retired-error", directory, "models", "presets"]
  const cached = { catalog }
  let active = true,
    finish!: (response: Response) => void
  try {
    queryClient.setQueryData(key, cached)
    await queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" })
    const pending = loadModelPresetCatalog({
      scope: "retired-error",
      directory,
      queryClient,
      isCurrent: () => active,
      models: models(
        () =>
          new Promise<Response>((done) => {
            finish = done
          }),
      ),
    })
    active = false
    finish(new Response("retired transport failure", { status: 503 }))
    expect(await pending).toBeUndefined()
    expect(queryClient.getQueryData<typeof cached>(key)).toBe(cached)
    expect(queryClient.getQueryState(key)).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      error: null,
      errorUpdateCount: 0,
    })
  } finally {
    queryClient.clear()
  }
})

test("an already-aborted old completion cannot cancel a newer same-key fetch", async () => {
  const queryClient = client()
  const key = ["replaced-fetch", directory, "models", "presets"]
  let generation = 1,
    finishOld!: (response: Response) => void,
    finishNew!: (response: Response) => void
  try {
    const old = loadModelPresetCatalog({
      scope: "replaced-fetch",
      directory,
      queryClient,
      isCurrent: () => generation === 1,
      models: models(
        () =>
          new Promise<Response>((done) => {
            finishOld = done
          }),
      ),
    }).catch(() => undefined)
    await queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: true })
    generation = 3
    const current = loadModelPresetCatalog({
      scope: "replaced-fetch",
      directory,
      queryClient,
      isCurrent: () => generation === 3,
      models: models(
        () =>
          new Promise<Response>((done) => {
            finishNew = done
          }),
      ),
    })
    finishOld(response({ ...catalog, revision: "retired-a" }))
    await old
    // Flush the old transport's promise continuation without a timing-based delay.
    await Promise.resolve()
    await Promise.resolve()
    expect(queryClient.getQueryState(key)?.fetchStatus).toBe("fetching")
    finishNew(response(catalog))
    expect(await current).toEqual(catalog)
    expect(queryClient.getQueryState(key)).toMatchObject({ status: "success", fetchStatus: "idle" })
  } finally {
    queryClient.clear()
  }
})
