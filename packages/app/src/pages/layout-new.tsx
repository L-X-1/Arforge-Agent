import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { setNavigate } from "@/utils/notification-click"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { WorkspaceSidebar } from "@/pages/layout/workspace-sidebar"
import { TitlebarVerticalTabs } from "@/components/titlebar-vertical-tabs"
import { settingsRoute } from "@/components/settings-dialog-context"
import { createMediaQuery } from "@solid-primitives/media"
import { SHELL_DRAWER_QUERY } from "./layout/workspace-shell-state"
import { SessionNavigationProvider } from "./home/session-navigation"
import { UIPresentationProvider } from "@arforge-ai/ui/context/presentation"
import { projectForSession, sortedRootSessions } from "./layout/helpers"
import { createSessionMenuCommands } from "./layout/session-menu-navigation"
import "./layout/workspace-shell.css"
import "./layout/workspace-v3.css"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const navigate = useNavigate()
  const location = useLocation()
  const settingsPage = createMemo(() => location.pathname === "/settings" || location.pathname.startsWith("/settings/"))
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const sessionSource = createMemo(() => {
    const route = layout.route()
    if (route.type !== "session") return
    const connection = global.servers.list().find((connection) => ServerConnection.key(connection) === route.server)
    if (!connection) return
    const owner = global.ensureServerCtx(connection)
    const current = owner.sync.session.peek(route.sessionId)
    if (!current) return
    const project = projectForSession(current, owner.projects.list())
    const directories = [
      ...new Set([current.directory, ...(project ? [project.worktree, ...(project.sandboxes ?? [])] : [])]),
    ]
    return { owner, server: ServerConnection.key(connection), current, directories }
  })
  let loaded: { owner: object; directories: string } | undefined
  createEffect(() => {
    const source = sessionSource()
    if (!source) {
      loaded = undefined
      return
    }
    const directories = JSON.stringify(source.directories)
    if (loaded?.owner === source.owner && loaded.directories === directories) return
    loaded = { owner: source.owner, directories }
    // Existing sync owns request lifetime and failure state; do not install another session cache.
    for (const directory of source.directories) void source.owner.sync.project.loadSessions(directory).catch(() => {})
  })
  command.register("workspace-sessions", () =>
    createSessionMenuCommands({
      previous: language.t("command.session.previous"),
      next: language.t("command.session.next"),
      category: language.t("command.category.session"),
      snapshot: () => {
        const source = sessionSource()
        if (!source) return
        return {
          ...source,
          sessions: source.directories.flatMap((directory) =>
            sortedRootSessions(source.owner.sync.child(directory, { bootstrap: false })[0], Date.now()),
          ),
        }
      },
      select: (source, session) => {
        source.owner.projects.touch(session.directory)
        tabs.select(tabs.addSessionTab({ server: source.server, sessionId: session.id }))
      },
    }),
  )
  const narrow = createMediaQuery(SHELL_DRAWER_QUERY)
  const debugToolsEnabled = import.meta.env.DEV && import.meta.env.VITE_ARFORGE_DEBUG_TOOLS === "1"
  setNavigate(navigate)
  // Keep diagnostics opt-in. The debug HUD updates on every animation frame and
  // should never be part of the default product surface users are validating.
  const [state, setState] = createStore({ debugTools: false })

  // Keep the originating Session when the workspace settings page is opened
  // from inside a Session.  Settings is a real route in the new layout, so
  // the route itself must carry the owner context instead of relying on the
  // unmounted Session header.
  const openSettings = () => {
    const route = layout.route()
    const sessionID = route.type === "session" ? route.sessionId : undefined
    navigate(settingsRoute(sessionID))
  }

  createEffect(() => setV2Toast(true))

  command.register("workspace-sidebar", () => [
    {
      id: "sidebar.toggle",
      title: language.t("command.sidebar.toggle"),
      category: language.t("command.category.view"),
      keybind: "mod+b",
      onSelect: () => (narrow() ? layout.mobileSidebar.toggle() : layout.sidebar.toggle()),
    },
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: openSettings,
    },
  ])

  command.register("workspace-diagnostics", () =>
    debugToolsEnabled
      ? [
          {
            id: "debug.tools.toggle",
            title: "切换性能诊断",
            category: "Arforge",
            onSelect: () => setState("debugTools", (value) => !value),
          },
        ]
      : [],
  )

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <UIPresentationProvider value="workspace">
      <SessionNavigationProvider>
        <div
          data-component="workspace-shell"
          data-arforge-atmosphere
          class="relative flex-1 min-h-0 min-w-0 flex flex-row select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
          style={{
            "padding-top": "env(safe-area-inset-top, 0px)",
            "padding-bottom": "env(safe-area-inset-bottom, 0px)",
          }}
        >
          <Show when={!settingsPage()}>
            <Show
              when={platform.platform === "desktop" && !narrow() && !layout.sidebar.opened()}
              fallback={<WorkspaceSidebar />}
            >
              <TitlebarVerticalTabs />
            </Show>
          </Show>
          <div data-component="workspace-primary" class="flex min-w-0 min-h-0 flex-1 flex-col">
            <Titlebar
              update={update}
              debugTools={
                debugToolsEnabled
                  ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
                  : undefined
              }
            />
            <div
              data-component="workspace-content"
              data-framed={settingsPage() ? undefined : ""}
              class="flex min-h-0 min-w-0 flex-1"
            >
              <main
                id="workspace-main"
                tabIndex={-1}
                class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict"
              >
                {props.children}
              </main>
            </div>
            {debugToolsEnabled && state.debugTools && <DebugBar inline />}
          </div>
          <ToastRegion v2 />
        </div>
      </SessionNavigationProvider>
    </UIPresentationProvider>
  )
}
