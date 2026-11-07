import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { DropdownMenu } from "@arforge-ai/ui/dropdown-menu"
import { IconButtonV2 } from "@arforge-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"

type SessionActions = {
  mode: "private" | "users"
  serverURL: string
  logout: () => Promise<void>
  logoutAll: () => Promise<void>
}
const [sessionActions, setSessionActions] = createStore<{ owner?: symbol; value?: SessionActions; hosts: number }>({
  hosts: 0,
})

/** Auth remains owned by WebEntry; workspace menus only present its original actions. */
export function WebSessionActionsOwner(props: SessionActions & { chinese: boolean }) {
  let owner = Symbol("web-session-actions")
  createEffect(() => {
    const value = { mode: props.mode, serverURL: props.serverURL, logout: props.logout, logoutAll: props.logoutAll }
    owner = Symbol("web-session-actions")
    setSessionActions({ owner, value })
  })
  onCleanup(() => {
    if (sessionActions.owner === owner) setSessionActions({ owner: undefined, value: undefined })
  })
  return (
    <Show when={sessionActions.hosts === 0}>
      <div class="arforge-private-app__session-actions">
        <button type="button" onClick={() => void props.logout()}>
          {props.mode === "users" ? (props.chinese ? "退出登录" : "Sign out") : props.chinese ? "锁定" : "Lock"}
        </button>
        <Show when={props.mode === "users"}>
          <button type="button" onClick={() => void props.logoutAll()}>
            {props.chinese ? "退出所有设备" : "Sign out all devices"}
          </button>
        </Show>
      </div>
    </Show>
  )
}

export function WebSessionActionsMenu() {
  const language = useLanguage()
  const [request, setRequest] = createStore({ pending: false, error: "" })
  createEffect(() => {
    sessionActions.owner
    setRequest({ pending: false, error: "" })
  })
  const text = (zh: string, en: string) => (language.locale().startsWith("zh") ? zh : en)
  onMount(() => setSessionActions("hosts", (n) => n + 1))
  onCleanup(() => setSessionActions("hosts", (n) => Math.max(0, n - 1)))
  const run = async (all = false) => {
    const captured = sessionActions.owner
    const actions = sessionActions.value
    if (!captured || !actions || request.pending) return
    setRequest({ pending: true, error: "" })
    try {
      await (all ? actions.logoutAll() : actions.logout())
    } catch {
      if (sessionActions.owner === captured)
        setRequest("error", text("操作未完成，请重试。", "The request did not complete. Try again."))
    } finally {
      if (sessionActions.owner === captured) setRequest("pending", false)
    }
  }
  const serverLabel = (url: string) => {
    try {
      return new URL(url).host
    } catch {
      return text("Web 会话", "Web session")
    }
  }
  return (
    <Show when={sessionActions.value}>
      {(actions) => (
        <DropdownMenu gutter={8} modal={false} placement="bottom-end">
          <DropdownMenu.Trigger
            as={IconButtonV2}
            type="button"
            variant="ghost-muted"
            class="shrink-0"
            data-action="web-session-security"
            aria-label={text("会话安全", "Session security")}
            title={text("会话安全", "Session security")}
            icon={
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
                <path
                  d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7.5h9v6h-9zM8 10v1"
                  stroke="currentColor"
                  stroke-width="1.2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            }
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content aria-label={text("Web 会话安全", "Web session security")}>
              <DropdownMenu.Group>
                <DropdownMenu.GroupLabel>{text("Web 会话", "Web session")}</DropdownMenu.GroupLabel>
                <div class="px-3 pb-2 text-[12px] text-v2-text-text-muted break-all">
                  {serverLabel(actions().serverURL)}
                </div>
                <DropdownMenu.Item disabled={request.pending} closeOnSelect={false} onSelect={() => void run()}>
                  {actions().mode === "users" ? text("退出登录", "Sign out") : text("锁定", "Lock")}
                </DropdownMenu.Item>
                <Show when={actions().mode === "users"}>
                  <DropdownMenu.Item disabled={request.pending} closeOnSelect={false} onSelect={() => void run(true)}>
                    {text("退出所有设备", "Sign out all devices")}
                  </DropdownMenu.Item>
                </Show>
              </DropdownMenu.Group>
              <Show when={request.error}>
                <p role="alert" class="px-3 py-2 text-[12px]">
                  {request.error}
                </p>
              </Show>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      )}
    </Show>
  )
}
