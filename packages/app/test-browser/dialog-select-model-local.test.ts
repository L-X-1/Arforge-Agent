import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createEffect, createRoot } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { render } from "solid-js/web"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Platform } from "@/context/platform"
import { ServerScope } from "@/utils/server-scope"

type Environment = { scope: ServerScope; directory: string; id: string }
let environment: Environment
let setEnvironment: SetStoreFunction<Environment>
let Local: typeof import("@/context/local")
let PlatformContext: typeof import("@/context/platform")
let Persistence: typeof import("@/utils/persist")
const disposals: (() => void)[] = []
let recentWrites = 0

const alpha = { providerID: "p", modelID: "alpha" }
const beta = { providerID: "p", modelID: "beta" }
const provider = { id: "p", name: "Provider", models: { alpha: { id: "alpha" }, beta: { id: "beta" } } }
const items = ["alpha", "beta"].map((id) => ({ id, name: id, provider, variants: {} }))
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const record = (model: { providerID: string; modelID: string }) =>
  JSON.stringify({ session: { session: { agent: "build", model } } })

beforeAll(async () => {
  // Bun does not compile Solid JSX by itself. Compile the real context factory,
  // rather than replacing it with the no-op used by lightweight state tests.
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solidModule = require("babel-preset-solid")
  await plugin({
    name: "model-picker-real-solid-context",
    setup(build) {
      build.onLoad({ filter: /[\\/]ui[\\/]src[\\/]context[\\/]helper\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path,
          configFile: false,
          babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solidModule.default ?? solidModule, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Solid context compilation failed")
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  const context = await import("../../ui/src/context/helper")
  mock.module("@arforge-ai/ui/context", () => ({ createSimpleContext: context.createSimpleContext }))
  mock.module("@solidjs/router", () => ({ useParams: () => ({ get id() { return environment.id } }) }))
  mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ scope: environment.scope, directory: environment.directory }) }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: environment.scope }) }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({ data: { agent: [{ name: "build", mode: "primary" }], config: { model: "p/alpha" } } }),
  }))
  mock.module("@/context/settings", () => ({ useSettings: () => ({ visibility: { customAgents: () => false } }) }))
  mock.module("@/hooks/use-providers", () => ({
    useProviders: () => ({ all: () => new Map([["p", provider]]), connected: () => [provider], default: () => ({ p: "alpha" }) }),
  }))
  mock.module("@/context/models", () => ({
    useModels: () => ({
      ready: () => true, list: () => items,
      find: (key: { providerID: string; modelID: string }) => items.find((item) => item.id === key.modelID && item.provider.id === key.providerID),
      visible: () => true, setVisibility: () => undefined,
      recent: { list: () => [alpha], push: () => recentWrites++ },
      variant: { get: () => undefined, set: () => undefined },
    }),
  }))
  PlatformContext = await import("@/context/platform")
  Persistence = await import("@/utils/persist")
  Local = await import("@/context/local")
})

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
  recentWrites = 0
})

function observeStorageReads() {
  // Happy DOM ignores ordinary assignment to Storage methods. Its explicit
  // defineProperty trap replaces the real method and prevents automatic rebinding.
  const storage = localStorage
  const original = storage.getItem.bind(storage)
  const read = mock((name: string) => original(name))
  Object.defineProperty(storage, "getItem", { value: read, configurable: true, writable: true })
  disposals.push(() => {
    Object.defineProperty(storage, "getItem", { value: original, configurable: true, writable: true })
  })
  expect(storage.getItem).toBe(read)
  return read
}

function webPlatform(): Platform {
  return {
    platform: "web", openLink: () => undefined, restart: async () => undefined,
    back: () => undefined, forward: () => undefined, notify: async () => undefined,
  }
}

function mount(directory: string, platform = webPlatform(), scope = ServerScope.local) {
  ;[environment, setEnvironment] = createStore({ directory, scope, id: "session" })
  const host = document.createElement("div")
  document.body.append(host)
  let local!: ReturnType<typeof Local.useLocal>
  const Probe = () => {
    local = Local.useLocal()
    createEffect(() => {
      host.dataset.ready = String(local.session.ready())
      host.dataset.model = local.model.current()?.id ?? "unavailable"
    })
    return document.createTextNode("mounted")
  }
  const dispose = render(() => createComponent(PlatformContext.PlatformProvider, {
    value: platform,
    get children() {
      return createComponent(Local.LocalProvider, {
        get children() { return createComponent(Probe, {}) },
      })
    },
  }), host)
  let disposed = false
  const cleanup = () => { if (disposed) return; disposed = true; dispose(); host.remove() }
  disposals.push(cleanup)
  return { local, host, dispose: cleanup }
}

function storageKey(directory: string, scope = ServerScope.local) {
  const target = Persistence.Persist.serverWorkspace(scope, directory, "model-selection", ["model-selection.v1"])
  return { target, name: target.storage + ":" + target.key }
}

