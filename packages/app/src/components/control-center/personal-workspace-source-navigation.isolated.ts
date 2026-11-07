import { afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { useTabs as UseTabs } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt-state"
import type { ServerConnection as Connection } from "@/context/server"
import { navigateToRunSource, selectRunSourceSession } from "./personal-workspace-source"
import { createScopeRequestGuard } from "@/utils/scope-request"

const serverA = "source-server-a" as Connection.Key
const serverB = "source-server-b" as Connection.Key
type Tabs = ReturnType<typeof UseTabs>
let tabs: Tabs
let TabsProvider: typeof import("@/context/tabs").TabsProvider
let dispose = () => {}
const location = { pathname: "/", search: "" }
const removed: unknown[] = []

// Same production Tabs owner and PromptSession used by the App. Only platform,
// persistence and router environment boundaries are replaced in this subprocess.
beforeAll(async () => {
  mock.module("@arforge-ai/ui/context", () => ({
    createSimpleContext: (options: { init: () => Tabs }) => ({ provider: () => { tabs = options.init() }, use: () => tabs }),
  }))
  mock.module("@/context/server", () => ({
    ServerConnection: { key: (conn: { key: string }) => conn.key },
    useServer: () => ({ key: serverA, list: [{ key: serverA }, { key: serverB }] }),
  }))
  mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ locale: () => "en" }) }))
  mock.module("@/components/preview/text-document-close-guard", () => ({ textDocumentCloseGuard: { confirm: () => true } }))
  mock.module("@/utils/new-session-route", () => ({ preloadNewSessionRoute: async () => {} }))
  mock.module("@solidjs/router", () => ({
    useLocation: () => location, useParams: () => ({}),
    useNavigate: () => (href: string) => {
      const next = new URL(href, "http://isolated.invalid")
      location.pathname = next.pathname; location.search = next.search
    },
  }))
  mock.module("@/utils/persist", () => ({
    Persist: { window: (key: string) => key, draft: (id: string, key: string) => `${id}/${key}` },
    persisted: (_key: unknown, state: unknown[]) => [...state, undefined, Object.assign(() => true, { promise: Promise.resolve() })],
    removePersisted: (key: unknown) => removed.push(key), draftPersistedKeys: () => ["prompt"],
  }))
  ;({ TabsProvider } = await import("@/context/tabs"))
})
beforeEach(() => {
  location.pathname = "/"; location.search = ""; removed.length = 0
  createRoot(cleanup => { dispose = cleanup; TabsProvider({}) })
})
afterEach(() => dispose())
const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
const run = { runID: "run_original_source", sessionID: "ses_original_source",
  source: { inspectability: "requires-navigation" as const, projectID: "global", directory: "D:/history" } }

test("manual source navigation uses production Tabs routes and returns to intact real draft text/model/attachment state", async () => {
  const model = { providerID: "provider-a", modelID: "model-a", variant: "kept" }
  const draft = await tabs.newDraft({ server: serverA, directory: "C:/current" }, "unsent draft", model)
  const other = await tabs.newDraft({ server: serverB, directory: "C:/current" }, "other server draft", undefined, { navigate: false })
  const prompt = tabs.stateValue<PromptSession>(draft, "prompt")!
  const attachment = { type: "image" as const, id: "attachment-owned", filename: "owned.png", mime: "image/png", dataUrl: "data:image/png;base64,YQ==" }
  const content = [{ type: "text" as const, content: "unsent draft", start: 0, end: 12 }, attachment]
  prompt.set(content, 7)
  prompt.model.set(model)
  location.pathname = "/settings"; location.search = "?tab=arforge-workspace"
  const reads: string[] = []
  expect(await navigateToRunSource(run, {
    current: () => true,
    getSession: async id => { reads.push("session"); return { id, projectID: "global", directory: "D:/history" } },
    getLocation: async directory => { reads.push("location"); return { projectID: "global", directory } },
    selectSession: id => selectRunSourceSession(tabs, serverA, id),
  })).toBe(true)
  await settled()
  const { sessionHref } = await import("@/utils/session-route")
  expect(location.pathname).toBe(sessionHref(serverA, run.sessionID))
  expect(reads).toEqual(["session", "location"])
  expect(tabs.store).toContainEqual({ type: "session", server: serverA, sessionId: run.sessionID })
  expect(tabs.draft(draft.draftID)).toEqual(draft)
  expect(tabs.draft(other.draftID)).toEqual(other)
  expect(tabs.stateValue<PromptSession>(draft, "prompt")).toBe(prompt)
  expect(prompt.current()).toEqual(content)
  expect(prompt.cursor()).toBe(7)
  expect(prompt.model.current()).toEqual(model)
  tabs.select(draft)
  expect(location.pathname + location.search).toBe(`/new-session?draftId=${draft.draftID}`)
  expect(tabs.stateValue<PromptSession>(draft, "prompt")?.current()).toEqual(content)
  expect(tabs.stateValue<PromptSession>(other, "prompt")?.current()).toEqual([{ type: "text", content: "other server draft", start: 0, end: 18 }])
  expect(removed).toEqual([])
})

test("delayed original-source lookup cannot navigate after server/session source changes or remove the production draft", async () => {
  const draft = await tabs.newDraft({ server: serverA, directory: "C:/current" }, "keep pending draft")
  const prompt = tabs.stateValue<PromptSession>(draft, "prompt")!
  location.pathname = "/settings"; location.search = "?tab=arforge-workspace"
  let source = "server-a/session-a"
  const guard = createScopeRequestGuard(() => source)
  const token = guard.capture()
  let release!: (value: { id: string; projectID: string; directory: string }) => void
  const read = new Promise<{ id: string; projectID: string; directory: string }>(resolve => { release = resolve })
  let locationReads = 0
  const pending = navigateToRunSource(run, {
    current: () => guard.isCurrent(token), getSession: () => read,
    getLocation: async directory => { locationReads++; return { directory, projectID: "global" } },
    selectSession: id => selectRunSourceSession(tabs, serverA, id),
  })
  source = "server-b/session-b"; guard.current()
  source = "server-a/session-a"; guard.current()
  release({ id: run.sessionID, projectID: "global", directory: "D:/history" })
  expect(await pending).toBe(false)
  expect(locationReads).toBe(0)
  expect(location.pathname).toBe("/settings")
  expect(tabs.store.some(tab => tab.type === "session")).toBe(false)
  expect(tabs.draft(draft.draftID)).toEqual(draft)
  expect(tabs.stateValue<PromptSession>(draft, "prompt")).toBe(prompt)
  expect(prompt.current()).toEqual([{ type: "text", content: "keep pending draft", start: 0, end: 18 }])
  expect(removed).toEqual([])
})
