import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { plugin } from "bun"
import { createRequire } from "node:module"
import { createComponent, createEffect, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { insert, render } from "solid-js/web"
import type { ModelSelection } from "@/context/local"
import type { ModelSelectionBinding } from "@/components/dialog-select-model"
import { ModelChoiceError } from "@/components/dialog-select-model-state"

type Choice = { providerID: string; modelID: string }
type WrapperProps = { children?: JSX.Element; action?: JSX.Element }
const alpha: Choice = { providerID: "p", modelID: "alpha" }
const beta: Choice = { providerID: "p", modelID: "beta" }
const disposals: (() => void)[] = []
let Unpaid: typeof import("@/components/dialog-select-model-unpaid-v2")
let Paid: typeof import("@/components/dialog-select-model")
let fixture: ReturnType<typeof makeFixture>
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function wrapper(props: WrapperProps) {
  const element = document.createElement("div")
  insert(element, () => [props.action, props.children])
  return element
}
function buttonWrapper(props: WrapperProps & { disabled?: boolean; onClick?: (event: MouseEvent) => void }) {
  const button = document.createElement("button")
  createEffect(() => button.disabled = !!props.disabled)
  button.addEventListener("click", (event) => props.onClick?.(event))
  insert(button, () => props.children)
  return button
}
function icon(props: { name?: string; id?: string }) {
  const element = document.createElement("span")
  element.dataset.icon = props.name ?? props.id ?? ""
  return element
}
function listWrapper(props: {
  items(): { id: string; name: string; provider: { id: string } }[]
  current?: { id: string; provider: { id: string } }
  onSelect(item: { id: string; name: string; provider: { id: string } }): void
}) {
  const element = document.createElement("div")
  insert(element, () => props.items().map((item) => {
    const button = document.createElement("button")
    button.dataset.modelKey = item.provider.id + ":" + item.id
    button.textContent = item.name
    createEffect(() => {
      button.setAttribute("aria-pressed", String(props.current?.id === item.id && props.current?.provider.id === item.provider.id))
    })
    button.addEventListener("click", () => props.onSelect(item))
    return button
  }))
  return element
}

beforeAll(async () => {
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core") as {
    transformSync(source: string, options: Record<string, unknown>): { code?: string | null } | null
  }
  const solidModule = require("babel-preset-solid")
  await plugin({
    name: "model-dialog-entrypoints-solid-jsx",
    setup(build) {
      build.onLoad({ filter: /[\\/]components[\\/]dialog-select-model(?:-unpaid-v2)?\.tsx$/ }, async ({ path }) => {
        const result = babel.transformSync(await Bun.file(path).text(), {
          filename: path, configFile: false, babelrc: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
          presets: [[solidModule.default ?? solidModule, { generate: "dom" }]],
        })
        if (!result?.code) throw new Error("Model dialog compilation failed")
        return { contents: result.code, loader: "ts" }
      })
    },
  })
  // Exercise the real dialog wrappers, controller and confirmation code. Only UI
  // shells and external services are isolated; their selection callbacks stay real.
  mock.module("@arforge-ai/ui/v2/dialog-v2", () => ({
    DialogV2: wrapper, DialogHeader: wrapper, DialogBody: wrapper, DialogTitle: wrapper,
  }))
  mock.module("@arforge-ai/ui/dialog", () => ({ Dialog: wrapper }))
  mock.module("@arforge-ai/ui/button", () => ({ Button: buttonWrapper }))
  mock.module("@arforge-ai/ui/icon-button", () => ({ IconButton: buttonWrapper }))
  mock.module("@arforge-ai/ui/scroll-view", () => ({ ScrollView: wrapper }))
  mock.module("@arforge-ai/ui/list", () => ({ List: listWrapper }))
  mock.module("@arforge-ai/ui/tag", () => ({ Tag: wrapper }))
  mock.module("@arforge-ai/ui/tooltip", () => ({ Tooltip: wrapper }))
  mock.module("@arforge-ai/ui/v2/tooltip-v2", () => ({ TooltipV2: wrapper }))
  mock.module("@arforge-ai/ui/v2/badge-v2", () => ({ Tag: wrapper }))
  mock.module("@arforge-ai/ui/v2/icon", () => ({ Icon: icon }))
  mock.module("@arforge-ai/ui/provider-icon", () => ({ ProviderIcon: icon }))
  mock.module("@arforge-ai/ui/v2/menu-v2", () => ({ MenuV2: wrapper }))
  mock.module("@kobalte/core/popover", () => ({ Popover: wrapper }))
  mock.module("@arforge-ai/ui/context/dialog", () => ({
    useDialog: () => ({
      close: () => fixture.closes++,
      show: (view: () => unknown) => { fixture.shows++; return view() },
    }),
  }))
  mock.module("@arforge-ai/ui/theme", () => ({ useTheme: () => ({ mode: () => "light" }) }))
  mock.module("@/context/local", () => ({
    useLocal: () => ({ model: fixture.model, modelSelection: fixture.localBinding, slug: () => btoa("E:/picker-unpaid-test") }),
  }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ intl: () => "en", t: (key: string) => key }) }))
  mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ scope: "server", directory: "E:/picker-unpaid-test" }) }))
  mock.module("@solidjs/router", () => ({ useParams: () => ({ id: "session" }), useSearchParams: () => [{}] }))
  mock.module("@tanstack/solid-query", () => ({ useQueryClient: () => fixture.queryClient }))
  mock.module("@/hooks/use-providers", () => ({
    popularProviders: ["openai", "anthropic", "google"],
    useProviders: () => ({ popular: () => [{ id: "openai", name: "OpenAI" }] }),
  }))
  mock.module("@/components/model-tooltip", () => ({ ModelTooltip: () => undefined }))
  mock.module("@/components/dialog-select-model-v2", () => ({ ModelSelectorPopoverV2: wrapper }))
  mock.module("@/components/dialog-connect-provider", () => ({
    useProviderConnectController: () => ({ select: (provider?: string) => fixture.providerSelections.push(provider) }),
    DialogConnectProvider: (props: { directory(): string }) => {
      fixture.providerDirectories.push(props.directory())
      return document.createElement("div")
    },
  }))
  Unpaid = await import("@/components/dialog-select-model-unpaid-v2")
  Paid = await import("@/components/dialog-select-model")
})

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => resolve = done)
  return { promise, resolve }
}

