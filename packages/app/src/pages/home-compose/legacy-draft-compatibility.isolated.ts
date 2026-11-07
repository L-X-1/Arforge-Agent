import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import {
  children,
  createComputed,
  createRoot,
  createSignal,
  onCleanup,
  Show,
  type JSX,
  type ParentProps,
} from "solid-js"
import * as solid from "solid-js"
import * as web from "solid-js/web"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { base64Encode } from "@arforge-ai/core/util/encode"
import {
  activeDraftID,
  bindDraftActions,
  captureDraftForSource,
  sameDraftSource,
} from "@/pages/home-compose/home-draft-state"
import { createPromptModelState } from "@/pages/session/composer/prompt-model-state"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { createPromptSubmissionState } from "@/components/prompt-input/submission-state"
import { createPromptSession } from "@/context/prompt-state"
import { ServerScope } from "@/utils/server-scope"
import type { DraftTab, useTabs as UseTabs } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt-state"
import type { ServerConnection } from "@/context/server"

const source = { server: "server-a" as ServerConnection.Key, directory: "E:/workspace" }
const path = `/${base64Encode(source.directory)}/session`
const location = { pathname: path, search: "" }
const navigation: string[] = []
const availableServers = [{ key: source.server }]
let tabs: ReturnType<typeof UseTabs>
let rootDispose = () => {}
let createDraftPromptSession: typeof import("@/context/prompt-state").createDraftPromptSession

class PrivateStorage implements Storage {
  values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}
const storage = new PrivateStorage()

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
  mock.module("@arforge-ai/ui/context", () => ({
    createSimpleContext: (options: { init: () => typeof tabs }) => ({
      provider: () => {
        tabs = options.init()
      },
      use: () => tabs,
    }),
  }))
  mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  mock.module("@/context/server", () => ({
    ServerConnection: { key: (connection: { key: string }) => connection.key },
    useServer: () => ({ key: source.server, list: availableServers }),
  }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  mock.module("@/components/preview/text-document-close-guard", () => ({
    textDocumentCloseGuard: { confirm: () => true },
  }))
  mock.module("@/utils/new-session-route", () => ({ preloadNewSessionRoute: async () => {} }))
  mock.module("@solidjs/router", () => ({
    useLocation: () => location,
    useParams: () => ({}),
    useNavigate: () => (href: string) => {
      navigation.push(href)
      const target = new URL(href, "http://fixture.invalid")
      location.pathname = target.pathname
      location.search = target.search
    },
  }))
  const { TabsProvider } = await import("@/context/tabs")
  ;({ createDraftPromptSession } = await import("@/context/prompt-state"))
  createRoot((dispose) => {
    rootDispose = dispose
    TabsProvider({})
  })
  await tabs.ready.promise
})
afterAll(() => rootDispose())
const settled = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
const makeDraft = () => tabs.newDraft(source, undefined, undefined, { navigate: false })
const promptFor = (draft: DraftTab) => tabs.stateValue<PromptSession>(draft, "prompt")!

test("only exact valid no-ID legacy routes join the existing active draft contract", () => {
  expect(activeDraftID(path, "?draftId=A%20one")).toBe("A one")
  expect(activeDraftID(`${path}/`, "?draftId=B")).toBe("B")
  for (const invalid of [`${path}/session-id`, "/settings", "/server/server-a/session/id", "/bad=/session"]) {
    expect(activeDraftID(invalid, "?draftId=A")).toBeUndefined()
  }
  expect(activeDraftID("/", "?history=1&draftId=A")).toBeUndefined()
  expect(activeDraftID("/new-session", "?draftId=A")).toBe("A")
})

test("source capture rejects another server/directory and snapshots the matched draft", () => {
  const a: DraftTab = { type: "draft", draftID: "capture-a", ...source }
  const captured = captureDraftForSource([a], a.draftID, source)
  a.directory = "E:/changed"
  expect(captured.directory).toBe("E:/workspace")
  expect(() =>
    captureDraftForSource([captured], captured.draftID, { ...source, server: "server-b" as ServerConnection.Key }),
  ).toThrow("source changed")
  expect(() => captureDraftForSource([captured], captured.draftID, { ...source, directory: "E:/other" })).toThrow(
    "source changed",
  )
  expect(() => captureDraftForSource([], captured.draftID, source)).toThrow("source changed")
})

