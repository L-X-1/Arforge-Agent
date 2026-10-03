import { useLocation, useParams } from "@solidjs/router"
import { createMemo, onCleanup } from "solid-js"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import type { useSync } from "@/context/sync"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { sessionIDFromRoutePath } from "./settings-dialog-context"
import { useGlobal } from "@/context/global"
import { ServerConnection } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { ModelsProvider } from "@/context/models"
import { requireServerKey } from "@/utils/session-route"

type SettingsDialogOptions = {
  sync?: ReturnType<typeof useSync>
}

export function useSettingsDialog(defaultValue?: string, options: SettingsDialogOptions = {}) {
  const dialog = useDialog()
  const params = useParams<{ id?: string; serverKey?: string }>()
  const location = useLocation()
  const permission = usePermission()
  const global = useGlobal()
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

  onCleanup(() => {
    dead = true
  })

  return () => {
    const current = ++run
    const sessionID = params.id ?? sessionIDFromRoutePath(location.pathname)
    void import("@/components/settings-v2").then((module) => {
      if (dead || run !== current) return
      void dialog.show(() => {
        const server = targetServer()
        if (!server)
          return (
            <module.DialogSettings
              sessionID={sessionID}
              defaultValue={defaultValue}
              sync={options.sync}
              permission={permission}
            />
          )
        const key = ServerConnection.key(server)
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
        return (
          <ServerSDKProvider server={() => server}>
            <ServerSyncProvider server={() => server}>
              <ModelsProvider>
                <module.DialogSettings
                  sessionID={sessionID}
                  defaultValue={defaultValue}
                  sync={options.sync}
                  permission={targetPermission}
                />
              </ModelsProvider>
            </ServerSyncProvider>
          </ServerSDKProvider>
        )
      })
    })
  }
}

export function useSettingsCommand(options: SettingsDialogOptions = {}) {
  const command = useCommand()
  const language = useLanguage()
  const show = useSettingsDialog(undefined, options)

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
