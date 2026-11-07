// Run this fixture explicitly with --isolate; its external-service mocks must
// not be installed in the shared, non-isolated test:browser suite.
import { afterEach, beforeAll, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createEffect, createRoot, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { insert, render } from "solid-js/web"

let Toolbar: typeof import("@/components/control-center/management-action-toolbar").ManagementActionToolbar
let Artifacts: typeof import("@/components/control-center/artifact-evidence-workbench").ArtifactEvidenceWorkbench
let Providers: typeof import("@/components/settings-v2/providers").SettingsProvidersV2
let SearchProvider: typeof import("@/components/settings-v2/settings-search").SettingsSearchProvider
let Search: typeof import("@/components/settings-v2/settings-search").SettingsLocalSearch
let Row: typeof import("@/components/settings-v2/parts/row").SettingsRowV2
let useSourceNavigation: typeof import("@/components/control-center/management-source-navigation").useManagementSessionNavigation
let Mcp: typeof import("@/components/control-center/mcp-management").McpManagement
let Collection: typeof import("@/components/control-center/management-collection").ManagementCollection
let Tasks: typeof import("@/components/control-center/management-tasks").ManagementTasks
let Views: typeof import("@/components/control-center/management-views").ManagementViews
const navigationAdds: { server: string; sessionId: string }[] = []
const navigationSelections: string[] = []
const disposals: (() => void)[] = []
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))
let authRemoves = 0
let removedProvider = ""

function wrapper(props: { children?: JSX.Element }) {
  const element = document.createElement("div")
  insert(element, () => props.children)
  return element
}
function button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
  const element = document.createElement("button")
  Object.defineProperty(element, "disabled", { get: () => !!props.disabled, configurable: true })
  element.addEventListener("click", event => {
    if (!props.disabled && typeof props.onClick === "function") props.onClick(event as MouseEvent & { currentTarget: HTMLButtonElement; target: Element })
  })
  insert(element, () => props.children)
  return element
}
const [provider, setProvider] = createStore({
  id: "fixture-provider", name: "Fixture provider", source: "api",
  models: Object.fromEntries(Array.from({ length: 15 }, (_, index) => {
    const id = `model-${index + 1}`
    return [id, { id, name: `Model ${index + 1}` }]
  })),
})
const sdk = {
  url: "https://fixture.invalid",
  scope: "fixture-A",
  server: { type: "http", http: { url: "https://fixture.invalid" } },
  client: { auth: { remove: async ({ providerID }: { providerID: string }) => { authRemoves++; removedProvider = providerID } }, global: { dispose: async () => undefined } },
}
let activeSDK = sdk
const sync = { data: { config: {} }, set: () => undefined, updateConfig: async () => undefined }
let activeSync: unknown = sync

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solid = require("babel-preset-solid")
  await plugin({ name: "systems-management-solid-dom", setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/](app|ui)[\\/]src[\\/].*\.tsx$/ }, async ({ path }) => {
      const result = babel.transformSync(await Bun.file(path).text(), {
        filename: path, configFile: false, babelrc: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solid.default ?? solid, { generate: "dom" }]],
      })
      if (!result?.code) throw new Error(`Solid compilation failed: ${path}`)
      return { contents: result.code, loader: "ts" }
    })
  } })
  mock.module("@/context/language", () => ({ useLanguage: () => ({
    locale: () => "en", intl: () => "en", t: (key: string) => key,
  }) }))
  mock.module("@arforge-ai/ui/button", () => ({ Button: button }))
  mock.module("@arforge-ai/ui/provider-icon", () => ({ ProviderIcon: () => document.createElement("span") }))
  mock.module("@arforge-ai/ui/v2/badge-v2", () => ({ Tag: wrapper }))
  mock.module("@arforge-ai/ui/context/dialog", () => ({ useDialog: () => ({
    show: () => undefined,
    pushScoped: (view: () => JSX.Element) => {
      const host = document.createElement("div")
      document.body.append(host)
      const dispose = render(view, host)
      let closed = false
      const close = () => { if (closed) return; closed = true; dispose(); host.remove() }
      disposals.push(close)
      return { close, discard: close }
    },
  }) }))
  mock.module("@arforge-ai/ui/v2/dialog-v2", () => ({
    DialogV2: wrapper, DialogHeader: wrapper, DialogTitle: wrapper, DialogBody: wrapper, DialogFooter: wrapper,
  }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => activeSDK, useServerProtocol: () => () => "v1" }))
  mock.module("@/context/tabs", () => ({ useTabs: () => ({
    addSessionTab: (input: { server: string; sessionId: string }) => { navigationAdds.push(input); return "source-tab" },
    select: (id: string) => navigationSelections.push(id),
  }) }))
  mock.module("@/context/server-sync", () => ({ useServerSync: () => () => activeSync }))
  mock.module("@/hooks/use-providers", () => ({ popularProviders: [], useProviders: () => ({ connected: () => [provider], popular: () => [] }) }))
  mock.module("@/components/dialog-connect-provider", () => ({ DialogConnectProvider: wrapper, useProviderConnectController: () => ({ select: () => undefined }) }))
  mock.module("@/components/dialog-custom-provider", () => ({ DialogCustomProvider: wrapper }))
  mock.module("@/utils/toast", () => ({ showToast: () => undefined }))
  Toolbar = (await import("@/components/control-center/management-action-toolbar")).ManagementActionToolbar
  Artifacts = (await import("@/components/control-center/artifact-evidence-workbench")).ArtifactEvidenceWorkbench
  Providers = (await import("@/components/settings-v2/providers")).SettingsProvidersV2
  const search = await import("@/components/settings-v2/settings-search")
  SearchProvider = search.SettingsSearchProvider
  Search = search.SettingsLocalSearch
  Row = (await import("@/components/settings-v2/parts/row")).SettingsRowV2
  useSourceNavigation = (await import("@/components/control-center/management-source-navigation")).useManagementSessionNavigation
  Collection = (await import("@/components/control-center/management-collection")).ManagementCollection
  Mcp = (await import("@/components/control-center/mcp-management")).McpManagement
  Tasks = (await import("@/components/control-center/management-tasks")).ManagementTasks
  Views = (await import("@/components/control-center/management-views")).ManagementViews
})
afterEach(() => {
  disposals.splice(0).forEach(dispose => dispose()); document.body.replaceChildren()
  activeSDK = sdk; activeSync = sync; navigationAdds.splice(0); navigationSelections.splice(0)
})