describe("real LocalProvider model persistence", () => {
  test("nonempty web hydration settles once with no picker mounted and writes do not reconstruct it", async () => {
    const directory = "E:/model-picker-test/web-hydrated"
    const key = storageKey(directory)
    localStorage.setItem(key.name, record(alpha))
    const read = observeStorageReads()
    const mounted = mount(directory)
    await settle()
    expect(mounted.host.textContent).toBe("mounted")
    expect(mounted.local.session.ready()).toBe(true)
    expect(mounted.local.model.current()?.id).toBe("alpha")
    expect(read.mock.calls.filter(([name]) => name === key.name)).toHaveLength(1)
    mounted.local.modelSelection.select(beta, mounted.local.modelSelection.scope())
    await settle()
    expect(mounted.local.model.current()?.id).toBe("beta")
    expect(read.mock.calls.filter(([name]) => name === key.name)).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(key.name)!).session.session.model).toEqual(beta)
    expect(recentWrites).toBe(0)
  })

  test("first restoration settles and persistence serialization cannot subscribe a writing effect", async () => {
    const directory = "E:/model-picker-test/web-first-restore"
    const key = storageKey(directory)
    const read = observeStorageReads()
    const mounted = mount(directory)
    await settle()
    mounted.local.session.restore({ sessionID: "session", agent: "build", model: beta })
    await settle()
    expect(mounted.local.model.current()?.id).toBe("beta")
    let runs = 0
    const stop = createRoot((dispose) => {
      createEffect(() => {
        runs++
        mounted.local.session.promote(directory, "effect-session", { agent: "build", model: alpha })
      })
      return dispose
    })
    disposals.push(stop)
    expect(runs).toBe(1)
    mounted.local.modelSelection.select(alpha, mounted.local.modelSelection.scope())
    await settle()
    expect(runs).toBe(1)
    expect(mounted.local.model.current()?.id).toBe("alpha")
    expect(read.mock.calls.filter(([name]) => name === key.name)).toHaveLength(1)
  })

  test("workspace/server changes isolate late hydration and old scope writes, including disposal", async () => {
    const pending = new Map<string, (value: string | null) => void>()
    const reads: string[] = []
    const writes: string[] = []
    const storage = (name = ""): AsyncStorage => ({
      getItem: (key) => new Promise((resolve) => {
        const path = name + ":" + key
        reads.push(path)
        pending.set(path, resolve)
      }),
      setItem: async (key) => { writes.push(name + ":" + key) },
      removeItem: async () => undefined, clear: async () => undefined,
      key: async () => null, getLength: async () => 0, length: Promise.resolve(0),
    })
    const platform: Platform = {
      ...webPlatform(), platform: "desktop", storage,
      openDirectoryPickerDialog: async () => null,
    }
    const firstScope = "picker-server-a" as ServerScope
    const secondScope = "picker-server-b" as ServerScope
    const first = "E:/model-picker-test/async-first"
    const second = "E:/model-picker-test/async-second"
    const mounted = mount(first, platform, firstScope)
    expect(mounted.local.session.ready()).toBe(false)
    const firstKey = storageKey(first, firstScope).name
    setEnvironment("directory", second)
    const secondKey = storageKey(second, firstScope).name
    expect(reads).toEqual([firstKey, secondKey])
    pending.get(secondKey)!(record(beta))
    await settle()
    expect(mounted.local.session.ready()).toBe(true)
    expect(mounted.local.model.current()?.id).toBe("beta")
    pending.get(firstKey)!(record(alpha))
    await settle()
    expect(mounted.local.model.current()?.id).toBe("beta")
    const oldScope = mounted.local.modelSelection.scope()
    mounted.local.modelSelection.select(alpha, oldScope)
    expect(writes).toEqual([secondKey])
    setEnvironment("scope", secondScope)
    const thirdKey = storageKey(second, secondScope).name
    expect(mounted.local.session.ready()).toBe(false)
    pending.get(thirdKey)!(record(beta))
    await settle()
    expect(mounted.local.model.current()?.id).toBe("beta")
    expect(() => mounted.local.modelSelection.select(alpha, oldScope)).toThrow()
    expect(writes).toEqual([secondKey])
    expect(reads).toEqual([firstKey, secondKey, thirdKey])
    setEnvironment("directory", first)
    const fourthKey = storageKey(first, secondScope).name
    mounted.dispose()
    pending.get(fourthKey)!(record(alpha))
    await settle()
    expect(mounted.host.textContent).toBe("")
    expect(reads).toEqual([firstKey, secondKey, thirdKey, fourthKey])
    expect(writes).toEqual([secondKey])
  })

  test("an unavailable explicit model survives hydration without using configured or recent fallbacks", async () => {
    const directory = "E:/model-picker-test/web-unavailable"
    const key = storageKey(directory)
    const missing = { providerID: "p", modelID: "removed" }
    const original = record(missing)
    localStorage.setItem(key.name, original)
    const mounted = mount(directory)
    await settle()
    expect(mounted.local.session.ready()).toBe(true)
    expect(mounted.local.modelSelection.key()).toEqual(missing)
    expect(mounted.local.model.current()).toBeUndefined()
    expect(mounted.local.modelSelection.unavailable()).toBe("removed")
    expect(() => mounted.local.modelSelection.select(missing, mounted.local.modelSelection.scope())).toThrow()
    expect(localStorage.getItem(key.name)).toBe(original)
    expect(recentWrites).toBe(0)
  })
})