function makeFixture() {
  const [state, setState] = createStore({
    key: { ...alpha }, legacyKey: { ...alpha }, scope: "server/workspace/draft-1",
    ready: true, catalogReady: true,
    reason: undefined as ReturnType<ModelSelectionBinding["unavailable"]>,
  })
  const items = ["alpha", "beta"].map((id) => ({
    id, name: id === "alpha" ? "Alpha (free)" : "Beta (free)",
    provider: { id: "p", name: "Provider" }, cost: { input: 0 }, latest: false,
  }))
  const counts = {
    closes: 0, shows: 0, selects: 0, legacyWrites: 0, legacyReads: 0, localWrites: 0,
    legacyOptions: [] as ({ recent?: boolean } | undefined)[],
    commits: [] as Choice[], refetches: [] as unknown[][],
    providerSelections: [] as (string | undefined)[], providerDirectories: [] as string[],
  }
  const commit = (choice: Choice, expectedScope: string) => {
    if (state.scope !== expectedScope) throw new ModelChoiceError("scope-changed")
    counts.commits.push({ ...choice })
    setState("key", { ...choice })
  }
  let select: ModelSelectionBinding["select"] = commit
  const binding: ModelSelectionBinding = {
    key: () => state.key, scope: () => state.scope, ready: () => state.ready,
    unavailable: () => state.reason,
    select: (choice, expectedScope) => { counts.selects++; return select(choice, expectedScope) },
  }
  const model = {
    ready: () => state.catalogReady,
    list: () => items,
    current: () => { counts.legacyReads++; return items.find((item) => item.id === state.legacyKey.modelID) },
    visible: () => true,
    set: (choice: Choice | undefined, options?: { recent?: boolean }) => {
      counts.legacyWrites++
      counts.legacyOptions.push(options)
      if (choice) setState("legacyKey", { ...choice })
    },
  } as unknown as ModelSelection
  const queryClient = {
    getQueryState: () => ({ status: "success", data: {} }),
    getQueryCache: () => ({ subscribe: () => () => undefined }),
    refetchQueries: async (input: { queryKey: unknown[] }) => { counts.refetches.push(input.queryKey) },
  }
  return Object.assign(counts, {
    state, setState, model, binding, queryClient, commit,
    localBinding: { ...binding, select: () => { counts.localWrites++ } },
    setSelect: (next: ModelSelectionBinding["select"]) => select = next,
  })
}

