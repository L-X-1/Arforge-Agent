import type { Session } from "@arforge-ai/sdk/v2/client"
import { createSimpleContext } from "@arforge-ai/ui/context"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted, removePersisted, draftPersistedKeys } from "@/utils/persist"
import { ServerConnection, useServer } from "./server"
import {
  batch,
  createContext,
  createEffect,
  getOwner,
  onCleanup,
  startTransition,
  useContext,
  type ParentProps,
} from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { usePlatform } from "./platform"
import { uuid } from "@/utils/uuid"
import { SessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { sessionHref } from "@/utils/session-route"
import { createTabMemory } from "./tab-memory"
import { nextTabAfterClose, pushClosedTab, removeClosedTabs, takeClosedTab, type ClosedTab } from "./closed-tabs"
import { createDraftPromptSession, type PromptModel } from "./prompt-state"
import { preloadNewSessionRoute } from "@/utils/new-session-route"
import {
  activeDraftID,
  bindDraftActions,
  createHomeDraftOwner,
  sameDraftSource,
  type DraftSource,
} from "@/pages/home-compose/home-draft-state"

export type SessionTab = {
  type: "session"
  server: ServerConnection.Key
  sessionId: string
}

export type DraftTab = {
  type: "draft"
  draftID: string
  server: ServerConnection.Key
  directory: string
  worktree?: string
  home?: boolean
}

export type Tab = SessionTab | DraftTab

export type TabInfo = {
  title?: string
  directory?: string
}

type RecentTab = {
  key?: string
}

export const draftHref = (draftID: string) => `/new-session?draftId=${encodeURIComponent(draftID)}`

export const tabHref = (tab: Tab) =>
  tab.type === "draft"
    ? tab.home
      ? `/?draftId=${encodeURIComponent(tab.draftID)}`
      : draftHref(tab.draftID)
    : sessionHref(tab.server, tab.sessionId)

export const tabKey = (tab: Tab) => (tab.type === "draft" ? `draft:${tab.draftID}` : `${tab.server}\n${tabHref(tab)}`)

export function sessionHasOpenTab(tabs: Tab[], server: ServerConnection.Key, session: Session) {
  return tabs.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === session.id)
}

