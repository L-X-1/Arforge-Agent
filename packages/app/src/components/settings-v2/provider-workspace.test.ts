import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import * as solid from "solid-js"
import * as web from "solid-js/web"
import { QueryClient } from "@tanstack/solid-query"
import { Arforge } from "@arforge-ai/sdk-next/remote"
import type { WorkspaceApi, WorkspaceDetail, WorkspaceTestResult } from "./provider-workspace-operations"
const require = createRequire(import.meta.resolve("vite-plugin-solid"))
let View: typeof import("./provider-workspace").ProviderWorkspaceSource
let confirmAllowed = true
let dialogHost: HTMLElement | undefined
const confirmations: string[] = [],
  disposals: (() => void)[] = []
beforeAll(async () => {
  const babel = require("@babel/core"),
    preset = require("babel-preset-solid")
  plugin({
    name: "provider-workspace-real-dom",
    setup(build) {
      build.onLoad(
        {
          filter:
            /[\\/]packages[\\/]app[\\/]src[\\/]components[\\/](settings-v2[\\/]provider-workspace|provider-model-editor|custom-provider-model-fields)\.tsx$/,
        },
        async ({ path }) => ({
          contents: babel.transformSync(await Bun.file(path).text(), {
            filename: path,
            configFile: false,
            babelrc: false,
            parserOpts: { plugins: ["typescript", "jsx"] },
            presets: [[preset.default ?? preset, { generate: "dom" }]],
          }).code,
          loader: "ts",
        }),
      )
    },
  })
  await mock.module("../dialog-custom-provider", () => ({ DialogCustomProvider: () => null }))
  await mock.module("../confirm-action", () => ({
    useConfirmAction: () => async (message: string, options: { isCurrent?: () => boolean }) => {
      confirmations.push(message)
      return confirmAllowed && options.isCurrent?.() !== false
    },
  }))
  await mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => undefined,
    useServerProtocol: () => undefined,
  }))
  await mock.module("@/context/server-sync", () => ({ useServerSync: () => undefined }))
  await mock.module("@/context/language", () => ({ useLanguage: () => undefined }))
  await mock.module("@/hooks/use-providers", () => ({ useProviders: () => undefined }))
  await mock.module("@arforge-ai/ui/dialog", () => ({
    Dialog: (props: { children: solid.JSX.Element }) => props.children,
  }))
  await mock.module("@arforge-ai/ui/context/dialog", () => ({
    useDialog: () => ({
      pushScoped: (body: () => solid.JSX.Element, onClose: () => void) => {
        const host = document.createElement("div")
        dialogHost?.append(host)
        const dispose = web.render(body, host)
        let closed = false
        const close = () => {
          if (closed) return
          closed = true
          dispose()
          host.remove()
          onClose()
        }
        disposals.push(close)
        return { close, discard: close }
      },
    }),
  }))
  await mock.module("@arforge-ai/ui/button", () => ({
    Button: (props: {
      type?: "button" | "submit" | "reset"
      children?: solid.JSX.Element
      disabled?: boolean
      onClick?: () => void
    }) => {
      const button = document.createElement("button")
      button.type = props.type ?? "button"
      solid.createEffect(() => {
        button.disabled = !!props.disabled
        button.textContent = String(props.children ?? "")
      })
      button.onclick = () => props.onClick?.()
      return button
    },
  }))
  await mock.module("@arforge-ai/ui/icon-button", () => ({
    IconButton: (props: { "aria-label": string; title?: string; disabled?: boolean; onClick?: () => void }) => {
      const button = document.createElement("button")
      button.type = "button"
      button.onclick = () => props.onClick?.()
      solid.createEffect(() => {
        button.disabled = !!props.disabled
        button.setAttribute("aria-label", props["aria-label"])
        button.title = props.title ?? ""
      })
      return button
    },
  }))
  await mock.module("@arforge-ai/ui/v2/switch-v2", () => ({
    Switch: (props: {
      children: solid.JSX.Element
      checked: boolean
      disabled?: boolean
      onChange: (checked: boolean) => void
    }) => {
      const button = document.createElement("button")
      button.type = "button"
      button.setAttribute("role", "switch")
      button.onclick = () => props.onChange(!props.checked)
      solid.createEffect(() => {
        button.disabled = !!props.disabled
        button.setAttribute("aria-checked", String(props.checked))
        button.textContent = String(props.children)
      })
      return button
    },
  }))
  await mock.module("@arforge-ai/ui/text-field", () => ({
    TextField: (props: {
      label: string
      value?: string
      type?: string
      readOnly?: boolean
      placeholder?: string
      multiline?: boolean
      onChange?: (value: string) => void
    }) => {
      const label = document.createElement("label"),
        text = document.createElement("span"),
        input = props.multiline ? document.createElement("textarea") : document.createElement("input")
      text.textContent = props.label
      label.append(text, input)
      input.dataset.label = props.label
      if (input instanceof HTMLInputElement) input.type = props.type ?? "text"
      solid.createEffect(() => {
        input.value = props.value ?? ""
        input.readOnly = !!props.readOnly
        input.placeholder = props.placeholder ?? ""
      })
      input.oninput = () => props.onChange?.(input.value)
      return label
    },
  }))
  View = (await import("./provider-workspace")).ProviderWorkspaceSource
})
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  confirmAllowed = true
  confirmations.length = 0
  document.body.replaceChildren()
})
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise<void>((done) => setTimeout(done, 0))
}
function fixture({
  readonly = false,
  hiddenURL = false,
  empty = false,
  capFailures = 0,
  detailFailures = 0,
  capTransportFailures = 0,
  detailTransportFailures = 0,
  holdDetail = false,
} = {}) {
  let snapshot: WorkspaceDetail = {
    providerID: "relay",
    revision: "r1",
    name: "Owned relay",
    baseURL: hiddenURL ? undefined : "https://owned.invalid/v1",
    apiFormat: readonly ? undefined : "openai-chat",
    adapter: { type: "aisdk", package: readonly ? "unsupported-fixture" : "@ai-sdk/openai-compatible" },
    authentication: "required",
    disabled: false,
    canWrite: !readonly,
    credential: { configured: true, reconnectRequired: false, source: "stored" },
    models: [
      {
        id: "wire",
        wireID: "wire",
        name: "Owned model",
        disabled: false,
        canTest: true,
        limit: { context: 8192, input: 6000, output: 1024 },
        capabilities: { tools: true, input: ["text", "image", "future-mode"], output: ["text"] },
        variants: ["off", "low"],
        defaultVariant: "off",
      },
    ],
  }
  const location = {
    directory: "E:/fixtures/workspace",
    project: { id: "fixture-project", directory: "E:/fixtures/workspace" },
  }
  const writes: Parameters<WorkspaceApi["save"]>[0][] = [],
    credentials: unknown[] = []
  let tests = 0,
    accessReads = 0,
    detailReads = 0,
    readRelease: ((failed: boolean) => void) | undefined,
    detailSignal: AbortSignal | undefined,
    finish!: (value: WorkspaceTestResult) => void,
    signal: AbortSignal | undefined
  const api = Arforge.make({
    baseUrl: "http://owned-workspace.invalid",
    fetch: Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init),
          path = new URL(request.url).pathname
        let data: unknown
        const readFailure = () =>
          new Response(
            JSON.stringify({
              _tag: "ServiceUnavailableError",
              message: "owned read fixture failure",
              service: "provider-configuration",
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          )
        if (path.endsWith("/capability")) {
          accessReads++
          if (capTransportFailures-- > 0) throw new TypeError("Failed to fetch: net::ERR_NETWORK_CHANGED")
          if (capFailures > 0) {
            capFailures--
            return readFailure()
          }
          data = {
            canWrite: !readonly,
            reason: readonly ? "host_configuration_readonly" : "host_owner",
            providers: empty
              ? []
              : [
                  { id: "relay", revision: snapshot.revision, disabled: snapshot.disabled, canDisconnect: true },
                  ...(snapshot.providerID === "relay"
                    ? []
                    : [{ id: snapshot.providerID, revision: snapshot.revision, disabled: false, canDisconnect: true }]),
                ],
          }
        } else if (request.method === "GET") {
          detailReads++
          detailSignal = request.signal
          if (detailTransportFailures-- > 0) throw new TypeError("Failed to fetch: net::ERR_NETWORK_CHANGED")
          if (holdDetail) {
            holdDetail = false
            const failed = await new Promise<boolean>((done) => {
              readRelease = done
            })
            if (failed) return readFailure()
          }
          if (detailFailures > 0) {
            detailFailures--
            return readFailure()
          }
          data = snapshot
        } else if (path.endsWith("/test")) {
          tests++
          signal = request.signal
          data = await new Promise<WorkspaceTestResult>((done) => {
            finish = done
          })
        } else if (path.endsWith("/credential")) {
          credentials.push(await request.json())
          data = { providerID: "relay", revision: snapshot.revision, disabled: snapshot.disabled }
        } else {
          const body: Parameters<WorkspaceApi["save"]>[0] = await request.json()
          writes.push(body)
          const models = snapshot.models
            .filter((model) => !body.deletedModelIDs?.includes(model.id))
            .map((model) => {
              const patch = body.models.find((row) => row.id === model.id)
              return patch ? { ...model, ...patch, variants: model.variants } : model
            })
          snapshot = {
            ...snapshot,
            name: body.name,
            baseURL: body.baseURL ?? snapshot.baseURL,
            apiFormat: body.apiFormat ?? snapshot.apiFormat,
            disabled: body.disabled ?? snapshot.disabled,
            models,
            revision: `r${writes.length + 1}`,
          }
          data = { providerID: "relay", revision: snapshot.revision, disabled: snapshot.disabled }
        }
        return new Response(JSON.stringify({ location, data }), { headers: { "content-type": "application/json" } })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  }).providers
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
    host = document.createElement("div")
  document.body.append(host)
  dialogHost = host
  let active = true,
    created = 0
  let onCreated: ((providerID: string) => void) | undefined
  const dispose = web.render(
    () =>
      solid.createComponent(View, {
        api,
        scope: "owned",
        directory: location.directory,
        sync: { queryClient },
        locale: "en",
        isCurrent: () => active,
        onCreate: (callback) => {
          created++
          onCreated = callback
        },
        loadPresets: async () => ({ revision: "fixture", vendors: [], items: [] }),
      }),
    host,
  )
  disposals.push(() => {
    active = false
    dispose()
    queryClient.clear()
    readRelease?.(true)
    if (finish)
      finish({
        providerID: "relay",
        modelID: "wire",
        revision: snapshot.revision,
        outcome: "failure",
        category: "timeout",
        latencyMs: 1,
      })
  })
  const fill = (label: string, value: string) => {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-label="${label}"]`)
    if (!input) throw Error(`Missing ${label}`)
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  const button = (text: string) => {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => (item.getAttribute("aria-label") ?? item.textContent) === text,
    )
    if (!found) throw Error(`Missing button ${text}`)
    return found
  }
  const submit = (selector: string) => {
    const form = host.querySelector(selector)
    if (!form) throw Error("Missing form")
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  }
  return {
    host,
    writes,
    credentials,
    fill,
    button,
    submit,
    get snapshot() {
      return snapshot
    },
    get tests() {
      return tests
    },
    get created() {
      return created
    },
    get signal() {
      return signal
    },
    get detailReads() {
      return detailReads
    },
    get accessReads() {
      return accessReads
    },
    get detailSignal() {
      return detailSignal
    },
    releaseReadFailure: () => readRelease?.(true),
    clearConfiguredProviders: () => {
      empty = true
    },
    completeCreate: (providerID = "relay") => {
      empty = false
      snapshot = { ...snapshot, providerID }
      onCreated?.(providerID)
    },
    failNextRead: (phase: "capability" | "detail") => {
      if (phase === "capability") capFailures++
      else detailFailures++
    },
    failTransportReads: (phase: "capability" | "detail", count: number) => {
      if (phase === "capability") capTransportFailures = count
      else detailTransportFailures = count
    },
    returnToSource: () => {
      active = true
    },
    finish: (category: WorkspaceTestResult["category"] = "ok") =>
      finish({
        providerID: "relay",
        modelID: "wire",
        revision: snapshot.revision,
        outcome: category === "ok" ? "success" : "failure",
        category,
        latencyMs: 7,
      }),
    close: () => {
      active = false
      dispose()
    },
  }
}
test("real workspace edits retain wire ID, blank credential, adapter and advanced metadata", async () => {
  const f = fixture()
  await settle()
  f.button("Add provider").click()
  expect(f.created).toBe(1)
  expect(f.tests).toBe(0)
  expect(f.host.querySelector<HTMLInputElement>('[data-label="API key"]')?.value).toBe("")
  expect(f.host.querySelector<HTMLInputElement>('[data-label="API key"]')?.placeholder).toBe("••••••••")
  f.button("Edit model configuration").click()
  await settle()
  expect(f.host.querySelector<HTMLInputElement>('[data-label="Model ID"]')?.readOnly).toBe(true)
  f.fill("Context capacity (tokens)", "4096")
  f.submit("[data-model-editor]")
  await settle()
  expect(f.writes).toHaveLength(1)
  expect(f.credentials).toHaveLength(0)
  expect(f.writes[0].apiFormat).toBeUndefined()
  expect(f.writes[0].authentication).toBeUndefined()
  expect(f.writes[0].models[0]).toMatchObject({
    id: "wire",
    name: "Owned model",
    limit: { context: 4096, input: 6000, output: 1024 },
    defaultVariant: "off",
  })
  expect(f.writes[0].models[0].variants).toBeUndefined()
  expect(f.snapshot.models[0].capabilities?.input).toContain("future-mode")
})
test("unsaved values require save first; saved test is explicit, cancellable and localized", async () => {
  const f = fixture()
  await settle()
  f.fill("Base URL", "https://changed.invalid/v1")
  f.button("Test Connection").click()
  await settle()
  expect(f.tests).toBe(0)
  expect(f.writes).toHaveLength(0)
  expect(f.host.textContent).toContain("Save changes before testing")
  f.fill("Base URL", "https://owned.invalid/v1")
  f.button("Test Connection").click()
  await settle()
  expect(f.tests).toBe(1)
  expect(f.host.textContent).toContain("Testing saved model")
  f.button("Cancel test").click()
  expect(f.signal?.aborted).toBe(true)
  f.finish()
  await settle()
  expect(f.host.querySelector('[data-model-test-status="done"]')).toBeNull()
  f.button("Test Connection").click()
  await settle()
  f.finish("authentication")
  await settle()
  expect(f.host.textContent).toContain("Authentication failed")
  expect(f.host.textContent).toContain("7 ms")
  expect(f.writes).toHaveLength(0)
})
test("provider/model disable and last-model delete use real revision-bound operations with confirmation", async () => {
  const f = fixture()
  await settle()
  const row = f.host.querySelector('[data-config-model-id="wire"]')!
  const disable = row.querySelector<HTMLButtonElement>('[role="switch"]')!
  disable.click()
  await settle()
  expect(f.writes[0]).toMatchObject({ revision: "r1", models: [{ id: "wire", disabled: true }] })
  expect(f.host.querySelector('[data-config-model-id="wire"]')).not.toBeNull()
  confirmAllowed = false
  f.button("Delete model").click()
  await settle()
  expect(f.writes).toHaveLength(1)
  confirmAllowed = true
  f.button("Delete model").click()
  await settle()
  expect(confirmations.at(-1)).toContain("Owned relay (relay) / Owned model (wire)")
  expect(f.writes[1]).toMatchObject({ models: [], deletedModelIDs: ["wire"], revision: "r2" })
  expect(f.host.querySelector('[data-config-model-id="wire"]')).toBeNull()
})
test("unsupported read-only details expose no effective write/test and detached completion is discarded", async () => {
  const r = fixture({ readonly: true })
  await settle()
  expect(r.button("Test Connection").disabled).toBe(true)
  expect(r.button("Add model").disabled).toBe(true)
  expect(r.host.textContent).toContain("read-only")
  expect(r.tests).toBe(0)
  const f = fixture()
  await settle()
  f.button("Test Connection").click()
  await settle()
  f.close()
  expect(f.signal?.aborted).toBe(true)
  f.finish()
  await settle()
  expect(f.host.querySelector('[data-model-test-status="done"]')).toBeNull()
})

test("real editor resets edits to the captured default and sends explicit null when model/provider default is chosen", async () => {
  const f = fixture()
  await settle()
  f.button("Edit model configuration").click()
  await settle()
  f.fill("Maximum output (tokens)", "77")
  let select = f.host.querySelector<HTMLSelectElement>('select[aria-label="Default reasoning variant"]')!
  select.value = "model-default"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  f.button("Reset form").click()
  await settle()
  expect(f.host.querySelector<HTMLInputElement>('[data-label="Maximum output (tokens)"]')?.value).toBe("1024")
  f.fill("Context capacity (tokens)", "4096")
  f.submit("[data-model-editor]")
  await settle()
  expect(f.writes[0].models[0]).toMatchObject({ defaultVariant: "off", limit: { context: 4096, output: 1024 } })
  f.button("Edit model configuration").click()
  await settle()
  select = f.host.querySelector<HTMLSelectElement>('select[aria-label="Default reasoning variant"]')!
  select.value = "model-default"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  f.submit("[data-model-editor]")
  await settle()
  expect(f.writes[1].models[0].defaultVariant).toBeNull()
})

test("cancel restores the still-current origin control and detached callbacks cannot focus a replacement", async () => {
  const f = fixture()
  await settle()
  const origin = f.button("Edit model configuration")
  origin.focus()
  origin.click()
  await settle()
  const field = f.host.querySelector<HTMLInputElement>('[data-label="Context capacity (tokens)"]')!
  field.focus()
  f.button("Cancel").click()
  await settle()
  expect(document.activeElement).toBe(origin)
  origin.focus()
  origin.click()
  await settle()
  f.close()
  await settle()
  expect(document.activeElement).not.toBe(origin)
  expect(f.host.querySelector("[data-model-editor]")).toBeNull()
})

test("a hidden saved endpoint is preserved by model edits; real API format edits do not read or replace its key", async () => {
  const f = fixture({ hiddenURL: true })
  await settle()
  expect(f.host.querySelector<HTMLInputElement>('[data-label="Base URL"]')?.value).toBe("")
  f.button("Edit model configuration").click()
  await settle()
  f.fill("Maximum output (tokens)", "512")
  f.submit("[data-model-editor]")
  await settle()
  expect(f.writes[0].baseURL).toBeUndefined()
  expect(f.writes[0].authentication).toBeUndefined()
  const format = f.host.querySelector<HTMLSelectElement>('select[aria-label="API format"]')!
  format.value = "openai-responses"
  format.dispatchEvent(new Event("change", { bubbles: true }))
  f.submit(".arforge-provider-connection-editor")
  await settle()
  expect(f.writes[1]).toMatchObject({ apiFormat: "openai-responses", models: [] })
  expect(f.writes[1].baseURL).toBeUndefined()
  expect(f.credentials).toHaveLength(0)
  expect(f.tests).toBe(0)
})

test("a writable empty workspace offers Add provider without a false readonly message", async () => {
  const f = fixture({ empty: true })
  await settle()
  expect(f.host.textContent).toContain("No configured providers")
  expect(f.host.textContent).not.toContain("read-only")
  expect(f.button("Add provider").disabled).toBe(false)
  f.button("Add provider").click()
  expect(f.created).toBe(1)
  expect(f.detailReads).toBe(0)
})

for (const empty of [true, false])
  test(`successful create refreshes and selects its saved provider without manual refresh (empty=${empty})`, async () => {
    const f = fixture({ empty })
    await settle()
    const reads = f.accessReads
    f.button("Add provider").click()
    await settle()
    // Opening or cancelling the form alone must not claim a successful creation.
    expect(f.accessReads).toBe(reads)
    f.completeCreate("new-relay")
    await settle()
    expect(f.accessReads).toBe(reads + 1)
    expect(f.host.querySelector('[data-provider-config-id="new-relay"]')?.getAttribute("aria-current")).toBe("page")
    expect(f.host.querySelector('[data-provider-editor="new-relay"]')).not.toBeNull()
    expect(f.host.textContent).not.toContain("No configured providers")
    expect(f.writes).toHaveLength(0)
    expect(f.credentials).toHaveLength(0)
    expect(f.tests).toBe(0)
  })

for (const phase of ["capability", "detail"] as const)
  test(`successful creation retains a retryable ${phase} read error without resaving or testing`, async () => {
    const f = fixture({ empty: true })
    await settle()
    f.button("Add provider").click()
    f.failNextRead(phase)
    f.completeCreate()
    await settle()
    expect(f.host.textContent).toContain("Could not read provider configuration")
    expect(f.host.textContent).not.toContain("read-only")
    f.button("Retry configuration read").click()
    await settle()
    expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
    expect(f.writes).toHaveLength(0)
    expect(f.credentials).toHaveLength(0)
    expect(f.tests).toBe(0)
  })

test("a retired create callback cannot refresh a replacement or regain ownership after returning to the same source", async () => {
  const old = fixture({ empty: true })
  await settle()
  old.button("Add provider").click()
  const reads = old.accessReads
  old.close()
  const replacement = fixture({ empty: true })
  await settle()
  old.returnToSource()
  old.completeCreate()
  await settle()
  expect(old.accessReads).toBe(reads)
  expect(replacement.accessReads).toBe(1)
  expect(replacement.detailReads).toBe(0)
  expect(replacement.host.textContent).toContain("No configured providers")
})

test("post-create transient capability failures recover the saved provider without repeating its mutation", async () => {
  const f = fixture({ empty: true })
  await settle()
  f.button("Add provider").click()
  f.failTransportReads("capability", 2)
  f.completeCreate("new-relay")
  await new Promise((done) => setTimeout(done, 700))
  await settle()
  expect(f.host.querySelector('[data-provider-editor="new-relay"]')).not.toBeNull()
  expect(f.accessReads).toBe(4)
  expect(f.host.textContent).not.toContain("Could not read provider configuration")
  expect(f.writes).toHaveLength(0)
  expect(f.credentials).toHaveLength(0)
  expect(f.tests).toBe(0)
})

test("transient detail failures recover only the current read", async () => {
  const f = fixture({ detailTransportFailures: 2 })
  await new Promise((done) => setTimeout(done, 700))
  await settle()
  expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
  expect(f.detailReads).toBe(3)
  expect(f.writes).toHaveLength(0)
  expect(f.tests).toBe(0)
})

test("persistent transport failure stops after three reads and remains explicitly retryable", async () => {
  const f = fixture({ capTransportFailures: 3 })
  await new Promise((done) => setTimeout(done, 700))
  await settle()
  expect(f.accessReads).toBe(3)
  expect(f.host.textContent).toContain("Could not read provider configuration")
  f.button("Retry configuration read").click()
  await settle()
  expect(f.accessReads).toBe(4)
  expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
  expect(f.writes).toHaveLength(0)
  expect(f.tests).toBe(0)
})

for (const phase of ["capability", "detail"] as const)
  test(`retiring the workspace stops a ${phase} transport retry during backoff`, async () => {
    const f = fixture(phase === "capability" ? { capTransportFailures: 2 } : { detailTransportFailures: 2 })
    // Observe the first request before the real 100ms backoff expires.
    for (let i = 0; i < 4 && (phase === "capability" ? f.accessReads : f.detailReads) === 0; i++)
      await new Promise((done) => setTimeout(done, 0))
    expect(phase === "capability" ? f.accessReads : f.detailReads).toBe(1)
    f.close()
    await new Promise((done) => setTimeout(done, 400))
    expect(phase === "capability" ? f.accessReads : f.detailReads).toBe(1)
    expect(f.host.querySelector("[data-provider-editor]")).toBeNull()
    expect(f.writes).toHaveLength(0)
  })

test("retry after a failed post-create capability read selects new B instead of previously selected A", async () => {
  const f = fixture()
  await settle()
  expect(f.host.querySelector('[data-provider-config-id="relay"]')?.getAttribute("aria-current")).toBe("page")
  f.button("Add provider").click()
  f.failNextRead("capability")
  f.completeCreate("new-relay")
  await settle()
  expect(f.host.textContent).toContain("Could not read provider configuration")
  f.button("Retry configuration read").click()
  await settle()
  expect(f.host.querySelector('[data-provider-config-id="new-relay"]')?.getAttribute("aria-current")).toBe("page")
  expect(f.host.querySelector('[data-provider-editor="new-relay"]')).not.toBeNull()
  expect(f.writes).toHaveLength(0)
  expect(f.credentials).toHaveLength(0)
  expect(f.tests).toBe(0)
})

for (const phase of ["capability", "detail"] as const)
  test(`${phase} read failure is retryable and never mislabeled as permission denial`, async () => {
    const f = fixture(phase === "capability" ? { capFailures: 1 } : { detailFailures: 1 })
    await settle()
    expect(f.host.textContent).toContain("Could not read provider configuration")
    expect(f.host.textContent).not.toContain("read-only")
    f.button("Retry configuration read").click()
    await settle()
    expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
    expect(f.host.textContent).not.toContain("Could not read provider configuration")
    expect(f.tests).toBe(0)
    expect(f.writes).toHaveLength(0)
  })

test("a failed retired same-provider read cannot overwrite the current successful read", async () => {
  const f = fixture({ holdDetail: true })
  await settle()
  const oldSignal = f.detailSignal
  f.host.querySelector<HTMLButtonElement>('[data-provider-config-id="relay"]')!.click()
  await settle()
  expect(oldSignal?.aborted).toBe(true)
  expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
  f.releaseReadFailure()
  await settle()
  expect(f.host.querySelector('[data-provider-editor="relay"]')).not.toBeNull()
  expect(f.host.textContent).not.toContain("Could not read provider configuration")
  expect(f.host.textContent).not.toContain("read-only")
})

test("retry retires a failed provider detail when fresh capability confirms an empty writable source", async () => {
  const f = fixture({ detailFailures: 1 })
  await settle()
  expect(f.host.textContent).toContain("Could not read provider configuration")
  expect(f.detailReads).toBe(1)
  f.clearConfiguredProviders()
  f.button("Retry configuration read").click()
  await settle()
  expect(f.host.textContent).toContain("No configured providers")
  expect(f.host.textContent).not.toContain("Could not read provider configuration")
  expect(f.host.textContent).not.toContain("Retry configuration read")
  expect(f.host.textContent).not.toContain("read-only")
  expect(f.host.querySelector("[data-provider-editor]")).toBeNull()
  expect(f.detailReads).toBe(1)
  expect(f.button("Add provider").disabled).toBe(false)
  f.button("Add provider").click()
  expect(f.created).toBe(1)
  expect(f.tests).toBe(0)
  expect(f.writes).toHaveLength(0)
})
