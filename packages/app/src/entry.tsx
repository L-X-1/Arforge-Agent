// @refresh reload

import { render } from "solid-js/web"
import { Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { AppBaseProviders, AppInterface } from "@/app"
import { PrivateLogin } from "@/components/private-login"
import { type Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { handleNotificationClick } from "@/utils/notification-click"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "arforge.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => getStorage(DEFAULT_SERVER_URL_KEY)
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const decodeSession = (value: unknown) => {
  if (!value || typeof value !== "object") return { authenticated: false, mode: "private" as const }
  return {
    authenticated: "authenticated" in value && value.authenticated === true,
    mode: "mode" in value && value.mode === "users" ? ("users" as const) : ("private" as const),
  }
}

const notify: Platform["notify"] = async (title, description, href) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
  })

  notification.onclick = () => {
    handleNotificationClick(href)
    notification.close()
  }
}

const openLink: Platform["openLink"] = (url) => {
  window.open(url, "_blank")
}

const back: Platform["back"] = () => {
  window.history.back()
}

const forward: Platform["forward"] = () => {
  window.history.forward()
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_ARFORGE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_ARFORGE_SERVER_PORT ?? "4096"}`
  return location.origin
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

const platform: Platform = {
  platform: "web",
  version: pkg.version,
  openLink,
  back,
  forward,
  restart,
  notify,
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (root instanceof HTMLElement) {
  const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
  clearAuthToken()
  const server: ServerConnection.Http = {
    type: "http",
    authToken: !!auth,
    http: {
      url: getCurrentUrl(),
      ...auth,
    },
  }
  const WebEntry = () => {
    const actionParams = new URLSearchParams(location.search)
    const hasUserActionToken = actionParams.has("verify_token") || actionParams.has("reset_token")
    const [state, setState] = createStore<{
      status: "loading" | "authenticated" | "anonymous"
      mode: "private" | "users"
    }>({
      status: auth ? ("authenticated" as const) : ("loading" as "loading" | "authenticated" | "anonymous"),
      mode: "private",
    })

    onMount(async () => {
      if (auth) return
      const response = await fetch(new URL("/auth/session", getCurrentUrl()), {
        credentials: "include",
        headers: { accept: "application/json" },
      }).catch(() => undefined)
      if (!response?.ok) {
        setState("status", "anonymous")
        return
      }
      const session = decodeSession(await response.json().catch(() => undefined))
      setState({
        status:
          session.authenticated && !(session.mode === "users" && hasUserActionToken) ? "authenticated" : "anonymous",
        mode: session.mode === "users" ? "users" : "private",
      })
    })

    const logout = async () => {
      await fetch(new URL("/auth/logout", getCurrentUrl()), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }).catch(() => undefined)
      setState("status", "anonymous")
    }

    const logoutAll = async () => {
      await fetch(new URL("/auth/logout-all", getCurrentUrl()), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      }).catch(() => undefined)
      setState("status", "anonymous")
    }

    return (
      <Switch>
        <Match when={state.status === "loading"}>
          <div class="arforge-login arforge-login--loading" role="status" aria-label="Loading Arforge">
            <div class="arforge-login__loader" />
          </div>
        </Match>
        <Match when={state.status === "anonymous"}>
          <PrivateLogin
            serverUrl={getCurrentUrl()}
            mode={state.mode}
            onAuthenticated={() => setState("status", "authenticated")}
          />
        </Match>
        <Match when={state.status === "authenticated"}>
          <div class="arforge-private-app">
            <div class="arforge-private-app__session-actions">
              <button type="button" onClick={logout}>
                {state.mode === "users"
                  ? getLocale() === "zh"
                    ? "退出登录"
                    : "Sign out"
                  : getLocale() === "zh"
                    ? "锁定"
                    : "Lock"}
              </button>
              <Show when={state.mode === "users"}>
                <button type="button" onClick={logoutAll}>
                  {getLocale() === "zh" ? "退出所有设备" : "Sign out all devices"}
                </button>
              </Show>
            </div>
            <PlatformProvider value={platform}>
              <AppBaseProviders>
                <AppInterface
                  defaultServer={ServerConnection.Key.make(getDefaultUrl())}
                  canonicalLocalServer={ServerConnection.key(server)}
                  servers={[server]}
                  disableHealthCheck
                />
              </AppBaseProviders>
            </PlatformProvider>
          </div>
        </Match>
      </Switch>
    )
  }

  render(() => <WebEntry />, root)
}
