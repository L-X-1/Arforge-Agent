import { beforeAll, afterEach, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as solid from "solid-js"
import * as store from "solid-js/store"
import * as web from "solid-js/web"
import * as query from "@tanstack/solid-query"
import type { ModelPreset } from "@arforge-ai/schema/model-preset"
import type { OperationsApi } from "@/utils/server"
import { modelPresetKey } from "@/utils/model-preset-match"
const req = createRequire(import.meta.resolve("vite-plugin-solid"))
type Notice = {
  title?: string
  description?: string
  persistent?: boolean
  actions?: { label: string; onClick: "dismiss" | (() => void) }[]
}
type ControlProps = {
  type?: "button" | "submit" | "reset"
  disabled?: boolean
  children?: solid.JSX.Element
  onClick?: (event: MouseEvent) => void
  label?: string
  value?: string
  onChange?: (value: string) => void
}
let SDKProvider: typeof import("@/context/server-sdk").ServerSDKProvider
let Form: typeof import("./dialog-custom-provider").CustomProviderForm
let CreateDialog: typeof import("./dialog-custom-provider").DialogCustomProvider
let readSDK: () => unknown, readSync: () => unknown, closeDialog: () => void
const disposals: (() => void)[] = []
const notices: Notice[] = []
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0))
}
function deferred() {
  let resolve!: () => void, reject!: (reason?: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeAll(async () => {
  const babel = req("@babel/core"),
    preset = req("babel-preset-solid")
  plugin({
    name: "owned-provider-form-dom",
    setup(build) {
      build.onLoad(
        {
          filter:
            /[\\/]packages[\\/](app[\\/]src[\\/](components[\\/](dialog-custom-provider|custom-provider-model-fields)|context[\\/]server-sdk)|ui[\\/]src[\\/]context[\\/]helper)\.tsx$/,
        },
        async ({ path }) => {
          const source = await Bun.file(path).text()
          const result = babel.transformSync(source, {
            filename: path,
            configFile: false,
            babelrc: false,
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [[preset.default ?? preset, { generate: "dom" }]],
          })
          return { contents: result.code, loader: "ts" }
        },
      )
    },
  })
  await mock.module("@/context/global", () => ({
    useGlobal: () => ({ ensureServerCtx: (conn: { sdk: unknown }) => ({ sdk: conn.sdk }) }),
  }))
  await mock.module(fileURLToPath(new URL("../context/global.tsx", import.meta.url)), () => ({
    useGlobal: () => ({ ensureServerCtx: (conn: { sdk: unknown }) => ({ sdk: conn.sdk }) }),
  }))
  await mock.module(fileURLToPath(new URL("../context/server.tsx", import.meta.url)), () => ({
    ServerConnection: {},
    useServer: () => ({
      get current() {
        return { sdk: readSDK() }
      },
    }),
  }))
  await mock.module(fileURLToPath(new URL("../context/language.tsx", import.meta.url)), () => ({
    useLanguage: () => ({ locale: () => "en", intl: () => "en-US", t: (key: string) => key }),
  }))
  await mock.module("@/context/server", () => ({
    ServerConnection: {},
    useServer: () => ({
      get current() {
        return { sdk: readSDK() }
      },
    }),
  }))
  await mock.module("@/context/server-sync", () => ({ useServerSync: () => () => readSync() }))
  await mock.module("@/context/language", () => ({
    useLanguage: () => ({ locale: () => "en", intl: () => "en-US", t: (key: string) => key }),
  }))
  await mock.module("@arforge-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => closeDialog() }) }))
  await mock.module("@/utils/toast", () => ({
    showToast: (notice: Notice) => {
      notices.push(notice)
      const box = document.createElement("div")
      box.setAttribute("role", "alert")
      box.dataset.toast = "true"
      box.textContent = (notice.title ?? "") + " " + (notice.description ?? "")
      for (const action of notice.actions ?? []) {
        const button = document.createElement("button")
        button.textContent = action.label
        button.onclick = () => {
          if (typeof action.onClick === "function") action.onClick()
          box.remove()
        }
        box.append(button)
      }
      document.body.append(box)
    },
  }))
  const Button = (props: ControlProps) => {
    const el = document.createElement("button")
    el.type = props.type ?? "button"
    solid.createEffect(() => {
      el.disabled = !!props.disabled
      const value = props.children
      el.textContent = typeof value === "string" || typeof value === "number" ? String(value) : ""
    })
    el.onclick = (e) => props.onClick?.(e)
    return el
  }
  await mock.module("@arforge-ai/ui/button", () => ({ Button }))
  await mock.module("@arforge-ai/ui/icon-button", () => ({ IconButton: Button }))
  await mock.module("@arforge-ai/ui/provider-icon", () => ({ ProviderIcon: () => null }))
  await mock.module("@arforge-ai/ui/dialog", () => ({
    Dialog: (props: { children?: solid.JSX.Element }) => props.children,
  }))
  await mock.module("@arforge-ai/ui/text-field", () => ({
    TextField: (props: ControlProps) => {
      const el = document.createElement("input")
      el.type = props.type ?? "text"
      el.dataset.label = String(props.label)
      solid.createEffect(() => {
        el.value = props.value ?? ""
      })
      el.oninput = () => props.onChange?.(el.value)
      return el
    },
  }))
  SDKProvider = (await import("@/context/server-sdk")).ServerSDKProvider
  Form = (await import("./dialog-custom-provider")).CustomProviderForm
  CreateDialog = (await import("./dialog-custom-provider")).DialogCustomProvider
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  notices.splice(0)
  document.body.replaceChildren()
})
function fixture({
  credentialFailure = false,
  holdWrite = false,
  saveFailure = false,
  holdCredential = false,
  dialog = false,
  catalog,
}: {
  credentialFailure?: boolean
  holdWrite?: boolean
  saveFailure?: boolean
  holdCredential?: boolean
  dialog?: boolean
  catalog?: ModelPreset.Catalog
} = {}) {
  const client = new query.QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } },
  })
  const refresh = deferred(),
    retryRefresh = deferred(),
    write = deferred(),
    credentialWrite = deferred()
  const creationEvents: string[] = []
  let saves = 0,
    credentials = 0,
    closed = 0,
    refreshes = 0,
    revision: string | undefined
  client.invalidateQueries = () => {
    refreshes++
    return refreshes === 1 ? refresh.promise : retryRefresh.promise
  }
  const saveInputs: Parameters<OperationsApi["providers"]["save"]>[0][] = []
  const location = {
    directory: "E:/fixtures/provider-form",
    project: { id: "fixture-project", directory: "E:/fixtures/provider-form" },
  }
  const api = {
    capability: async () => ({
      data: { canWrite: true, providers: revision ? [{ id: "owned", revision, disabled: false }] : [] },
    }),
    save: async (input: Parameters<OperationsApi["providers"]["save"]>[0]) => {
      saveInputs.push(input)
      saves++
      if (saveFailure) throw Error("owned configuration failure")
      if (holdWrite) await write.promise
      revision = "r1"
      return { data: { providerID: "owned", revision } }
    },
    credential: async () => {
      credentials++
      if (holdCredential) await credentialWrite.promise
      if (credentialFailure) throw Error("owned credential failure")
      return { data: { providerID: "owned", revision } }
    },
  }
  const sdkA = {
      scope: "source-A",
      protocol: Promise.resolve("v2"),
      operationsApi: {
        providers: api,
        models: { list: async () => ({ location, data: [], ...(catalog ? { presets: catalog } : {}) }) },
      },
    },
    syncA = {
      queryClient: client,
      data: { path: { directory: location.directory }, config: {}, provider: { all: new Map() } },
    }
  const sdkB = { ...sdkA, scope: "source-B" },
    syncB = { ...syncA }
  const [state, setState] = store.createStore({ open: true, source: "A" })
  readSDK = () => (state.source === "A" ? sdkA : sdkB)
  readSync = () => (state.source === "A" ? syncA : syncB)
  closeDialog = () => {
    creationEvents.push("closed")
    closed++
    setState("open", false)
  }
  const host = document.createElement("div")
  document.body.append(host)
  const disposeRoot = web.render(
    () =>
      solid.createComponent(query.QueryClientProvider, {
        client,
        get children() {
          return solid.createComponent(SDKProvider, {
            get children() {
              return solid.createComponent(solid.Show, {
                keyed: true,
                get when() {
                  return state.open
                },
                get children() {
                  const onCreated = (providerID: string) => creationEvents.push(providerID)
                  return dialog
                    ? solid.createComponent(CreateDialog, { onBack: closeDialog, onCreated })
                    : solid.createComponent(Form, { onCreated })
                },
              })
            },
          })
        },
      }),
    host,
  )
  disposals.push(disposeRoot)
  disposals.push(() => {
    refresh.resolve()
    retryRefresh.resolve()
    write.resolve()
    credentialWrite.resolve()
    client.clear()
  })
  const fill = (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>('input[data-label="' + label + '"]')
    if (!input) throw Error("Missing real form input: " + label)
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const valid = () => {
    for (const [key, value] of Object.entries({
      "field.providerID": "owned",
      "field.name": "Owned provider",
      "field.baseURL": "http://127.0.0.1:1/v1",
      "models.id": "owned-model",
      "models.name": "Owned model",
    }))
      fill("provider.custom." + key + ".label", value)
  }
  const submit = () => {
    const form = host.querySelector("form")
    if (!form) throw Error("Real form missing")
    return form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  }
  return {
    host,
    disposeRoot,
    refresh,
    retryRefresh,
    write,
    credentialWrite,
    creationEvents,
    valid,
    fill,
    submit,
    saveInputs,
    failCredential: (value: boolean) => {
      credentialFailure = value
    },
    switchSource: (source = "B") => setState("source", source),
    get saves() {
      return saves
    },
    get credentials() {
      return credentials
    },
    get closed() {
      return closed
    },
    get refreshes() {
      return refreshes
    },
  }
}