function mount(view: () => JSX.Element) {
  const host = document.createElement("div")
  document.body.append(host)
  disposals.push(render(view, host))
  return host
}
function findButton(host: ParentNode, text: string) {
  const found = [...host.querySelectorAll("button")].find(item => item.textContent?.includes(text))
  if (!found) throw new Error(`Button missing: ${text}`)
  return found
}

test("secondary menu keeps primary, disabled/busy semantics, danger grouping and Escape focus return", async () => {
  let calls = 0
  const [state, setState] = createStore({ busy: false })
  const primary = document.createElement("button")
  primary.textContent = "Primary"
  const host = mount(() => createComponent(Toolbar, {
    primary,
    get actions() { return [
      { id: "danger", label: "Remove", danger: true, run: () => calls++ },
      { id: "read", label: "Read", run: () => calls++ },
      { id: "busy", label: "Working", busy: state.busy, run: () => calls++ },
      { id: "blocked", label: "Blocked", disabled: true, run: () => calls++ },
    ] },
    disabledReason: "This source is read-only",
  }))
  expect(host.contains(primary)).toBe(true)
  expect([...host.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Primary", "More actions"])
  const trigger = findButton(host, "More actions")
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("This source is read-only")
  trigger.focus()
  trigger.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", button: 0, bubbles: true }))
  await settle()
  const menu = document.querySelector<HTMLElement>("[data-management-action-menu]")!
  expect(menu).not.toBeNull()
  // CSS imports are not applied by HappyDOM. Give Presence the explicit
  // no-animation value a browser exposes under reduced motion.
  menu.style.animationName = "none"
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items().map(item => item.textContent)).toEqual(["Read", "Working", "Blocked", "Remove"])
  expect(menu.querySelector('hr[data-slot="menu-v2-separator"]')).not.toBeNull()
  setState("busy", true)
  expect(trigger.getAttribute("aria-busy")).toBe("true")
  expect(items()[1].getAttribute("aria-disabled")).toBe("true")
  expect(items()[1].getAttribute("aria-busy")).toBe("true")
  expect(items()[2].getAttribute("aria-disabled")).toBe("true")
  for (const item of [items()[1], items()[2]]) {
    item.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse", button: 0, bubbles: true }))
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  }
  expect(calls).toBe(0)
  items()[0].focus()
  items()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(trigger.getAttribute("aria-expanded")).toBe("false")
  expect(document.activeElement === trigger).toBe(true)
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  await settle()
  const reopened = document.querySelector<HTMLElement>("[data-management-action-menu]")!
  expect(reopened !== null).toBe(true)
  reopened.style.animationName = "none"
  reopened.querySelector<HTMLElement>('[role="menuitem"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  await settle()
  expect(calls).toBe(1)
  expect(host.contains(primary)).toBe(true)
})

function artifactResult(label: string) {
  return {
    entries: Array.from({ length: 18 }, (_, index) => ({
      reference: { artifactID: `${label}-${index + 1}`, label: `${label} receipt ${index + 1}`, kind: "text", digest: "fixture-digest", sizeBytes: 123, retention: { mode: "session" }, createdAt: 1 },
      readCount: 0,
    })), headSequence: 18, headHash: "fixture-hash", droppedAuditEntries: 0,
  }
}
function auditResult(label: string) {
  return Array.from({ length: 18 }, (_, index) => ({
    sequence: index + 1, previousHash: index ? `hash-${index}` : "genesis", recordHash: `hash-${index + 1}`,
    artifactID: `${label}-${index + 1}`, action: "registered", actor: "fixture", recordedAt: 1,
  }))
}
test("all already-read receipts and audits remain reachable; refresh failure retains content and retry only reads", async () => {
  let catalogCalls = 0, auditCalls = 0
  let respond: (value: ReturnType<typeof artifactResult>) => void
  let fail = false
  const api = { artifacts: {
    catalog: () => { catalogCalls++; return fail ? Promise.reject(new Error("Fixture read failed")) : new Promise(resolve => { respond = resolve }) },
    audit: () => { auditCalls++; return Promise.resolve(auditResult("current")) },
  } } as unknown as ReturnType<Parameters<typeof Artifacts>[0]["api"]>
  const host = mount(() => createComponent(Artifacts, { api: () => api, ready: () => true, sessionID: "fixture-session" }))
  await settle()
  expect(host.querySelector(".arforge-management-skeleton")).not.toBeNull()
  respond!(artifactResult("current"))
  await settle()
  expect(host.querySelectorAll('[data-testid="artifact-evidence-entry"]').length).toBe(18)
  expect(host.querySelectorAll('[data-testid="artifact-evidence-audit"]').length).toBe(18)
  expect(host.textContent).toContain("current receipt 18")
  fail = true
  findButton(host, "Refresh").click()
  await settle()
  expect(host.querySelectorAll('[data-testid="artifact-evidence-entry"]').length).toBe(18)
  expect(host.querySelector('[data-state="partial"]')).not.toBeNull()
  expect(host.textContent).toContain("Fixture read failed")
  const before = [catalogCalls, auditCalls]
  findButton(host, "Retry read").click()
  await settle()
  expect([catalogCalls, auditCalls]).toEqual(before.map(value => value + 1))
})

test("a late artifact response cannot replace a newly selected session", async () => {
  const responses = new Map<string, (value: ReturnType<typeof artifactResult>) => void>()
  const [state, setState] = createStore({ sessionID: "old" })
  const api = { artifacts: {
    catalog: ({ sessionID }: { sessionID: string }) => new Promise(resolve => responses.set(sessionID, resolve)),
    audit: ({ sessionID }: { sessionID: string }) => Promise.resolve(auditResult(sessionID)),
  } } as unknown as ReturnType<Parameters<typeof Artifacts>[0]["api"]>
  const host = mount(() => createComponent(Artifacts, { api: () => api, ready: () => true, get sessionID() { return state.sessionID } }))
  await settle()
  setState("sessionID", "new")
  await settle()
  expect(responses.has("old")).toBe(true)
  expect(responses.has("new")).toBe(true)
  responses.get("new")!(artifactResult("new"))
  await settle()
  responses.get("old")!(artifactResult("old"))
  await settle()
  expect(host.textContent).toContain("new receipt 18")
  expect(host.textContent).not.toContain("old receipt")
})

test("provider impact is counted, collapsed and complete without burying the consequence or cancellation", async () => {
  const host = mount(() => createComponent(Providers, {}))
  findButton(host, "View details").click()
  await settle()
  findButton(host, "common.disconnect").click()
  await settle()
  const details = document.querySelector<HTMLDetailsElement>(".confirm-action-details")!
  expect(details !== null).toBe(true)
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Affected models: 15")
  expect(details.querySelectorAll("dt").length).toBe(15)
  expect(details.textContent).toContain("Model 15")
  expect(details.textContent).toContain("model-15")
  const consequence = details.previousElementSibling?.textContent ?? ""
  expect(consequence).toContain("Fixture provider · fixture-provider")
  expect(consequence).toContain("Source: https://fixture.invalid")
  expect(consequence).toContain("Affected models: 15")
  expect(consequence).toContain("Reconnect to use this provider again")
  expect(consequence).not.toContain("Model 15")
  findButton(document, "Cancel").click()
  await settle()
  expect(authRemoves).toBe(0)
})

test.each(["id", "name"] as const)("a changed model %s invalidates the captured provider impact before confirmation", async field => {
  const host = mount(() => createComponent(Providers, {}))
  findButton(host, "View details").click()
  await settle()
  findButton(host, "common.disconnect").click()
  await settle()
  const details = document.querySelector<HTMLDetailsElement>(".confirm-action-details")!
  expect(details !== null).toBe(true)
  const confirm = findButton(document, "Confirm")
  const before = provider.models["model-15"][field]
  setProvider("models", "model-15", field, `changed-${field}`)
  await settle()
  expect(document.querySelector(".confirm-action-details") === null).toBe(true)
  // Even a previously captured button cannot authorize the stale impact list.
  confirm.click()
  await settle()
  expect(authRemoves).toBe(0)
  setProvider("models", "model-15", field, before)
})

test("an unchanged model catalog can still confirm the original provider disconnect", async () => {
  const host = mount(() => createComponent(Providers, {}))
  findButton(host, "View details").click()
  await settle()
  findButton(host, "common.disconnect").click()
  await settle()
  findButton(document, "Confirm").click()
  await settle()
  expect(authRemoves).toBe(1)
  expect(removedProvider).toBe("fixture-provider")
})

test("receipt 18 selects exact metadata and related audit; clearing search preserves the selected object", async () => {
  const api = { artifacts: { catalog: async () => artifactResult("current"), audit: async () => auditResult("current") } } as unknown as ReturnType<Parameters<typeof Artifacts>[0]["api"]>
  const host = mount(() => createComponent(Artifacts, { api: () => api, ready: () => true, sessionID: "source-session" }))
  await settle()
  findButton(host, "current receipt 18").click()
  await settle()
  const detail = () => host.querySelector('[data-testid="artifact-evidence-detail"]')!
  expect(detail() !== null).toBe(true)
  expect(detail().textContent).toContain("current-18")
  expect(detail().textContent).toContain("source-session")
  expect(detail().textContent).toContain("#18 · Registered")
  expect(detail().textContent).not.toContain("#17 · Registered")
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
  input.value = "receipt 1"
  input.dispatchEvent(new Event("input", { bubbles: true }))
  expect(detail().textContent).toContain("current-18")
  findButton(host, "Clear search").click()
  expect(host.querySelectorAll('[data-testid="artifact-evidence-entry"]').length).toBe(18)
  expect(detail().textContent).toContain("current-18")
  findButton(host, "current receipt 1").click()
  await settle()
  expect(detail().textContent).toContain("current-1")
  expect(detail().textContent).not.toContain("#18 · Registered")
})

test("settings search indexes public labels only and preserves controls, drafts and IME", async () => {
  const [state, setState] = createStore({ title: "Language preference" })
  const control = document.createElement("input")
  control.value = "fixture-private-value"
  let changes = 0
  control.addEventListener("change", () => changes++)
  const host = mount(() => createComponent(SearchProvider, { get children() { return [
    createComponent(Search, {}),
    createComponent(Row, { get title() { return state.title }, description: "Choose the interface language", children: control }),
  ] } }))
  await settle()
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!
  const query = (value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })) }
  query("fixture-private-value")
  expect(host.querySelector(".settings-local-search-results")?.textContent).toContain("No matching settings")
  expect(control.isConnected).toBe(true)
  expect(control.value).toBe("fixture-private-value")
  query("language")
  expect(host.querySelector(".settings-local-search-results")?.textContent).toContain("Language preference")
  input.focus()
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }))
  expect(document.activeElement === input).toBe(true)
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  expect(document.activeElement === control).toBe(true)
  expect(changes).toBe(0)
  expect(control.value).toBe("fixture-private-value")
  setState("title", "Locale preference")
  query("locale")
  expect(host.querySelector(".settings-local-search-results")?.textContent).toContain("Locale preference")
  findButton(host, "Clear search").click()
  expect(host.querySelector(".settings-local-search-results") === null).toBe(true)
  expect(control.isConnected).toBe(true)
})