const { use: useBaseTabs, provider: TabsProvider } = createSimpleContext({
  name: "Tabs",
  gate: false,
  init: () => {
    const textDraftLanguage = useTextDraftLanguage()
    const confirmFileDrafts = () =>
      textDocumentCloseGuard.confirm(undefined, textDraftLanguage.locale().startsWith("zh"))
    const server = useServer()
    const platform = usePlatform()
    const fallback = server.key
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.window("tabs"),
        migrate: (value: unknown) => {
          if (!Array.isArray(value)) return value
          return value.map((tab) => {
            if (!tab || typeof tab !== "object" || "server" in tab) return tab
            return { ...tab, server: fallback }
          })
        },
      },
      createStore<Tab[]>([]),
    )
    const [recent, setRecent, , recentReady] = persisted(Persist.window("tabs.recent"), createStore<RecentTab>({}))
    const [info, setInfo] = persisted(Persist.window("tabs.info"), createStore<Record<string, TabInfo>>({}))
    const [closed, setClosed, , closedReady] = persisted(Persist.window("tabs.closed"), createStore<ClosedTab[]>([]))

    const params = useParams()
    const navigate = useNavigate()
    const location = useLocation()
    const memory = createTabMemory(getOwner())

    const closing = new Set<string>()
    let recentWrite = 0
    let recentValue: string | undefined

    const recentKey = () => (recentWrite ? recentValue : recent.key)

    const setRecentKey = (key: string | undefined) => {
      const write = ++recentWrite
      recentValue = key
      if (recentReady()) {
        setRecent("key", key)
        return
      }
      void recentReady.promise?.then(() => {
        if (write === recentWrite) setRecent("key", key)
      })
    }

    const updateClosed = (update: (stack: ClosedTab[]) => ClosedTab[]) => {
      const apply = () => setClosed((stack) => update(stack))
      if (closedReady()) {
        apply()
        return
      }
      void closedReady.promise?.then(apply)
    }

    const removeDraftPersisted = (draftID: string) => {
      for (const key of draftPersistedKeys()) removePersisted(Persist.draft(draftID, key), platform)
    }

    const removeInfo = (key: string) => {
      if (!info[key]) return
      setInfo(
        produce((draft) => {
          delete draft[key]
        }),
      )
    }

    onCleanup(memory.dispose)

    createEffect(() => {
      if (!ready() || !recentReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = store.filter((tab) => servers.has(tab.server))
      if (next.length !== store.length) {
        for (const tab of store) {
          if (!servers.has(tab.server)) {
            const key = tabKey(tab)
            memory.remove(key)
            removeInfo(key)
          }
        }
        setStore(() => next)
      }
      if (recent.key && !next.some((tab) => tabKey(tab) === recent.key)) setRecentKey(undefined)
      const keys = new Set(next.map(tabKey))
      for (const key of Object.keys(info)) {
        if (!keys.has(key)) removeInfo(key)
      }
    })

    createEffect(() => {
      if (!closedReady()) return
      const servers = new Set(server.list.map(ServerConnection.key))
      const next = closed.filter((entry) => servers.has(entry.tab.server))
      if (next.length !== closed.length) setClosed(() => next)
    })

    const navigateTab = (tab: Tab) => {
      const href = tabHref(tab)
      setRecentKey(tabKey(tab))
      navigate(href)
    }

    const removeTab = (index: number) => {
      const tab = store[index]
      if (!tab) return
      const key = tabKey(tab)
      const draftID = tab.type === "draft" ? tab.draftID : undefined
      const activeDraft = tab.type === "draft" && activeDraftID(location.pathname, location.search) === tab.draftID
      const nextTab = nextTabAfterClose(store, index, activeDraft || (recentKey() === key && location.pathname !== "/"))
      closing.add(key)
      batch(() => {
        setStore(
          produce((tabs) => {
            tabs.splice(index, 1)
          }),
        )
        if (nextTab === null) {
          setRecentKey(undefined)
          navigate("/")
        }
        if (nextTab) navigateTab(nextTab)
      })
      queueMicrotask(() => closing.delete(key))
      memory.remove(key)
      removeInfo(key)
      if (draftID) removeDraftPersisted(draftID)
    }

    function addSessionTab(tab: Omit<SessionTab, "type">): Tab
    function addSessionTab(tab: Omit<SessionTab, "type">, expectedDraft: DraftTab | undefined): Tab | undefined
    function addSessionTab(tab: Omit<SessionTab, "type">, expectedDraft?: DraftTab): Tab | undefined {
      const next = { type: "session" as const, ...tab }
      const key = tabKey(next),
        guarded = arguments.length > 1
      const current = () =>
        !guarded ||
        (server.list.some((connection) => ServerConnection.key(connection) === tab.server) &&
          !closed.some((entry) => tabKey(entry.tab) === key) &&
          (!expectedDraft ||
            store.some(
              (entry) =>
                entry.type === "draft" &&
                entry.draftID === expectedDraft.draftID &&
                sameDraftSource(entry, expectedDraft),
            )))
      if (!current()) return
      if (closing.has(key)) return guarded ? undefined : next
      const existing = store.find((item) => tabKey(item) === key)
      if (existing) return existing
      void startTransition(() => {
        setStore(
          produce((tabs) => {
            if (!current() || closing.has(key) || tabs.some((item) => tabKey(item) === key)) return
            tabs.push(next)
          }),
        )
      })
      return next
    }

    const actions = {
      addSessionTab,
      reorder(keys: string[]) {
        setStore(
          produce((tabs) => {
            if (keys.length !== tabs.length || new Set(keys).size !== tabs.length) return
            const byKey = new Map(tabs.map((tab) => [tabKey(tab), tab]))
            const next = keys.map((key) => byKey.get(key)).filter((tab): tab is Tab => !!tab)
            if (next.length !== tabs.length) return
            tabs.splice(0, tabs.length, ...next)
          }),
        )
      },
      draft(draftID: string) {
        const tab = store.find((item) => item.type === "draft" && item.draftID === draftID)
        if (!tab || tab.type !== "draft") throw new Error(`Draft not found: ${draftID}`)
        return tab
      },
      async newDraft(
        draft: Omit<DraftTab, "type" | "draftID">,
        prompt?: string,
        model?: PromptModel,
        options?: { navigate?: boolean },
      ) {
        await ready.promise
        await preloadNewSessionRoute()
        if (!server.list.some((conn) => ServerConnection.key(conn) === draft.server))
          throw new Error("Draft server was removed")
        const draftID = uuid()
        const tab = { type: "draft" as const, draftID, ...draft }
        memory.ensure(tabKey(tab), "prompt", () => createDraftPromptSession(draftID, { prompt, model }))
        await startTransition(() => {
          setStore(
            produce((tabs) => {
              tabs.push(tab)
            }),
          )
          if (options?.navigate !== false) navigate(tabHref(tab))
        })
        return tab
      },
      updateDraft(draftID: string, draft: Partial<Omit<DraftTab, "type" | "draftID">>) {
        void startTransition(() => {
          setStore(
            (tab) => tab.type === "draft" && tab.draftID === draftID,
            produce((tab) => Object.assign(tab, draft)),
          )
        })
      },
      promoteDraft(
        draftID: string,
        session: Omit<SessionTab, "type">,
        expected?: DraftSource,
        canNavigate?: () => boolean,
        canConsume?: () => boolean,
      ) {
        // Keep the replacement and navigation atomic so /new-session never renders
        // after its backing draft tab has been removed from the store.
        const next = { type: "session" as const, ...session }
        let promoted = false
        return startTransition(() => {
          const original = store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === draftID)
          if (!original || original.server !== session.server || (expected && !sameDraftSource(original, expected)))
            return
          if (
            canConsume &&
            (!server.list.some((connection) => ServerConnection.key(connection) === next.server) ||
              closing.has(tabKey(next)) ||
              closed.some((entry) => tabKey(entry.tab) === tabKey(next)))
          )
            return
          if (canConsume && !canConsume()) return
          const active = activeDraftID(location.pathname, location.search) === draftID && (canNavigate?.() ?? true)
          setStore(
            produce((tabs) => {
              for (let i = tabs.length - 1; i >= 0; i--) {
                const tab = tabs[i]
                if (tab.type === "session" && tab.server === next.server && tab.sessionId === next.sessionId)
                  tabs.splice(i, 1)
              }
              const index = tabs.findIndex((tab) => tab.type === "draft" && tab.draftID === draftID)
              if (index !== -1) tabs[index] = next
            }),
          )
          promoted = true
          if (recent.key === `draft:${draftID}`) setRecentKey(tabKey(next))
          if (active) navigateTab(next)
        }).finally(() => {
          if (!promoted) return
          memory.remove(`draft:${draftID}`)
          removeDraftPersisted(draftID)
        })
      },
      removeTab(index: number) {
        if (!store[index] || !confirmFileDrafts()) return
        removeTab(index)
      },
      // User-initiated close: records the tab so it can be reopened.
      // Cleanup paths (missing sessions, archive, server removal) go through
      // removeTab and friends directly and are not recorded.
      closeTab(index: number) {
        const tab = store[index]
        if (!tab || !confirmFileDrafts()) return
        if (tab.type === "session") updateClosed((stack) => pushClosedTab(stack, tab, index))
        removeTab(index)
      },
      reopenClosedTab() {
        if (!closedReady()) {
          void closedReady.promise?.then(() => actions.reopenClosedTab())
          return
        }
        const result = takeClosedTab(closed, store)
        if (result.stack.length === closed.length) return
        setClosed(() => result.stack)
        const entry = result.entry
        if (!entry) return
        const index = Math.min(entry.index, store.length)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              if (tabs.some((item) => tabKey(item) === tabKey(entry.tab))) return
              tabs.splice(index, 0, entry.tab)
            }),
          )
          navigateTab(entry.tab)
        })
      },
      removeSessionTab(input: Omit<SessionTab, "type">) {
        updateClosed((stack) => removeClosedTabs(stack, input.server, [input.sessionId]))
        const index = store.findIndex(
          (tab) => tab.type === "session" && tab.server === input.server && tab.sessionId === input.sessionId,
        )
        if (index !== -1) removeTab(index)
      },
      removeServer(key: ServerConnection.Key) {
        updateClosed((stack) => stack.filter((entry) => entry.tab.server !== key))
        const drafts = store.flatMap((tab) => (tab.type === "draft" && tab.server === key ? [tab.draftID] : []))
        const removed = store.filter((tab) => tab.server === key).map(tabKey)
        setStore((tabs) => tabs.filter((tab) => tab.server !== key))
        for (const key of removed) memory.remove(key)
        for (const key of removed) removeInfo(key)
        if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        for (const draftID of drafts) removeDraftPersisted(draftID)
        if (server.key === key) navigate("/")
      },
      removeSessions: (input: SessionTabsRemovedDetail) => {
        const targetServer = input.server ?? server.key
        updateClosed((stack) => removeClosedTabs(stack, targetServer, input.sessionIDs))
        const removed = store
          .filter(
            (tab) => tab.type === "session" && tab.server === targetServer && input.sessionIDs.includes(tab.sessionId),
          )
          .map(tabKey)
        void startTransition(() => {
          setStore(
            produce((tabs) => {
              const sessionIDs = new Set(input.sessionIDs)
              const currentHref =
                targetServer === server.key && params.dir && params.id
                  ? tabHref({
                      type: "session",
                      server: targetServer,
                      sessionId: params.id,
                    })
                  : undefined
              const currentIndex = tabs.findIndex(
                (tab) =>
                  tab.type === "session" &&
                  tab.server === targetServer &&
                  (tabHref(tab) === location.pathname || (!!currentHref && tabHref(tab) === currentHref)),
              )
              const currentTab = tabs[currentIndex]
              const removedCurrent =
                currentTab?.type === "session" &&
                currentTab.server === targetServer &&
                sessionIDs.has(currentTab.sessionId)

              for (let i = tabs.length - 1; i >= 0; i--) {
                const tab = tabs[i]
                if (!tab || tab.type !== "session") continue
                if (tab.server !== targetServer) continue
                if (!sessionIDs.has(tab.sessionId)) continue
                tabs.splice(i, 1)
              }

              if (!removedCurrent) return
              const nextTab =
                tabs.slice(currentIndex).find((tab) => tab.type === "session") ??
                tabs.slice(0, currentIndex).findLast((tab) => tab.type === "session")
              if (nextTab) navigateTab(nextTab)
              else navigate("/")
            }),
          )
          if (recent.key && removed.includes(recent.key)) setRecentKey(undefined)
        }).finally(() => {
          for (const key of removed) memory.remove(key)
          for (const key of removed) removeInfo(key)
        })
      },
      rememberSessionInfo(tab: SessionTab, session: Session) {
        const key = tabKey(tab)
        const next = { title: session.title, directory: session.directory }
        const current = info[key]
        if (current?.title === next.title && current.directory === next.directory) return
        setInfo(key, next)
      },
      select: navigateTab,
      remember(tab: Tab) {
        const key = tabKey(tab)
        if (recentKey() !== key) setRecentKey(key)
      },
      toggleHome(input: { home: boolean; current?: Tab }) {
        if (input.home) {
          const tab = store.find((tab) => tabKey(tab) === recentKey())
          if (tab) navigateTab(tab)
          return
        }
        if (input.current) {
          setRecentKey(tabKey(input.current))
          navigate("/")
          return
        }
        navigate("/")
      },
      state<T>(tab: Tab, name: string, init: () => T) {
        return memory.ensure(tabKey(tab), name, init)
      },
      stateValue<T>(tab: Tab, name: string) {
        return memory.get<T>(tabKey(tab), name)
      },
    }

    const ensureHomeDraft = createHomeDraftOwner({
      ready: async () => {
        await ready.promise
      },
      list: () => store,
      create: (source) => actions.newDraft({ ...source, home: true }, undefined, undefined, { navigate: false }),
    })
    return { ...actions, ensureHomeDraft, store, info, ready, recentReady }
  },
})

export { TabsProvider }
type TabsContext = ReturnType<typeof useBaseTabs>
const DraftTabsContext = createContext<TabsContext>()
export function useTabs(): TabsContext {
  return useContext(DraftTabsContext) ?? useBaseTabs()
}

export function DraftTabsScopeProvider(
  props: ParentProps<{
    draft: DraftTab
    active: () => boolean
    retarget?: (source: DraftSource) => void
  }>,
) {
  const tabs = useTabs()
  const bound = bindDraftActions({ tabs, draft: props.draft, active: props.active, retarget: props.retarget })
  return <DraftTabsContext.Provider value={{ ...tabs, ...bound }}>{props.children}</DraftTabsContext.Provider>
}
import { textDocumentCloseGuard } from "@/components/preview/text-document-close-guard"
import { useLanguage as useTextDraftLanguage } from "./language"