test("real inline form owns each metadata field and explicitly selects an origin without rewriting a relay alias", async () => {
  const one: ModelPreset.Preset = {
    origin: { vendorID: "vendor-a", modelID: "canonical-one" },
    name: "First model",
    aliases: [],
    limit: { context: 1000, output: 100 },
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    status: "active",
    provenance: [{ source: "bundled", sourceID: "fixture" }],
  }
  const two: ModelPreset.Preset = {
    ...one,
    origin: { vendorID: "vendor-b", modelID: "canonical-two" },
    name: "Second model",
    limit: { context: 2000, output: 200 },
  }
  const h = fixture({
    catalog: {
      revision: "fixture-catalog",
      vendors: [
        { id: "vendor-a", name: "Manufacturer A" },
        { id: "vendor-b", name: "Manufacturer B" },
      ],
      items: [one, two],
    },
  })
  await settle()
  expect(h.host.querySelector("[data-model-parameters]")).toBeNull()
  h.fill("provider.custom.field.providerID.label", "owned")
  h.fill("provider.custom.field.name.label", "Owned relay")
  h.fill("provider.custom.field.baseURL.label", "https://relay.invalid/v1")
  h.fill("provider.custom.models.id.label", "canonical-one")
  await settle()
  const value = (label: string) => h.host.querySelector<HTMLInputElement>('input[data-label="' + label + '"]')?.value
  expect(value("provider.custom.models.name.label")).toBe("First model")
  expect(value("Context capacity (tokens)")).toBe("1000")
  expect(value("Maximum output (tokens)")).toBe("100")
  h.fill("Maximum output (tokens)", "55")
  h.fill("provider.custom.models.id.label", "canonical-two")
  await settle()
  expect(value("provider.custom.models.name.label")).toBe("Second model")
  expect(value("Context capacity (tokens)")).toBe("2000")
  expect(value("Maximum output (tokens)")).toBe("55")
  h.fill("provider.custom.models.id.label", "arbitrary-relay-alias")
  await settle()
  expect(value("provider.custom.models.name.label")).toBe("arbitrary-relay-alias")
  expect(value("Context capacity (tokens)")).toBe("")
  expect(value("Maximum output (tokens)")).toBe("55")
  const select = h.host.querySelector<HTMLSelectElement>('select[aria-label="Model preset"]')
  if (!select) throw Error("Inline preset selector missing")
  expect([...select.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
    "Manufacturer A",
    "Manufacturer B",
  ])
  select.value = modelPresetKey(one)
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await settle()
  h.fill("provider.custom.models.name.label", "Manual relay label")
  h.fill("Context capacity (tokens)", "777")
  await settle()
  expect(value("provider.custom.models.id.label")).toBe("arbitrary-relay-alias")
  expect(value("provider.custom.models.name.label")).toBe("Manual relay label")
  expect(value("provider.custom.field.baseURL.label")).toBe("https://relay.invalid/v1")
  expect(value("Context capacity (tokens)")).toBe("777")
  expect(value("Maximum output (tokens)")).toBe("55")
  h.submit()
  await settle()
  expect(h.closed).toBe(1)
  expect(h.saves).toBe(1)
  expect(h.saveInputs[0]).toMatchObject({
    providerID: "owned",
    baseURL: "https://relay.invalid/v1",
    models: [
      {
        id: "arbitrary-relay-alias",
        name: "Manual relay label",
        limit: { context: 777, output: 55 },
        capabilities: one.capabilities,
        preset: { origin: one.origin, revision: "fixture-catalog" },
      },
    ],
  })
})