test("real Tabs and persisted prompt owner restore A/B/A text, attachment, cursor and model on the same route", async () => {
  const a = await makeDraft()
  const b = await makeDraft()
  const first = promptFor(a)
  const second = promptFor(b)
  await first.ready.promise
  await second.ready.promise
  first.set(
    [
      { type: "text", content: "Draft A", start: 0, end: 7 },
      { type: "image", id: "image-a", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AA==" },
    ],
    3,
  )
  first.context.add({ type: "file", path: "a.ts", comment: "retain A context" })
  first.model.set({ providerID: "provider", modelID: "A", variant: "high" })
  second.set([{ type: "text", content: "Draft B", start: 0, end: 7 }], 5)
  second.model.set({ providerID: "provider", modelID: "B", variant: null })
  const route = (location.pathname = path)
  const sameSessionKey = `${source.server}\0${base64Encode(source.directory)}`
  for (const id of [a.draftID, b.draftID, a.draftID]) {
    location.search = `?draftId=${id}`
    const captured = captureDraftForSource(tabs.store, activeDraftID(location.pathname, location.search)!, source)
    expect(promptFor(captured)).toBe(id === a.draftID ? first : second)
    expect(location.pathname).toBe(route)
    expect(`${source.server}\0${base64Encode(source.directory)}`).toBe(sameSessionKey)
  }
  expect(first.current()[1]).toMatchObject({ id: "image-a", dataUrl: "data:image/png;base64,AA==" })
  expect(first.cursor()).toBe(3)
  expect(first.context.items()[0]).toMatchObject({ path: "a.ts", comment: "retain A context" })
  expect(second.model.current()).toEqual({ providerID: "provider", modelID: "B", variant: null })
  await settled()
  let stop = () => {}
  const restored = createRoot((dispose) => {
    stop = dispose
    return createDraftPromptSession(a.draftID)
  })
  await restored.ready.promise
  expect(restored.current()).toEqual(first.current())
  expect(restored.model.current()).toEqual({ providerID: "provider", modelID: "A", variant: "high" })
  expect(restored.cursor()).toBe(3)
  expect([...storage.values.values()].some((value) => value.includes('"image-a"') && value.includes('"high"'))).toBe(
    true,
  )
  stop()
})

test("real legacy promotion navigates once, while a reclaimed A2 prevents retired A1 from consuming its draft", async () => {
  const a = await makeDraft()
  const b = await makeDraft()
  location.pathname = path
  location.search = `?draftId=${a.draftID}`
  const active = bindDraftActions({
    tabs,
    draft: captureDraftForSource(tabs.store, a.draftID, source),
    active: () => activeDraftID(location.pathname, location.search) === a.draftID,
  })
  const count = navigation.length
  active.promoteDraft(a.draftID, { server: source.server, sessionId: "legacy-promoted" })
  await settled()
  expect(navigation.slice(count)).toHaveLength(1)
  expect(navigation.at(-1)).toContain("/session/legacy-promoted")
  const late = await makeDraft()
  location.pathname = path
  location.search = `?draftId=${b.draftID}`
  const bound = bindDraftActions({
    tabs,
    draft: late,
    active: () => activeDraftID(location.pathname, location.search) === late.draftID,
  })
  const after = navigation.length
  bound.promoteDraft(b.draftID, { server: "server-b" as ServerConnection.Key, sessionId: "late-owned" })
  await settled()
  expect(navigation.length).toBe(after)
  expect(tabs.draft(b.draftID)).toMatchObject({ draftID: b.draftID, ...source })
  expect(tabs.store).toContainEqual({ type: "session", server: source.server, sessionId: "late-owned" })

  const returning = await makeDraft()
  location.pathname = path
  location.search = `?draftId=${returning.draftID}`
  const owners: Array<{
    active: () => boolean
    canConsume: () => boolean
    actions: ReturnType<typeof bindDraftActions>
  }> = []
  let stop = () => {}
  const mounted = createRoot((dispose) => {
    stop = dispose
    const [draft, set] = createSignal(returning)
    const view = Show({
      get when() {
        return draft()
      },
      keyed: true,
      children: (tab) => {
        const captured = captureDraftForSource(tabs.store, tab.draftID, source)
        const state = promptFor(captured)
        state.ownership.claim()
        const consumption = state.ownership.capture()
        const lifetime = createSessionOwnership(() => captured.draftID).capture()
        const active = () =>
          lifetime.current() && activeDraftID(location.pathname, location.search) === captured.draftID
        owners.push({
          active,
          canConsume: consumption.current,
          actions: bindDraftActions({ tabs, draft: captured, active }),
        })
        return captured.draftID
      },
    })
    createComputed(children(() => view))
    return { set }
  })
  try {
    const first = owners[0]
    expect(first.active()).toBe(true)
    let release!: () => void
    const delayed = new Promise<void>((done) => {
      release = done
    }).then(() => {
      const session = { server: source.server, sessionId: "retired-a-returned" }
      tabs.addSessionTab(session, returning)
      return first.actions.promoteDraft(returning.draftID, session, source, first.active, first.canConsume)
    })
    location.search = `?draftId=${b.draftID}`
    mounted.set(b)
    location.search = `?draftId=${returning.draftID}`
    mounted.set(returning)
    expect(owners).toHaveLength(3)
    expect(first.active()).toBe(false)
    expect(owners.at(-1)!.active()).toBe(true)
    const beforeReturn = navigation.length
    const retainedB = promptFor(b)
    release()
    await delayed
    await settled()
    expect(navigation.length).toBe(beforeReturn)
    expect(location.pathname).toBe(path)
    expect(location.search).toBe(`?draftId=${returning.draftID}`)
    expect(tabs.store.some((tab) => tab.type === "draft" && tab.draftID === returning.draftID)).toBe(true)
    expect(tabs.store).toContainEqual({ type: "session", server: source.server, sessionId: "retired-a-returned" })
    expect(tabs.draft(b.draftID)).toMatchObject({ draftID: b.draftID, ...source })
    expect(promptFor(b)).toBe(retainedB)

    const live = await makeDraft()
    location.pathname = path
    location.search = `?draftId=${live.draftID}`
    mounted.set(live)
    expect(owners.at(-1)!.active()).toBe(true)
    const beforeLive = navigation.length
    owners.at(-1)!.actions.promoteDraft(live.draftID, { server: source.server, sessionId: "live-owner-returned" })
    await settled()
    expect(navigation.length).toBe(beforeLive + 1)
    expect(navigation.at(-1)).toContain("/session/live-owner-returned")
    expect(tabs.store).toContainEqual({ type: "session", server: source.server, sessionId: "live-owner-returned" })
  } finally {
    stop()
  }
})

function models(prompt: () => PromptSession, hydration = Promise.resolve()) {
  const entries = ["A", "B"].map((id) => ({
    id,
    name: `Model ${id}`,
    provider: { id: "provider", name: "Provider" },
    variants: { high: {}, low: {} },
  }))
  const dependencies = {
    agent: () => undefined,
    configured: () => undefined,
    prompt: { capture: prompt, ready: Object.assign(() => true, { promise: Promise.resolve() }) },
    scope: () => ({ server: source.server, directory: source.directory }),
    providers: {
      all: () =>
        new Map([["provider", { id: "provider", models: Object.fromEntries(entries.map((item) => [item.id, item])) }]]),
      connected: () => [{ id: "provider" }],
      default: () => ({ providerID: "provider", modelID: "A" }),
    },
    models: {
      ready: Object.assign(() => true, { promise: hydration }),
      find: (key: { modelID: string }) => entries.find((item) => item.id === key.modelID),
      list: () => entries,
      visible: () => true,
      setVisibility: () => {},
      recent: { list: () => [], push: () => {} },
      variant: { get: () => undefined, set: () => {} },
    },
  }
  return createPromptModelState(dependencies as unknown as Parameters<typeof createPromptModelState>[0])
}

test("canonical model binding restores distinct model names/variants on two persisted drafts", async () => {
  const a = promptFor(await makeDraft())
  const b = promptFor(await makeDraft())
  a.model.set({ providerID: "provider", modelID: "A", variant: "high" })
  b.model.set({ providerID: "provider", modelID: "B", variant: "low" })
  let stop = () => {}
  const state = createRoot((dispose) => {
    stop = dispose
    const [active, set] = createSignal(a)
    return { model: models(active), set }
  })
  expect(state.model.current()?.name).toBe("Model A")
  const scopeA = state.model.binding.scope()
  state.set(b)
  expect(state.model.current()?.name).toBe("Model B")
  expect(state.model.variant.current()).toBe("low")
  expect(state.model.binding.scope()).not.toBe(scopeA)
  state.set(a)
  expect(state.model.current()?.name).toBe("Model A")
  expect(state.model.variant.current()).toBe("high")
  // The production compatibility route keys the whole composer, rather than
  // keeping this model helper alive across query-draft transitions.
  expect(a.model.current()).toMatchObject({ modelID: "A", variant: "high" })
  stop()
})

test("keyed A/B/A composer disposal rejects pending model, variant and picker writes without altering either draft", async () => {
  const a = promptFor(await makeDraft())
  const b = promptFor(await makeDraft())
  a.model.set({ providerID: "provider", modelID: "A", variant: "high" })
  b.model.set({ providerID: "provider", modelID: "B", variant: "low" })
  let release!: () => void
  const gate = new Promise<void>((yes) => {
    release = yes
  })
  let stop = () => {}
  const owners: Array<ReturnType<typeof models>> = []
  const state = createRoot((dispose) => {
    stop = dispose
    const [active, set] = createSignal({ id: "A", prompt: a })
    const view = Show({
      get when() {
        return active()
      },
      keyed: true,
      children: (owner) => {
        owners.push(models(() => owner.prompt, gate))
        return owner.id
      },
    })
    createComputed(children(() => view))
    return { set }
  })
  const old = owners[0]
  const current = old.binding.scope()
  const pending = [
    old.set({ providerID: "provider", modelID: "B" }),
    old.variant.set("low"),
    old.binding.select({ providerID: "provider", modelID: "B" }, current),
  ]
  const settledPending = Promise.allSettled(pending)
  state.set({ id: "B", prompt: b })
  state.set({ id: "A", prompt: a })
  release()
  for (const operation of await settledPending)
    expect(operation).toMatchObject({ status: "rejected", reason: { reason: "scope-changed" } })
  await expect(old.binding.select({ providerID: "provider", modelID: "B" }, current)).rejects.toMatchObject({
    reason: "scope-changed",
  })
  await expect(old.set({ providerID: "provider", modelID: "B" })).rejects.toMatchObject({ reason: "scope-changed" })
  expect(owners.at(-1)!.current()?.name).toBe("Model A")
  expect(owners.at(-1)!.variant.current()).toBe("high")
  expect(a.model.current()?.modelID).toBe("A")
  expect(b.model.current()?.modelID).toBe("B")
  stop()
})

test("keyed Solid draft lifetimes retire old focus owners even with the same SessionKey, including SDK replacement", () => {
  let stop = () => {}
  let currentSDK: object = {}
  const captures: Array<{ owner: ReturnType<ReturnType<typeof createSessionOwnership>["capture"]>; sdk: object }> = []
  const state = createRoot((dispose) => {
    stop = dispose
    const [draft, set] = createSignal({ id: "A", source: currentSDK })
    const view = Show({
      get when() {
        return draft()
      },
      keyed: true,
      children: (value) => {
        captures.push({ owner: createSessionOwnership(() => "unchanged-session-key").capture(), sdk: value.source })
        return value.id
      },
    })
    createComputed(children(() => view))
    return { set }
  })
  const first = captures[0]
  state.set({ id: "B", source: currentSDK })
  state.set({ id: "A", source: currentSDK })
  expect(first.owner.current()).toBe(false)
  let focused = 0
  const focus = (entry: typeof first) => {
    if (entry.owner.current() && entry.sdk === currentSDK) focused++
  }
  focus(first)
  expect(focused).toBe(0)
  const latest = captures.at(-1)!
  currentSDK = {}
  focus(latest)
  expect(focused).toBe(0)
  state.set({ id: "A", source: currentSDK })
  expect(latest.owner.current()).toBe(false)
  stop()
})

test("real draft consumption preserves reclaimed A2 edits, memory and persistence through delayed completion and reload", async () => {
  const a = await makeDraft(),
    b = await makeDraft()
  const initial = promptFor(a)
  await initial.ready.promise
  initial.ownership.claim()
  initial.set([{ type: "text", content: "A1 sent", start: 0, end: 7 }], 7)
  initial.model.set({ providerID: "provider", modelID: "A", variant: "high" })
  initial.context.add({ type: "file", path: "a1.ts", comment: "sent context" })
  const submitted = createPromptSubmissionState({
    target: initial.capture(),
    prompt: initial.current(),
    context: initial.context.items().slice(),
  })
  const bound = bindDraftActions({ tabs, draft: a, active: () => false })
  let release!: () => void
  const result = new Promise<void>((done) => {
    release = done
  }).then(async () => {
    const session = { server: source.server, sessionId: "created-before-a2-edits" }
    tabs.addSessionTab(session, a)
    const next = tabs.state({ type: "session", ...session }, "prompt", () =>
      createPromptSession(ServerScope.local, { dir: base64Encode(source.directory), id: session.sessionId }),
    )
    submitted.retarget(next.capture(), { consumeInitial: false })
    await bound.promoteDraft(a.draftID, session, source, () => false, submitted.canConsume)
    submitted.update(() => {
      for (const item of submitted.context) submitted.target().context.remove(item.key)
    })
    submitted.clear()
  })
  location.pathname = path
  location.search = `?draftId=${b.draftID}`
  promptFor(b).ownership.claim()
  location.search = `?draftId=${a.draftID}`
  initial.ownership.claim()
  initial.set([{ type: "text", content: "A2 new text", start: 0, end: 11 }], 4)
  initial.model.set({ providerID: "provider", modelID: "B", variant: "low" })
  initial.context.add({ type: "file", path: "a2.ts", comment: "keep new context" })
  location.search = `?draftId=${b.draftID}`
  const beforeNavigation = navigation.length
  release()
  await result
  await settled()
  expect(submitted.canConsume()).toBe(false)
  expect(navigation.length).toBe(beforeNavigation)
  expect(location.search).toBe(`?draftId=${b.draftID}`)
  expect(tabs.draft(a.draftID)).toMatchObject(a)
  expect(promptFor(a)).toBe(initial)
  expect(initial.current()[0]).toMatchObject({ content: "A2 new text" })
  expect(initial.model.current()).toEqual({ providerID: "provider", modelID: "B", variant: "low" })
  expect(initial.context.items().map((item) => item.path)).toEqual(["a1.ts", "a2.ts"])
  expect(
    tabs.store.filter((tab) => tab.type === "session" && tab.sessionId === "created-before-a2-edits"),
  ).toHaveLength(1)
  expect(submitted.prompt[0]).toMatchObject({ content: "A1 sent" })
  expect(submitted.context.map((item) => item.path)).toEqual(["a1.ts"])
  location.search = `?draftId=${a.draftID}`
  expect(promptFor(a).cursor()).toBe(4)
  let disposeReload = () => {}
  const restored = createRoot((dispose) => {
    disposeReload = dispose
    return createDraftPromptSession(a.draftID)
  })
  await restored.ready.promise
  expect(restored.current()).toEqual(initial.current())
  expect(restored.model.current()).toEqual(initial.model.current())
  expect(restored.context.items()).toEqual(initial.context.items())
  expect(restored.cursor()).toBe(4)
  disposeReload()

  for (const foreground of [false, true]) {
    const draft = await makeDraft(),
      state = promptFor(draft)
    await state.ready.promise
    state.set([{ type: "text", content: "unchanged", start: 0, end: 9 }], 9)
    let retireView = () => {}
    const original = createRoot((dispose) => {
      retireView = dispose
      state.ownership.claim()
      return createPromptSubmissionState({ target: state.capture(), prompt: state.current(), context: [] })
    })
    if (!foreground) retireView()
    // The view can retire while its real Tab-owned PromptState remains consumable.
    expect(original.canConsume()).toBe(true)
    const session = { server: source.server, sessionId: foreground ? "current-live-a" : "unclaimed-background-a" }
    location.pathname = path
    location.search = `?draftId=${foreground ? draft.draftID : b.draftID}`
    const startNavigation = navigation.length
    tabs.addSessionTab(session, draft)
    await tabs.promoteDraft(draft.draftID, session, source, () => foreground, original.canConsume)
    expect(tabs.store.some((tab) => tab.type === "draft" && tab.draftID === draft.draftID)).toBe(false)
    expect(tabs.store.filter((tab) => tab.type === "session" && tab.sessionId === session.sessionId)).toHaveLength(1)
    expect(navigation.length).toBe(startNavigation + (foreground ? 1 : 0))
    expect(tabs.stateValue(draft, "prompt")).toBeUndefined()
    retireView()
  }
})

test("delayed registration never resurrects a closed draft, removed server or explicitly closed Session tab", async () => {
  const closedDraft = await makeDraft()
  tabs.closeTab(tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === closedDraft.draftID))
  await settled()
  const closedSession = { server: source.server, sessionId: "closed-draft-created-session" }
  expect(tabs.addSessionTab(closedSession, closedDraft)).toBeUndefined()
  expect(tabs.store.some((tab) => tab.type === "session" && tab.sessionId === closedSession.sessionId)).toBe(false)
  expect(tabs.stateValue(closedDraft, "prompt")).toBeUndefined()

  const removedSourceDraft = await makeDraft()
  availableServers.splice(0)
  const removedSourceSession = { server: source.server, sessionId: "removed-server-created-session" }
  try {
    expect(tabs.addSessionTab(removedSourceSession, removedSourceDraft)).toBeUndefined()
    await tabs.promoteDraft(
      removedSourceDraft.draftID,
      removedSourceSession,
      source,
      () => true,
      () => true,
    )
    expect(tabs.store.some((tab) => tab.type === "session" && tab.sessionId === removedSourceSession.sessionId)).toBe(
      false,
    )
    expect(tabs.draft(removedSourceDraft.draftID)).toMatchObject(removedSourceDraft)
  } finally {
    availableServers.push({ key: source.server })
  }

  const retainedDraft = await makeDraft()
  const userClosed = { server: source.server, sessionId: "user-closed-created-session" }
  tabs.addSessionTab(userClosed)
  await settled()
  tabs.closeTab(tabs.store.findIndex((tab) => tab.type === "session" && tab.sessionId === userClosed.sessionId))
  await settled()
  const beforeNavigation = navigation.length
  expect(tabs.addSessionTab(userClosed, retainedDraft)).toBeUndefined()
  await tabs.promoteDraft(
    retainedDraft.draftID,
    userClosed,
    source,
    () => true,
    () => true,
  )
  expect(navigation.length).toBe(beforeNavigation)
  expect(tabs.store.some((tab) => tab.type === "session" && tab.sessionId === userClosed.sessionId)).toBe(false)
  expect(tabs.draft(retainedDraft.draftID)).toMatchObject(retainedDraft)
})

