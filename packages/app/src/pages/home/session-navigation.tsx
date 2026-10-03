import type { Session } from "@arforge-ai/sdk/v2/client"
import { createSimpleContext } from "@arforge-ai/ui/context"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { Dialog } from "@arforge-ai/ui/dialog"
import { Icon as IconV2 } from "@arforge-ai/ui/v2/icon"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@arforge-ai/ui/v2/menu-v2"
import { createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, serverName } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { Persist, persisted } from "@/utils/persist"
import { normalizeSessionInfo } from "@/utils/session"
import { createCompatibleApi } from "@/utils/server-compat"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import { navigationPinTargets, navigationSessionKey, runNavigationRequest, type NavigationTarget } from "../layout/workspace-shell-state"

type NavigationAction = "rename" | "share" | "fork"
type Target = { server: ServerConnection.Key; session: Session }

function useNavigationCopy() {
  const language = useLanguage()
  return createMemo(() => language.locale() === "zh" || language.locale() === "zht"
    ? {
        pin: "固定会话", unpin: "取消固定", rename: "重命名", share: "分享会话", fork: "创建会话分支",
        name: "会话名称", cancel: "取消", save: "保存名称", publish: "发布分享链接",
        publishDescription: "发布后，持有链接的人可以查看这段会话。请先确认其中没有不适合分享的内容。",
        forkDescription: "复制当前会话已有内容到新分支，原会话和文件保持不变。",
        copy: "复制链接", copied: "已复制", view: "查看分享", unshare: "取消分享",
        disabled: "当前工作区已禁用分享。", noServer: "来源服务器已不可用。",
        failed: "操作失败，请重试。", noURL: "服务器没有返回分享链接。",
      }
    : {
        pin: "Pin session", unpin: "Unpin session", rename: "Rename", share: "Share session", fork: "Fork session",
        name: "Session name", cancel: "Cancel", save: "Save name", publish: "Publish share link",
        publishDescription: "Anyone with the published link can view this session. Review its contents before sharing.",
        forkDescription: "Copy the existing conversation into a new branch. The original session and files stay unchanged.",
        copy: "Copy link", copied: "Copied", view: "View share", unshare: "Unpublish",
        disabled: "Sharing is disabled for this workspace.", noServer: "The source server is unavailable.",
        failed: "The operation failed. Try again.", noURL: "The server did not return a share link.",
      })
}

export const { use: useSessionNavigation, provider: SessionNavigationProvider } = createSimpleContext({
  name: "SessionNavigation",
  gate: false,
  init: () => {
    const global = useGlobal()
    const dialog = useDialog()
    const tabs = useTabs()
    const copy = useNavigationCopy()
    const [pins, setPins, , ready] = persisted(
      Persist.window("shell.session-pins.v1"),
      createStore({ values: {} as Record<string, boolean>, targets: {} as Record<string, NavigationTarget> }),
    )
    const key = (target: Target) => navigationSessionKey({
      server: target.server, directory: target.session.directory, sessionID: target.session.id,
    })
    const pinned = (target: Target) => !!pins.values[key(target)]
    const targets = createMemo(() => navigationPinTargets(pins.values, pins.targets))
    const openAction = (mode: NavigationAction, target: Target) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === target.server)
      if (!conn) {
        showToast({ title: copy().noServer, variant: "error" })
        return
      }
      const ctx = global.ensureServerCtx(conn)
      // Snapshot the originating session; never obtain a new target after await.
      const session = { ...target.session }
      const server = target.server
      const scope = { server, directory: session.directory, sessionID: session.id }
      void dialog.show(() => <SessionNavigationDialog
        mode={mode}
        session={session}
        source={serverName(conn)}
        run={async (value, current) => {
          if (!global.servers.list().some((item) => ServerConnection.key(item) === server)) {
            throw new Error(copy().noServer)
          }
          if (mode === "rename") {
            await runNavigationRequest(scope, (origin) =>
              ctx.sdk.api.session.rename({ sessionID: origin.sessionID, directory: origin.directory, title: value }),
              () => {
                const latest = ctx.sync.session.peek(session.id) ?? session
                ctx.sync.session.remember({ ...latest, title: value })
                const tab = { type: "session" as const, server, sessionId: session.id }
                tabs.rememberSessionInfo(tab, { ...latest, title: value })
              },
            )
            return
          }
          if (mode === "fork") {
            // A directory SDK retains the V1 compatibility location as well as
            // the explicit server identity used by the current protocol.
            const api = createCompatibleApi({
              protocol: ctx.sdk.protocol,
              current: ctx.sdk.currentApi,
              legacy: (directory) => ctx.sdk.createClient({ directory: directory ?? session.directory, throwOnError: true }),
              directory: session.directory,
            })
            const forked = normalizeSessionInfo(await api.session.fork({ sessionID: session.id }))
            ctx.sync.session.remember(forked)
            if (current()) {
              const tab = tabs.addSessionTab({ server, sessionId: forked.id })
              tabs.select(tab)
            }
            return
          }
          const child = ctx.sync.child(session.directory)[0]
          if (child.config.share === "disabled") throw new Error(copy().disabled)
          if (session.share?.url) return session.share.url
          const result = await ctx.sdk.client.session.share({ sessionID: session.id, directory: session.directory })
          const url = result.data?.share?.url
          if (!url) throw new Error(copy().noURL)
          ctx.sync.session.remember({ ...(ctx.sync.session.peek(session.id) ?? session), share: { url } })
          return url
        }}
        unshare={async () => {
          await ctx.sdk.client.session.unshare({ sessionID: session.id, directory: session.directory })
          ctx.sync.session.remember({ ...(ctx.sync.session.peek(session.id) ?? session), share: undefined })
        }}
      />)
    }
    return {
      pinned,
      targets,
      ready,
      togglePin(target: Target) {
        if (!ready()) return
        const id = key(target)
        const enabled = !pins.values[id]
        setPins("targets", id, { server: target.server, directory: target.session.directory, sessionID: target.session.id })
        setPins("values", id, enabled)
      },
      openAction,
      copy,
    }
  },
})

