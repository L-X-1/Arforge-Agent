import { createEffect, createMemo, createResource, createRoot } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useLayout, type LayoutRoute } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { SESSION_TABS_REMOVED_EVENT, readSessionTabsRemovedDetail } from "@/components/titlebar-session-events"
import { normalizeSessionInfo } from "@/utils/session"

/**
 * Shared controller for the titlebar tab surface. The v2 layout renders the
 * tab strip as a vertical rail (layout-new) while the titlebar keeps the
 * "new tab" action, so both share one instance of the session-resolving,
 * route-matching tab state instead of duplicating effects.
 *
 * The trailing `dispose` parameter is required: createRoot treats a zero-arg
 * function as unowned (no context inheritance), which would break the context
 * lookups inside this controller.
 */
export function createTitlebarTabsController(dispose?: () => void) {
  const layout = useLayout()
  const global = useGlobal()
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const command = useCommand()
  const tabsStore = tabs.store
  const tabsStoreActions = tabs

  const [session] = createResource(
    () => {
      const route = layout.route()
      if (route.type !== "session") return undefined
      const conn = global.servers
        .list()
        .find((item) => ServerConnection.key(item) === (route.server ?? server.key))
      return conn ? { route, sdk: global.ensureServerCtx(conn).sdk } : undefined
    },
    ({ route, sdk }) =>
      sdk.api.session
        .get({ sessionID: route.sessionId })
        .then(normalizeSessionInfo)
        .catch(() => {}),
  )

  const matchRoute = (route: LayoutRoute) => {
    if (route.type === "home") return
    if (route.type === "draft") {
      return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
    }
    if (route.type === "session") {
      const main = tabsStore.find(
        (item) => item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
      )
      if (main) return main
      const s = session()
      if (s?.parentID) {
        const parentID = s.parentID
        const parent = tabsStore.find(
          (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
        )
        if (parent) return parent
      }
    }
  }

  const currentTab = () => matchRoute(layout.route())

  createEffect(() => {
    const route = layout.route()
    if (!tabs.ready()) return
    const tab = currentTab()
    if (tab) {
      tabs.remember(tab)
      return
    }

    if (route.type === "session") {
      const s = session()
      if (!s) return
      const sessionId = s.parentID ?? s.id
      const next = { server: route.server ?? server.key, sessionId }
      tabsStoreActions.addSessionTab(next)
    }
  })

  makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
    const detail = readSessionTabsRemovedDetail(event)
    if (!detail) return
    tabsStoreActions.removeSessions(detail)
  })

  const openNewTab = () => {
    const route = layout.route()
    const activeSession = session()
    if (route.type === "session" && activeSession) {
      const sessionTab = {
        type: "session" as const,
        server: route.server ?? server.key,
        sessionId: activeSession.id,
      }
      const model = tabs.stateValue<import("@/context/prompt").PromptSession>(sessionTab, "prompt")?.model.current()
      tabs.newDraft({ server: sessionTab.server, directory: activeSession.directory }, "", model)
      return
    }

    const activeTab = currentTab()
    if (activeTab?.type === "draft") {
      const model = tabs.stateValue<import("@/context/prompt").PromptSession>(activeTab, "prompt")?.model.current()
      tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
      return
    }

    if (route.type === "home") {
      const selection = layout.home.selection()
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === selection.server)
      const project = conn
        ? global
            .ensureServerCtx(conn)
            .projects.list()
            .find((item) => item.worktree === selection.directory)
        : undefined
      if (conn && project) {
        tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
        return
      }
    }

    const current = layout.projects.list()[0]
    if (current) {
      tabs.newDraft({ server: server.key, directory: current.worktree }, "")
      return
    }

    const fallback = global.servers.list().flatMap((conn) => {
      const project = global.ensureServerCtx(conn).projects.list()[0]
      return project ? [{ server: ServerConnection.key(conn), project }] : []
    })[0]
    if (!fallback) return

    tabs.newDraft({ server: fallback.server, directory: fallback.project.worktree }, "")
  }

  const toggleHome = () => tabs.toggleHome({ home: layout.route().type === "home", current: currentTab() })

  command.register("titlebar-home", () => [
    {
      id: "home.toggle",
      title: language.t("home.title"),
      category: language.t("command.category.view"),
      keybind: "mod+b",
      hidden: true,
      onSelect: toggleHome,
    },
  ])

  command.register("tabs", () => {
    const current = currentTab()

    return [
      {
        id: "tab.new",
        category: "标签页",
        title: language.t("command.session.new"),
        keybind: "mod+t,mod+n",
        hidden: true,
        onSelect: openNewTab,
      },
      current && {
        id: "tab.close",
        category: "标签页",
        title: language.t("command.tab.close"),
        keybind: "mod+w",
        hidden: true,
        onSelect: () => {
          tabsStoreActions.closeTab(tabsStore.findIndex((tab) => current === tab))
        },
      },
      {
        id: "tab.reopenClosed",
        category: language.t("command.category.file"),
        title: language.t("command.tab.reopenClosed"),
        keybind: "mod+shift+t",
        onSelect: () => tabsStoreActions.reopenClosedTab(),
      },
      {
        id: `tab.prev`,
        category: "标签页",
        title: "",
        keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
        hidden: true,
        onSelect: () => {
          let index = tabsStore.findIndex((tab) => tab === currentTab())
          if (index === -1) return

          index -= 1
          if (index === -1) index = tabsStore.length - 1

          const next = tabsStore[index]
          if (next) tabs.select(next)
        },
      },
      {
        id: `tab.next`,
        category: "标签页",
        title: "",
        keybind: `mod+option+ArrowRight,ctrl+tab`,
        hidden: true,
        onSelect: () => {
          let index = tabsStore.findIndex((tab) => tab === currentTab())
          if (index === -1) return

          index += 1
          if (index === tabsStore.length) index = 0

          const next = tabsStore[index]
          if (next) tabs.select(next)
        },
      },
    ].filter((v) => v !== undefined)
  })

  return { session, currentTab, openNewTab, toggleHome }
}

let controller: ReturnType<typeof createTitlebarTabsController> | undefined

export function useTitlebarTabs() {
  return (controller ??= createRoot((dispose) => createTitlebarTabsController(dispose)))
}