function sourceNavigation(get: (input: { sessionID: string }) => Promise<unknown>) {
  const api = { sessions: { get } } as unknown as ReturnType<Parameters<typeof useSourceNavigation>[0]>
  return createRoot(dispose => { disposals.push(dispose); return useSourceNavigation(() => api) })
}
test("source navigation uses the inspected server and Session through the existing tab owner", async () => {
  const reads: string[] = []
  const open = sourceNavigation(async ({ sessionID }) => {
    reads.push(sessionID)
    return { id: sessionID, location: { directory: "E:/fixture", workspaceID: "workspace" } }
  })
  expect(await open("target", { directory: "E:/fixture", workspace: "workspace" }, () => true)).toBe(true)
  expect(reads).toEqual(["target"])
  expect(navigationAdds.map(item => item.sessionId)).toEqual(["target"])
  expect(navigationAdds[0].server).toContain("fixture.invalid")
  expect(navigationSelections).toEqual(["source-tab"])
})
test("source navigation rejects wrong directory and late responses after server change", async () => {
  const wrong = sourceNavigation(async () => ({ id: "target", location: { directory: "E:/other" } }))
  await expect(wrong("target", { directory: "E:/fixture" }, () => true)).rejects.toThrow("no longer belongs")
  expect(navigationSelections.length).toBe(0)
  let respond: (value: unknown) => void
  const late = sourceNavigation(() => new Promise(resolve => { respond = resolve }))
  const pending = late("target", { directory: "E:/fixture" }, () => true)
  activeSDK = { ...sdk, url: "https://other.invalid" }
  respond!({ id: "target", location: { directory: "E:/fixture" } })
  expect(await pending).toBe(false)
  expect(navigationAdds.length).toBe(0)
  expect(navigationSelections.length).toBe(0)
})

