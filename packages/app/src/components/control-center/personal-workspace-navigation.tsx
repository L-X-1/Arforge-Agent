import { useTabs } from "@/context/tabs"
import { ServerConnection, serverName } from "@/context/server"
import type { ServerSDK } from "@/context/server-sdk"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { PersonalWorkspace } from "./personal-workspace"
import { navigateToRunSource, selectRunSourceSession } from "./personal-workspace-source"

/** Uses the existing tab router; adding/selecting a session never closes a draft. */
export function PersonalWorkspaceNavigation(props: Parameters<typeof PersonalWorkspace>[0] & {
  sdk: ServerSDK
  live: () => boolean
}) {
  const tabs = useTabs()
  const dialog = useDialog()
  const source = props.sdk
  const key = ServerConnection.key(source.server)
  return <PersonalWorkspace {...props} serverName={serverName(source.server)} onOpenSource={(run, current) => navigateToRunSource(run, {
    current: () => props.live() && props.sdk === source && current(),
    getSession: async (sessionID) => {
      const session = await props.api().sessions.get({ sessionID })
      return { id: session.id, projectID: session.projectID, directory: session.location.directory }
    },
    getLocation: async (directory) => {
      const location = await props.api().location.get({ location: { directory } })
      return { directory: location.directory, projectID: location.project.id }
    },
    selectSession: (sessionID) => selectRunSourceSession(tabs, key, sessionID, () => dialog.close()),
  })} />
}
