import { createEffect, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
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
import "./layout/workspace-shell.css"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const navigate = useNavigate()
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
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
      onSelect: () => narrow() ? layout.mobileSidebar.toggle() : layout.sidebar.toggle(),
    },
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: openSettings,
    },
  ])

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
    <SessionNavigationProvider>
    <div
      data-component="workspace-shell"
      data-arforge-atmosphere
      class="relative flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          debugToolsEnabled
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div class="flex min-h-0 min-w-0 flex-1">
        <TitlebarVerticalTabs />
        <WorkspaceSidebar />
        <main id="workspace-main" tabIndex={-1} class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          {props.children}
        </main>
      </div>
      {debugToolsEnabled && state.debugTools && <DebugBar inline />}
      <ToastRegion v2 />
    </div>
    </SessionNavigationProvider>
  )
}