test("all 101 read objects are reachable through bounded pages without changing selected detail", async () => {
  const items = Array.from({ length: 101 }, (_, id) => ({ id: String(id), name: `Entity ${id}` }))
  const host = mount(() => createComponent(Collection<{ id: string; name: string }>, {
    label: "Entities", scope: "fixture", items, identity: item => item.id, title: item => item.name,
    children: (item, index) => { const text = document.createElement("p"); text.dataset.testid = "entity-detail"; text.dataset.index = String(index()); text.textContent = item.name; return text },
  }))
  expect(host.querySelectorAll(".arforge-management-entity-select").length).toBe(50)
  findButton(host, "Next page").click()
  expect(host.querySelectorAll(".arforge-management-entity-select").length).toBe(50)
  findButton(host, "Next page").click()
  expect(host.querySelectorAll(".arforge-management-entity-select").length).toBe(1)
  findButton(host, "Entity 100").click()
  expect(host.querySelector('[data-testid="entity-detail"]')?.textContent).toBe("Entity 100")
  expect(host.querySelector('[data-testid="entity-detail"]')?.getAttribute("data-index")).toBe("100")
  findButton(host, "Previous page").click()
  expect(host.querySelector('[data-testid="entity-detail"]')?.textContent).toBe("Entity 100")
})

