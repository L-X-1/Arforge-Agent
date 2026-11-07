import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import type { OperationsApi } from "@/utils/server"

/** Resolve the captured source before using the real tab owner; never change server defaults. */
export function useManagementSessionNavigation(api: () => OperationsApi) {
  const serverSDK = useServerSDK()
  const tabs = useTabs()
  return async (sessionID: string, location: { directory: string; workspace?: string }, current: () => boolean) => {
    const source = serverSDK()
    const bound = api()
    const server = ServerConnection.key(source.server)
    const live = () => current() && serverSDK() === source
    if (!live()) return false
    const session = await bound.sessions.get({ sessionID })
    if (!live()) return false
    if (
      session.id !== sessionID ||
      session.location.directory !== location.directory ||
      (location.workspace !== undefined && session.location.workspaceID !== location.workspace)
    )
      throw new Error("The Session no longer belongs to the inspected source.")
    const tab = tabs.addSessionTab({ server, sessionId: sessionID })
    if (!live()) return false
    tabs.select(tab)
    return true
  }
}