export function SessionNavigationMenu(props: Target & { onArchive: () => Promise<void>; onAction?: () => void }) {
  const navigation = useSessionNavigation()
  const language = useLanguage()
  const [state, setState] = createStore({ busy: false })
  const open = (mode: NavigationAction) => {
    const target = { server: props.server, session: props.session }
    props.onAction?.()
    navigation.openAction(mode, target)
  }
  return (
    <MenuV2 placement="bottom-end" gutter={6} modal={false}>
      <MenuV2.Trigger
        as={IconButtonV2}
        type="button"
        data-action="session-navigation-menu"
        variant="ghost-muted"
        size="large"
        icon={<IconV2 name="outline-dots" />}
        aria-label={language.t("common.moreOptions") + ": " + (sessionTitle(props.session.title) || props.session.id)}
      />
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.CheckboxItem
            checked={navigation.pinned(props)}
            disabled={!navigation.ready()}
            onChange={() => navigation.togglePin(props)}
          >
            {navigation.pinned(props) ? navigation.copy().unpin : navigation.copy().pin}
          </MenuV2.CheckboxItem>
          <MenuV2.Item onSelect={() => open("rename")}>{navigation.copy().rename}</MenuV2.Item>
          <MenuV2.Item onSelect={() => open("share")}>{navigation.copy().share}</MenuV2.Item>
          <MenuV2.Item onSelect={() => open("fork")}>{navigation.copy().fork}</MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item disabled={state.busy} onSelect={async () => {
            if (state.busy) return
            setState("busy", true)
            try { await props.onArchive() } finally { setState("busy", false) }
          }}>{language.t("common.archive")}</MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}

function SessionNavigationDialog(props: {
  mode: NavigationAction
  session: Session
  source: string
  run: (value: string, current: () => boolean) => Promise<string | void>
  unshare: () => Promise<void>
}) {
  const dialog = useDialog()
  const platform = usePlatform()
  const copy = useNavigationCopy()
  const [state, setState] = createStore({
    value: props.session.title, busy: false, error: "", url: "", copied: false,
  })
  let alive = true
  onCleanup(() => { alive = false })
  const title = () => copy()[props.mode]
  const submit = async () => {
    if (state.busy || (props.mode === "rename" && !state.value.trim())) return
    setState({ busy: true, error: "" })
    try {
      const url = await props.run(state.value.trim(), () => alive)
      if (!alive) return
      if (url) setState("url", url)
      else dialog.close()
    } catch (error) {
      if (alive) setState("error", error instanceof Error ? error.message : copy().failed)
    } finally {
      if (alive) setState("busy", false)
    }
  }
  return (
    <Dialog title={title()} description={props.source + " / " + props.session.directory}>
      <form class="workspace-session-dialog" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <Show when={props.mode === "rename"} fallback={
          <p>{props.mode === "share" ? copy().publishDescription : copy().forkDescription}</p>
        }>
          <label>
            <span>{copy().name}</span>
            <input
              autofocus
              value={state.value}
              disabled={state.busy}
              onInput={(event) => setState("value", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.isComposing || event.keyCode === 229)) event.preventDefault()
              }}
            />
          </label>
        </Show>
        <Show when={state.error}><p role="alert">{state.error}</p></Show>
        <Show when={state.url} fallback={
          <div class="workspace-session-dialog__actions">
            <button type="button" onClick={() => dialog.close()}>{copy().cancel}</button>
            <button type="submit" disabled={state.busy || (props.mode === "rename" && !state.value.trim())} aria-busy={state.busy}>
              {props.mode === "rename" ? copy().save : props.mode === "share" ? copy().publish : copy().fork}
            </button>
          </div>
        }>
          <label><span>{copy().share}</span><input readonly value={state.url} onFocus={(event) => event.currentTarget.select()} /></label>
          <div class="workspace-session-dialog__actions">
            <button type="button" onClick={async () => {
              try {
                await navigator.clipboard.writeText(state.url)
                if (alive) setState("copied", true)
              } catch (error) {
                if (alive) setState("error", error instanceof Error ? error.message : copy().failed)
              }
            }}>{state.copied ? copy().copied : copy().copy}</button>
            <button type="button" onClick={() => platform.openLink(state.url)}>{copy().view}</button>
            <button type="button" disabled={state.busy} onClick={async () => {
              if (state.busy) return
              setState({ busy: true, error: "" })
              try {
                await props.unshare()
                if (alive) dialog.close()
              } catch (error) {
                if (alive) setState("error", error instanceof Error ? error.message : copy().failed)
              } finally {
                if (alive) setState("busy", false)
              }
            }}>{copy().unshare}</button>
          </div>
        </Show>
      </form>
    </Dialog>
  )
}