function mcpOwner(source: string, toggle?: () => Promise<void>) {
  const [cache, setCache] = createStore({ mcp: { [`MCP ${source}`]: { status: "disabled" } } })
  const calls: { source: string; directory: string; name: string }[] = []
  const queries: unknown[] = []
  const directories = new Map<string, object>()
  return { calls, queries, owner: {
    ensureDirSyncContext: (directory: string) => {
      if (!directories.has(directory)) directories.set(directory, { data: cache, mcp: { toggle: async (name: string) => {
        calls.push({ source, directory, name }); await toggle?.(); setCache("mcp", name, "status", "connected")
      } } })
      return directories.get(directory)
    },
    queryOptions: { mcp: (path: string) => ({ queryKey: [source, path, "mcp"] }) },
    queryClient: { fetchQuery: async (options: unknown) => { queries.push(options); return cache.mcp } },
  } }
}
test("MCP metadata failure is actually hit; connection action still uses its exact existing directory owner", async () => {
  const owned = mcpOwner("A")
  activeSync = owned.owner
  let resourceHits = 0, capabilityHits = 0
  const api = { mcp: {
    resourceCatalog: async () => { resourceHits++; throw new Error("Fixture resource fault") },
    capabilities: async () => { capabilityHits++; return { data: [] } },
  } } as unknown as ReturnType<Parameters<typeof Mcp>[0]["api"]>
  const host = mount(() => createComponent(Mcp, { api: () => api, location: () => ({ location: { directory: "E:\\fixture\\A\\" } }), ready: () => true }))
  await settle()
  expect(resourceHits).toBe(1)
  expect(capabilityHits).toBe(1)
  expect(host.textContent).toContain("Fixture resource fault")
  expect(owned.queries.length).toBe(1)
  expect((owned.queries[0] as { queryKey: string[] }).queryKey[1]).toBe("E:/fixture/A")
  findButton(host, "MCP A").click()
  await settle()
  const connect = findButton(host, "Connect")
  expect(connect.disabled).toBe(false)
  connect.click()
  await settle()
  expect(owned.calls).toEqual([{ source: "A", directory: "E:\\fixture\\A\\", name: "MCP A" }])
  expect(resourceHits).toBe(2)
  expect(host.textContent).toContain("The connection operation returned")
  expect(host.textContent).toContain("Fixture resource fault")
})

