import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { DraftTab, useTabs as UseTabs } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt-state"
import type { ServerConnection as Connection } from "@/context/server"
import { bindDraftActions } from "./home-draft-state"

const serverA = "server-a" as Connection.Key
const serverB = "server-b" as Connection.Key
const sourceA = { server: serverA, directory: "/workspace" }
const sourceB = { server: serverB, directory: "/workspace" }
type Tabs = ReturnType<typeof UseTabs>
let tabs: Tabs
let dispose = () => {}
let TabsProvider: typeof import("@/context/tabs").TabsProvider
let preload: Promise<unknown> | undefined
const location = { pathname: "/", search: "" }
const navigations: Array<{ href: string; tabs: unknown[] }> = []
const removed: unknown[] = []

// Exercise the actual Tabs owner with only its environment boundaries replaced;
// all creation, memory, promotion, state updates and route decisions stay real.
beforeAll(async () => {
  mock.module("@arforge-ai/ui/context", () => ({
    createSimpleContext: (options: { init: () => Tabs }) => ({
      provider: () => {
        tabs = options.init()
      },
      use: () => tabs,
    }),
  }))
  mock.module("@/context/server", () => ({
    ServerConnection: { key: (conn: { key: string }) => conn.key },
    useServer: () => ({ key: serverA, list: [{ key: serverA }, { key: serverB }] }),
  }))
  mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  mock.module("@/components/preview/text-document-close-guard", () => ({
    textDocumentCloseGuard: { confirm: () => true },
  }))
  mock.module("@/utils/new-session-route", () => ({
    preloadNewSessionRoute: async () => {
      await preload
    },
  }))
  mock.module("@solidjs/router", () => ({
    useLocation: () => location,
    useParams: () => ({}),
    useNavigate: () => (href: string) => {
      navigations.push({ href, tabs: tabs.store.map((tab) => ({ ...tab })) })
      const url = new URL(href, "http://arforge.test")
      location.pathname = url.pathname
      location.search = url.search
    },
  }))
  mock.module("@/utils/persist", () => ({
    Persist: { window: (key: string) => key, draft: (id: string, key: string) => `${id}/${key}` },
    persisted: (_key: unknown, state: unknown[]) => [
      ...state,
      undefined,
      Object.assign(() => true, { promise: Promise.resolve() }),
    ],
    removePersisted: (key: unknown) => removed.push(key),
    draftPersistedKeys: () => ["prompt"],
  }))
  ;({ TabsProvider } = await import("@/context/tabs"))
})

beforeEach(() => {
  location.pathname = "/"
  location.search = ""
  navigations.length = 0
  removed.length = 0
  preload = undefined
  createRoot((cleanup) => {
    dispose = cleanup
    TabsProvider({})
  })
})
afterEach(() => dispose())
const settled = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe("real tabs home draft integration", () => {
  test("keeps existing newDraft calls navigating and supports explicit non-navigation", async () => {
    const ordinary = await tabs.newDraft(sourceA)
    expect(navigations.at(-1)?.href).toBe(`/new-session?draftId=${ordinary.draftID}`)
    navigations.length = 0
    const home = await tabs.ensureHomeDraft(sourceB)
    expect(home.home).toBe(true)
    expect(tabs.store).toContainEqual(home)
    expect(navigations).toEqual([])
    tabs.select(home)
    expect(navigations.at(-1)?.href).toBe(`/?draftId=${home.draftID}`)
  })

  test("restores separate actual prompt/model/attachment state for each source", async () => {
    const a = await tabs.ensureHomeDraft(sourceA)
    const b = await tabs.ensureHomeDraft(sourceB)
    const workspace = await tabs.ensureHomeDraft({ ...sourceA, directory: "/workspace/sandbox" })
    const promptA = tabs.state<PromptSession>(a, "prompt", () => {
      throw new Error("lost prompt")
    })
    promptA.set(
      [{ type: "image", id: "attachment-a", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,a" }],
      0,
    )
    promptA.model.set({ providerID: "provider-a", modelID: "model-a" })
    expect((await tabs.ensureHomeDraft(sourceA)).draftID).toBe(a.draftID)
    expect(tabs.stateValue<PromptSession>(a, "prompt")).toBe(promptA)
    expect(tabs.stateValue<PromptSession>(b, "prompt")).not.toBe(promptA)
    expect(tabs.stateValue<PromptSession>(workspace, "prompt")).not.toBe(promptA)
    expect(promptA.current()).toHaveLength(1)
    expect(promptA.model.current()).toEqual({ providerID: "provider-a", modelID: "model-a" })
  })

  test("home promotion replaces the draft before navigating to its source server", async () => {
    const home = await tabs.ensureHomeDraft(sourceB)
    location.search = `?draftId=${home.draftID}`
    tabs.promoteDraft(home.draftID, { server: serverB, sessionId: "session-b" })
    await settled()
    const navigation = navigations.at(-1)!
    expect(navigation.href).toContain("/server/")
    expect(navigation.href).toContain("/session/session-b")
    expect(navigation.tabs).toContainEqual({ type: "session", server: serverB, sessionId: "session-b" })
    expect(navigation.tabs.some((tab) => (tab as DraftTab).draftID === home.draftID)).toBe(false)
  })

  test("late source A completion promotes only A in the background while B remains active", async () => {
    const a = await tabs.ensureHomeDraft(sourceA)
    const b = await tabs.ensureHomeDraft(sourceB)
    location.search = `?draftId=${b.draftID}`
    const scoped = bindDraftActions({ tabs, draft: a, active: () => false })
    scoped.promoteDraft(b.draftID, { server: serverB, sessionId: "actually-created-on-a" })
    await settled()
    expect(tabs.store).toContainEqual({ type: "session", server: serverA, sessionId: "actually-created-on-a" })
    expect(tabs.store).toContainEqual(b)
    expect(navigations).toEqual([])
    expect(removed).toContain(`${a.draftID}/prompt`)
    expect(removed).not.toContain(`${b.draftID}/prompt`)
  })

  test("history/archive stay open when their retained draft completes", async () => {
    for (const view of ["history", "archived"]) {
      const home = await tabs.newDraft({ ...sourceA, home: true }, undefined, undefined, { navigate: false })
      location.search = `?${view}=1&draftId=${home.draftID}`
      tabs.promoteDraft(home.draftID, { server: serverA, sessionId: `session-${view}` })
      await settled()
      expect(location.search).toContain(`${view}=1`)
    }
    expect(navigations).toEqual([])
  })

  test("rejects wrong-server and retargeted promotions without deleting the retained draft", async () => {
    const home = await tabs.ensureHomeDraft(sourceA)
    location.search = `?draftId=${home.draftID}`
    tabs.promoteDraft(home.draftID, { server: serverB, sessionId: "wrong-server" })
    await settled()
    tabs.updateDraft(home.draftID, { directory: "/other" })
    await settled()
    tabs.promoteDraft(home.draftID, { server: serverA, sessionId: "old-source" }, sourceA)
    await settled()
    expect(tabs.draft(home.draftID).directory).toBe("/other")
    expect(navigations).toEqual([])
    expect(removed).toEqual([])
  })

  test("a pending preload cannot change the selected source or navigate", async () => {
    let release!: () => void
    preload = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = tabs.ensureHomeDraft(sourceA)
    location.pathname = "/settings"
    release()
    const created = await pending
    expect(created.server).toBe(serverA)
    expect(location.pathname).toBe("/settings")
    expect(navigations).toEqual([])
  })
})
