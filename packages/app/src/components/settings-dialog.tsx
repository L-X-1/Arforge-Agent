import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { createEffect, createMemo, lazy, onCleanup, type JSX } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import type { useSync } from "@/context/sync"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { sessionIDFromRoutePath, settingsRoute } from "./settings-dialog-context"
import { useSettings } from "@/context/settings"
import { useGlobal } from "@/context/global"
import { ServerConnection, serverName } from "@/context/server"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { ModelsProvider } from "@/context/models"
import { requireServerKey } from "@/utils/session-route"
import { SDKProvider } from "@/context/sdk"
import { createSessionOwnership } from "@/pages/session/session-ownership"
import { invalidateSessionDetails, presentSessionDetail } from "./session/session-detail-drawer"
import { sessionSettingsTab, type SessionSettingsValue } from "./session/session-settings-navigation"
import { useSessionOperationsText } from "./session/session-operations-text"

const SessionDetailPanels = lazy(async () => {
  const module = await import("./session/session-operations-dialog")
  return { default: module.SessionSettingsPanels }
})

type SettingsDialogOptions = {
  sync?: ReturnType<typeof useSync>
  presentation?: "dialog" | "detail"
}

export function useSettingsDialog(defaultValue?: string, options: SettingsDialogOptions = {}) {
  const dialog = useDialog()
  const params = useParams<{ id?: string; serverKey?: string }>()
  const location = useLocation()
  const permission = usePermission()
  const global = useGlobal()
  const serverSDK = useServerSDK()
  const sessionText = useSessionOperationsText()
  const targetServer = createMemo(() => {
    const encoded = params.serverKey
    if (!encoded) return undefined
    let key: ServerConnection.Key
    try {
      key = requireServerKey(encoded)
    } catch {
      return undefined
    }
    return global.servers.list().find((conn) => ServerConnection.key(conn) === key)
  })
  let run = 0
  let dead = false
  let activeDialog: ReturnType<typeof dialog.pushScoped> | undefined
  let activeCurrent: (() => boolean) | undefined
  const sourceOwner = createSessionOwnership(() => [
    location.pathname, serverSDK().scope,
    targetServer() ? ServerConnection.key(targetServer()!) : "",
    options.sync?.().data.path.directory ?? "",
  ].join("\n"))

  createEffect(() => {
    sourceOwner.key()
    if (activeCurrent?.() !== false) return
    activeDialog?.discard()
    activeDialog = undefined
  })

  onCleanup(() => {
    dead = true
    activeDialog?.discard()
    invalidateSessionDetails()
  })

  return () => {
    const opening = ++run
    const owner = sourceOwner.capture()
    const current = () => !dead && run === opening && owner.current()
    const sessionID = params.id ?? sessionIDFromRoutePath(location.pathname)
    const server = targetServer() ?? serverSDK().server
    const originalSync = options.sync?.()
    const sync = originalSync ? () => originalSync : undefined
    const directory = originalSync?.data.path.directory ?? ""
    const key = ServerConnection.key(server)
    const provide = (render: () => JSX.Element) => (
      <ServerSDKProvider server={() => server}>
        <ServerSyncProvider server={() => server}>
          <ModelsProvider>
            {directory ? <SDKProvider directory={directory}>{render()}</SDKProvider> : render()}
          </ModelsProvider>
        </ServerSyncProvider>
      </ServerSDKProvider>
    )
    const showFullSettings = () => {
      if (!current()) return
      void import("@/components/settings-v2").then((module) => {
        if (!current()) return
        activeDialog?.discard()
        activeCurrent = current
        activeDialog = dialog.pushScoped(() => provide(() => {
        // The modal is mounted above the route-specific ServerSyncProvider.
        // Bind permission mutations to the route's server as well; otherwise
        // a remote session can display its directory but send the setting to
        // the default local server.
        const targetPermission = {
          ...permission,
          currentServerState: () => permission.ensureServerState(key),
          isAutoAccepting: (sessionID: string, directory?: string) =>
            permission.ensureServerState(key).isAutoAccepting(sessionID, directory),
          isAutoAcceptingDirectory: (directory: string) =>
            permission.ensureServerState(key).isAutoAcceptingDirectory(directory),
          enableAutoAccept: (sessionID: string, directory: string) =>
            permission.ensureServerState(key).enableAutoAccept(sessionID, directory),
          disableAutoAccept: (sessionID: string, directory?: string) =>
            permission.ensureServerState(key).disableAutoAccept(sessionID, directory),
        }
          return <module.DialogSettings sessionID={sessionID} defaultValue={defaultValue} sync={sync} permission={targetPermission} />
        }))
      })
    }
    const ordinary = defaultValue === "session-goal-task" || defaultValue === "session-prompt-queue" || defaultValue === "session-feedback"
    if (options.presentation !== "dialog" && ordinary && sessionID && sync && directory) {
      const tab = sessionSettingsTab(defaultValue)
      const focused = document.activeElement
      const origin = focused instanceof HTMLElement && focused !== document.body && !focused.closest('[role="menu"]')
        ? focused : document.querySelector<HTMLElement>('[data-component="session-titlebar-actions"] [aria-haspopup="menu"]') ?? undefined
      if (presentSessionDetail({
        scope: owner.key, current, sessionID, directory, serverLabel: serverName(server),
        sourceCurrent: () => !dead && owner.current(),
        onClose: () => {
          if (run !== opening) return
          run++
          activeDialog?.discard()
          activeDialog = undefined
        },
        value: defaultValue as SessionSettingsValue,
        title: tab ? sessionText()[tab.label] : sessionText().title,
        origin, fullSettings: showFullSettings,
        content: (value) => provide(() => <SessionDetailPanels value={value()} sessionID={sessionID} sync={sync} />),
      })) {
        activeDialog?.discard()
        activeDialog = undefined
        return
      }
    }
    showFullSettings()
  }
}

export function useSettingsCommand(options: SettingsDialogOptions = {}) {
  const command = useCommand()
  const language = useLanguage()
  const showDialog = useSettingsDialog(undefined, options)
  const settings = useSettings()
  const location = useLocation()
  const navigate = useNavigate()
  const show = () => {
    if (settings.general.newLayoutDesigns() && options.presentation !== "dialog") {
      const origin = location.pathname + location.search
      const target = location.pathname === "/settings" ? origin : settingsRoute(sessionIDFromRoutePath(location.pathname), origin)
      navigate(target)
      return
    }
    showDialog()
  }

  command.register("settings", () => [
    {
      id: "settings.open",
      title: language.t("command.settings.open"),
      category: language.t("command.category.settings"),
      keybind: "mod+comma",
      onSelect: show,
    },
  ])

  return show
}