test("confirmed current config closes independently of a pending directory refresh", async () => {
  const h = fixture()
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.saves).toBe(1)
  expect(h.refreshes).toBe(1)
  expect(h.closed).toBe(1)
  expect(h.host.querySelector("form")).toBeNull()
  expect(h.creationEvents).toEqual(["owned", "closed"])
})

test("the real create dialog notifies its workspace once, only after both configuration and credential succeed", async () => {
  const h = fixture({ dialog: true, holdCredential: true })
  await settle()
  h.valid()
  h.fill("provider.custom.field.apiKey.label", "owned-synthetic-key")
  h.submit()
  await settle()
  expect(h.saves).toBe(1)
  expect(h.credentials).toBe(1)
  expect(h.closed).toBe(0)
  expect(h.creationEvents).toEqual([])
  h.credentialWrite.resolve()
  await settle()
  expect(h.creationEvents).toEqual(["owned", "closed"])
  expect(h.saveInputs[0].models).toEqual([{ id: "owned-model", name: "Owned model" }])
  expect(h.saveInputs[0].authentication).toBe("required")
  expect(h.refreshes).toBe(1)
})

test("credential failure remains visible and retryable while directory refresh is pending", async () => {
  const h = fixture({ credentialFailure: true })
  await settle()
  h.valid()
  h.fill("provider.custom.field.apiKey.label", "owned-synthetic-key")
  h.submit()
  await settle()
  expect(h.saves).toBe(1)
  expect(h.credentials).toBe(1)
  expect(h.closed).toBe(0)
  expect(h.creationEvents).toEqual([])
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("credential connection failed")
  expect(h.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
  h.failCredential(false)
  h.submit()
  await settle()
  expect(h.saves).toBe(1)
  expect(h.credentials).toBe(2)
  expect(h.closed).toBe(1)
  expect(h.creationEvents).toEqual(["owned", "closed"])
})

test("old source write acknowledgement cannot close or overwrite the new source form", async () => {
  const h = fixture({ holdWrite: true })
  await settle()
  h.valid()
  h.submit()
  await settle()
  h.switchSource()
  await settle()
  h.fill("provider.custom.field.name.label", "New-source draft")
  h.write.resolve()
  await settle()
  expect(h.closed).toBe(0)
  expect(h.creationEvents).toEqual([])
  expect(h.host.querySelector<HTMLInputElement>('input[data-label="provider.custom.field.name.label"]')?.value).toBe(
    "New-source draft",
  )
  expect(h.credentials).toBe(0)
})

test("a retired A create acknowledgement cannot notify a new A form after A-B-A", async () => {
  const h = fixture({ holdWrite: true })
  await settle()
  h.valid()
  h.submit()
  await settle()
  h.switchSource("B")
  await settle()
  h.switchSource("A")
  await settle()
  h.fill("provider.custom.field.name.label", "Reclaimed A draft")
  h.write.resolve()
  await settle()
  expect(h.creationEvents).toEqual([])
  expect(h.closed).toBe(0)
  expect(h.host.querySelector<HTMLInputElement>('input[data-label="provider.custom.field.name.label"]')?.value).toBe(
    "Reclaimed A draft",
  )
})

test("refresh failure after real dialog cleanup remains visible with a source-bound retry", async () => {
  const h = fixture()
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.closed).toBe(1)
  h.refresh.reject(Error("owned read failure"))
  await settle()
  const notice = notices.find((n) => n.persistent === true)
  expect(notice?.description).toContain("Configuration saved")
  const action = [...document.querySelectorAll<HTMLButtonElement>("[data-toast] button")].find(
    (b) => b.textContent === "Retry list refresh",
  )
  expect(action).toBeDefined()
  if (!action) throw Error("Retry action missing")
  action.click()
  await settle()
  expect(h.refreshes).toBe(2)
  expect(h.saves).toBe(1)
  h.retryRefresh.resolve()
  await settle()
  expect(notices.filter((n) => n.persistent === true)).toHaveLength(1)
})

