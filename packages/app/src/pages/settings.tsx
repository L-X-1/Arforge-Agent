import { usePermission } from "@/context/permission"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { SettingsWorkspace } from "@/components/settings-v2"
import { settingsSectionTarget, settingsTabValue } from "@/components/settings-v2/navigation"
import { settingsReturnTarget } from "@/components/settings-dialog-context"
import { SettingsServerDataProviders } from "@/components/settings-server-picker"
import { ManagementStatus } from "@/components/settings-v2/management-status"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { requireServerKey } from "@/utils/session-route"

export default function SettingsPage() {
  const tabs = useTabs()
  const global = useGlobal()
  const language = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  let root!: HTMLDivElement
  const [search, setSearch] = useSearchParams<{ tab?: string; sessionID?: string; returnTo?: string }>()
  const origin = createMemo(() => {
    const target = settingsReturnTarget(search.returnTo)
    const segment = target?.match(/^\/server\/([^/]+)\/session\//)?.[1]
    if (!segment) return { target, key: undefined, invalid: false }
    try { return { target, key: requireServerKey(segment), invalid: false } }
    catch { return { target, key: undefined, invalid: true } }
  })
  const server = createMemo(() => global.servers.list().find(item => ServerConnection.key(item) === origin().key))
  const returnToWorkspace = () => {
    const target = origin().target
    if (target && !origin().invalid) navigate(target)
    else tabs.toggleHome({ home: true })
  }
  const changeTab = (tab: string) => setSearch({ tab }, { replace: true, scroll: false })
  createEffect(() => {
    const target = settingsSectionTarget(search.tab, location.hash)
    if (!target || !search.sessionID) return
    const reveal = () => {
      const section = root.querySelector<HTMLElement>(`#${target}`)
      if (!section) return false
      section.scrollIntoView({ block: "start", behavior: "auto" })
      return true
    }
    if (reveal()) return
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
    observer.observe(root, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })
  return (
    <div
      ref={root}
      data-component="settings-page"
      data-settings-navigation="dedicated"
      data-arforge-material="main"
      class="relative min-h-0 flex-1 self-stretch overflow-hidden rounded-[16px]"
    >
      <Show when={origin().key || origin().invalid} fallback={
        <SourceSettingsWorkspace sessionID={search.sessionID} tab={search.tab} onTabChange={changeTab} onReturn={returnToWorkspace} />
      }>
        <Show when={!origin().invalid && server()} keyed fallback={
          <div class="settings-v2-surface settings-v2-tab-body">
            <button type="button" class="settings-v2-return" onClick={returnToWorkspace}>
              {language.locale().startsWith("zh") ? "返回工作区" : "Back to workspace"}
            </button>
            <ManagementStatus readOnly={language.locale().startsWith("zh")
              ? "原服务器连接已不可用，请返回原工作区核对连接。"
              : "The originating server connection is unavailable. Return to the workspace to review it."} />
          </div>
        }>{source => (
          <SettingsServerDataProviders server={source}>
            <SourceSettingsWorkspace sessionID={search.sessionID} tab={search.tab} onTabChange={changeTab} onReturn={returnToWorkspace} />
          </SettingsServerDataProviders>
        )}</Show>
      </Show>
    </div>
  )
}

function SourceSettingsWorkspace(props: { sessionID?: string; tab?: string; onTabChange: (tab: string) => void; onReturn: () => void }) {
  const permission = usePermission()
  const sdk = useServerSDK()
  const originatingSource = sdk()
  const sessionID = () => sdk() === originatingSource ? props.sessionID : undefined
  const serverKey = () => ServerConnection.key(sdk().server)
  const sourcePermission = {
    ...permission,
    currentServerState: () => permission.ensureServerState(serverKey()),
    isAutoAccepting: (id: string, directory?: string) => permission.ensureServerState(serverKey()).isAutoAccepting(id, directory),
    isAutoAcceptingDirectory: (directory: string) => permission.ensureServerState(serverKey()).isAutoAcceptingDirectory(directory),
    enableAutoAccept: (id: string, directory: string) => permission.ensureServerState(serverKey()).enableAutoAccept(id, directory),
    disableAutoAccept: (id: string, directory?: string) => permission.ensureServerState(serverKey()).disableAutoAccept(id, directory),
  }
  return <SettingsWorkspace permission={sourcePermission} sessionID={sessionID()} defaultValue={settingsTabValue(props.tab)}
    onTabChange={props.onTabChange} onReturnToWorkspace={props.onReturn} />
}