test("late MCP connection receipt cannot appear in the new source", async () => {
  let release: () => void
  const old = mcpOwner("A", () => new Promise(resolve => { release = resolve }))
  const next = mcpOwner("B")
  const [state, setState] = createStore({ key: "A" })
  activeSync = old.owner
  const api = { mcp: { resourceCatalog: async () => ({ data: { resources: [], templates: [] } }), capabilities: async () => ({ data: [] }) } } as unknown as ReturnType<Parameters<typeof Mcp>[0]["api"]>
  const host = mount(() => createComponent(Mcp, { api: () => api, location: () => ({ location: { directory: `E:/fixture/${state.key}` } }), ready: () => true }))
  await settle()
  findButton(host, "MCP A").click()
  await settle()
  findButton(host, "Connect").click()
  await settle()
  expect(old.calls.length).toBe(1)
  activeSync = next.owner
  activeSDK = { ...sdk, scope: "fixture-B", url: "https://B.fixture.invalid" }
  setState("key", "B")
  await settle()
  release!()
  await settle()
  expect(host.textContent).toContain("MCP B")
  expect(host.textContent).not.toContain("The connection operation returned")
  expect(next.calls.length).toBe(0)
})

test("task detail metadata updates do not recreate an active input and switching tasks keeps its controlled draft", async () => {
  const [state, setState] = createStore({ draft: "", metadata: 0 })
  let input: HTMLInputElement
  const tasks = [{ id: "edit", title: () => "Edit task", description: () => `Read ${state.metadata}`, render: () => {
    input = document.createElement("input")
    createEffect(() => { input.value = state.draft })
    input.addEventListener("input", event => setState({ draft: (event.currentTarget as HTMLInputElement).value, metadata: state.metadata + 1 }))
    return input
  } }, { id: "other", title: () => "Other task", description: () => "Read-only task", render: () => document.createElement("span") }]
  const host = mount(() => createComponent(Tasks, { label: "Tasks", scope: "fixture", tasks }))
  findButton(host, "Edit task").click()
  const original = input!
  original.focus()
  original.value = "kept draft"
  original.dispatchEvent(new Event("input", { bubbles: true }))
  expect(input! === original).toBe(true)
  expect(document.activeElement === original).toBe(true)
  findButton(host, "Other task").click()
  findButton(host, "Edit task").click()
  expect(input!.value).toBe("kept draft")
  expect(state.metadata).toBe(1)
})

test("category views keep their original owners mounted and restore the same draft control", async () => {
  let owners = 0
  const fields = new Map<string, HTMLInputElement>()
  const view = (id: string) => ({ id, label: () => `Group ${id}`, render: () => {
    owners++
    const input = document.createElement("input")
    fields.set(id, input)
    return input
  } })
  const descriptors = [view("A"), view("B")]
  const host = mount(() => createComponent(Views, { label: "Groups", views: descriptors }))
  await settle()
  expect(owners).toBe(2)
  const field = fields.get("A")!
  field.value = "retained"
  findButton(host, "Group B").click()
  await settle()
  expect(field.isConnected).toBe(true)
  expect(field.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(true)
  findButton(host, "Group A").click()
  await settle()
  expect(field.closest<HTMLElement>('[role="tabpanel"]')?.hidden).toBe(false)
  expect(field.value).toBe("retained")
  expect(owners).toBe(2)
})