test("late refresh error after source switch does not report or retry against the new source", async () => {
  const h = fixture()
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.closed).toBe(1)
  h.switchSource()
  h.refresh.reject(Error("old source read failure"))
  await settle()
  expect(notices.filter((n) => n.persistent === true)).toHaveLength(0)
  expect(h.saves).toBe(1)
})

test("a failed configuration write plus refresh failure never claims configuration saved", async () => {
  const h = fixture({ saveFailure: true })
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.closed).toBe(0)
  expect(h.saves).toBe(1)
  expect(h.credentials).toBe(0)
  expect(h.host.querySelector('[role="alert"]')?.textContent).toContain("owned configuration failure")
  expect(h.creationEvents).toEqual([])
  h.refresh.reject(Error("owned refresh failure"))
  await settle()
  const notice = notices.find((n) => n.persistent === true)
  expect(notice).toBeDefined()
  expect(notice?.description ?? "").not.toContain("Configuration saved")
  expect(h.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
})

test("real createSimpleContext SDK provider disposal suppresses a detached refresh error", async () => {
  const h = fixture()
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.closed).toBe(1)
  h.disposeRoot()
  h.refresh.reject(Error("owned disposed-root failure"))
  await settle()
  expect(notices.filter((n) => n.persistent === true)).toHaveLength(0)
})

test("real createSimpleContext SDK provider disposal revokes an already-rendered retry", async () => {
  const h = fixture()
  await settle()
  h.valid()
  h.submit()
  await settle()
  expect(h.closed).toBe(1)
  h.refresh.reject(Error("owned catalog failure"))
  await settle()
  const action = [...document.querySelectorAll<HTMLButtonElement>("[data-toast] button")].find(
    (b) => b.textContent === "Retry list refresh",
  )
  expect(action).toBeDefined()
  if (!action) throw Error("Retry action missing")
  h.disposeRoot()
  action.click()
  await settle()
  expect(h.refreshes).toBe(1)
})