function mount(options: { full?: boolean; legacy?: boolean } = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const props = {
    model: options.legacy ? { ...fixture.model } : fixture.model,
    binding: options.legacy ? undefined : fixture.binding,
  }
  const dispose = render(() => options.full
    ? createComponent(Paid.DialogSelectModel, props)
    : createComponent(Unpaid.DialogSelectModelUnpaidV2, props), host)
  let disposed = false
  const cleanup = () => { if (disposed) return; disposed = true; dispose(); host.remove() }
  disposals.push(cleanup)
  return { host, dispose: cleanup }
}
function modelButton(host: HTMLElement, id = "beta") {
  const result = host.querySelector<HTMLButtonElement>('[data-model-key="p:' + id + '"]')
  if (!result) throw new Error("Missing model button: " + id)
  return result
}
function textButton(host: HTMLElement, text: string) {
  const result = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)
  if (!result) throw new Error("Missing button: " + text)
  return result
}

describe("real unpaid V2 model entrypoint", () => {
  test("waits for binding readiness and confirmation before closing, without using either fallback setter", async () => {
    fixture = makeFixture()
    fixture.setState("ready", false)
    const view = mount()
    expect(modelButton(view.host).disabled).toBe(true)
    modelButton(view.host).click()
    expect(fixture.selects).toBe(0)
    fixture.setState("ready", true)
    const gate = deferred()
    fixture.setSelect(async (choice, scope) => { await gate.promise; fixture.commit(choice, scope) })
    modelButton(view.host).click()
    expect(fixture.closes).toBe(0)
    expect(modelButton(view.host).disabled).toBe(true)
    gate.resolve()
    await settle()
    expect(fixture.closes).toBe(1)
    expect(fixture.state.key).toEqual(beta)
    expect(fixture.legacyWrites).toBe(0)
    expect(fixture.localWrites).toBe(0)
    expect(fixture.legacyReads).toBe(0)
  })

  test("keeps rejected writes open and retries the scoped real catalog query", async () => {
    fixture = makeFixture()
    fixture.setSelect(async () => { throw new Error("denied") })
    const view = mount()
    modelButton(view.host).click()
    await settle()
    expect(fixture.closes).toBe(0)
    expect(fixture.state.key).toEqual(alpha)
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("could not be selected")
    textButton(view.host, "Retry").click()
    await settle()
    expect(fixture.refetches).toEqual([["server", "E:/picker-unpaid-test", "providers"]])
    fixture.setSelect(fixture.commit)
    modelButton(view.host).click()
    await settle()
    expect(fixture.closes).toBe(1)
    expect(fixture.legacyWrites).toBe(0)
  })

  test("retains an unavailable explicit key instead of displaying the legacy fallback", async () => {
    fixture = makeFixture()
    fixture.setState("key", { providerID: "p", modelID: "removed" })
    fixture.setState("reason", "removed")
    const view = mount()
    expect(view.host.textContent).toContain("p / removed")
    expect(view.host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    expect(fixture.legacyReads).toBe(0)
    modelButton(view.host).click()
    await settle()
    expect(fixture.state.key).toEqual(beta)
    expect(fixture.closes).toBe(1)
  })

  test("does not commit or close after a scope change, including navigation back", async () => {
    fixture = makeFixture()
    const gate = deferred()
    fixture.setSelect(async (choice, scope) => { await gate.promise; fixture.commit(choice, scope) })
    const view = mount()
    modelButton(view.host).click()
    fixture.setState("scope", "server/workspace/draft-2")
    gate.resolve()
    await settle()
    expect(fixture.commits).toHaveLength(0)
    expect(fixture.state.key).toEqual(alpha)
    expect(fixture.closes).toBe(0)
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("session changed")
    fixture.setState("scope", "server/workspace/draft-1")
    expect(modelButton(view.host).disabled).toBe(true)
    modelButton(view.host).click()
    expect(fixture.selects).toBe(1)
  })

  test("ignores a receipt after the original dialog was disposed", async () => {
    fixture = makeFixture()
    const gate = deferred()
    fixture.setSelect(() => gate.promise)
    const view = mount()
    modelButton(view.host).click()
    view.dispose()
    gate.resolve()
    await settle()
    expect(fixture.closes).toBe(0)
    expect(fixture.legacyWrites).toBe(0)
  })

  test("does not close for an unconfirmed no-op binding", async () => {
    fixture = makeFixture()
    fixture.setSelect(() => undefined)
    const view = mount()
    modelButton(view.host).click()
    await settle()
    expect(fixture.closes).toBe(0)
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
    expect(fixture.state.key).toEqual(alpha)
  })

  test("preserves model-only callers without changing recent/default preferences", async () => {
    fixture = makeFixture()
    const view = mount({ legacy: true })
    modelButton(view.host).click()
    await settle()
    expect(fixture.closes).toBe(1)
    expect(fixture.legacyWrites).toBe(1)
    expect(fixture.legacyOptions).toEqual([{ recent: false }])
    expect(fixture.selects).toBe(0)
  })

  test("preserves the provider-connect handler and its workspace", async () => {
    fixture = makeFixture()
    const view = mount()
    textButton(view.host, "OpenAI").click()
    await settle()
    expect(fixture.providerSelections).toEqual(["openai"])
    expect(fixture.providerDirectories).toEqual(["E:/picker-unpaid-test"])
    expect(fixture.shows).toBe(1)
    expect(fixture.closes).toBe(0)
    expect(fixture.selects).toBe(0)
  })
})

describe("real full DialogSelectModel wrapper", () => {
  test("forwards binding through ModelList and closes only after its confirmed commit", async () => {
    fixture = makeFixture()
    const gate = deferred()
    fixture.setSelect(async (choice, scope) => { await gate.promise; fixture.commit(choice, scope) })
    const view = mount({ full: true })
    modelButton(view.host).click()
    expect(fixture.closes).toBe(0)
    expect(fixture.selects).toBe(1)
    gate.resolve()
    await settle()
    expect(fixture.closes).toBe(1)
    expect(fixture.state.key).toEqual(beta)
    expect(fixture.legacyWrites).toBe(0)
    expect(fixture.localWrites).toBe(0)
  })

  test("honors readiness, preserves unavailable keys and leaves failed confirmation open", async () => {
    fixture = makeFixture()
    fixture.setState("key", { providerID: "p", modelID: "removed" })
    fixture.setState("reason", "removed")
    fixture.setState("ready", false)
    fixture.setSelect(() => undefined)
    const view = mount({ full: true })
    expect(view.host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0)
    expect(view.host.textContent).toContain("p / removed")
    modelButton(view.host).click()
    expect(fixture.selects).toBe(0)
    fixture.setState("ready", true)
    modelButton(view.host).click()
    await settle()
    expect(fixture.closes).toBe(0)
    expect(fixture.legacyWrites).toBe(0)
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("not confirmed")
  })
})