test("actual compatibility route retains workspace providers and retires draft callbacks across same-SDK A/B/A", async () => {
  const a = await makeDraft()
  const b = await makeDraft()
  // Compile the owning route functions, not a copy of their provider tree or active predicate.
  const filename = new URL("../session.tsx", import.meta.url).pathname
  const sourceText = readFileSync(new URL("../session.tsx", import.meta.url), "utf8")
  const parsed = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const functions = parsed.statements
    .filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        !!statement.name &&
        ["SessionPage", "SessionProviders", "SessionPromptProviders"].includes(statement.name.text),
    )
    .map((statement) => statement.getText(parsed).replace(/^export /, ""))
    .join("\n")
  const require = createRequire(import.meta.resolve("vite-plugin-solid"))
  const babel = require("@babel/core"),
    preset = require("babel-preset-solid")
  const transformed = babel.transformSync(functions, {
    filename,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [[preset.default ?? preset, { generate: "dom" }]],
  }).code
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(transformed)
  const module = ts.createSourceFile("route.js", javascript, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const runtime: Record<string, unknown> = { ...solid, ...web }
  const body = module.statements
    .filter((statement) => {
      if (!ts.isImportDeclaration(statement)) return true
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) throw Error("Unexpected route compiler import")
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text
        if (!(imported in runtime)) throw Error(`Missing Solid runtime helper: ${imported}`)
        runtime[binding.name.text] = runtime[imported]
      }
      return false
    })
    .map((statement) => statement.getText(module))
    .join("\n")
  const mounts = { terminal: 0, file: 0, prompt: 0, comments: 0 }
  const cleanups = { terminal: 0, file: 0, prompt: 0, comments: 0 }
  const captures: Array<() => boolean> = []
  const host = document.createElement("div")
  document.body.append(host)
  let stop = () => {}
  let setDraft!: (draft: DraftTab) => void
  const serverSDK = { server: { key: source.server } },
    directorySDK = { directory: source.directory }
  const provider = (kind: keyof typeof mounts) => (props: ParentProps) => {
    mounts[kind]++
    onCleanup(() => cleanups[kind]++)
    return props.children
  }
  stop = web.render(() => {
    const [draft, set] = createSignal(a)
    setDraft = set
    const query = {
      get draftId() {
        return draft().draftID
      },
    }
    Object.assign(runtime, {
      useParams: () => ({}),
      useSearchParams: () => [query],
      useLocation: () => ({
        pathname: path,
        get search() {
          return `?draftId=${query.draftId}`
        },
      }),
      useSettings: () => ({ general: { newLayoutDesigns: () => true } }),
      useTabs: () => tabs,
      useSDK: () => () => directorySDK,
      useServerSDK: () => () => serverSDK,
      ServerConnection: { key: (connection: { key: string }) => connection.key },
      activeDraftID,
      captureDraftForSource,
      sameDraftSource,
      createSessionOwnership,
      TerminalProvider: provider("terminal"),
      FileProvider: provider("file"),
      PromptProvider: provider("prompt"),
      CommentsProvider: provider("comments"),
      DraftTabsScopeProvider: (props: ParentProps<{ active: () => boolean }>) => {
        captures.push(props.active)
        return props.children
      },
      CompatibilityNewSessionPage: () => document.createTextNode(query.draftId),
      Page: () => document.createTextNode("ordinary Session"),
    })
    const Route = new Function(...Object.keys(runtime), `${body}\nreturn SessionPage;`)(
      ...Object.values(runtime),
    ) as () => JSX.Element
    return solid.createComponent(Route, {})
  }, host)
  try {
    expect(host.textContent).toBe(a.draftID)
    expect(captures[0]()).toBe(true)
    setDraft(b)
    expect(host.textContent).toBe(b.draftID)
    setDraft(a)
    expect(host.textContent).toBe(a.draftID)
    expect(mounts).toEqual({ terminal: 1, file: 1, prompt: 3, comments: 3 })
    expect(cleanups).toEqual({ terminal: 0, file: 0, prompt: 2, comments: 2 })
    expect(captures).toHaveLength(3)
    expect(captures[0]()).toBe(false)
    expect(captures[1]()).toBe(false)
    expect(captures[2]()).toBe(true)
  } finally {
    stop()
    host.remove()
  }
  expect(cleanups).toEqual({ terminal: 1, file: 1, prompt: 3, comments: 3 })
  expect(captures[2]()).toBe(false)
})
