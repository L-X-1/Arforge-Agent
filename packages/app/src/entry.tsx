// @refresh reload

import { render } from "solid-js/web"
import { Match, onCleanup, onMount, Switch } from "solid-js"
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
import { WebSessionActionsOwner } from "./components/web-session-actions"

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

type SessionPrincipal = { userId: string; tenantId: string }

const decodeId = (value: unknown) => {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id
}

const decodeSession = (
  value: unknown,
):
  | { authenticated?: boolean; sessionRequired?: boolean; mode?: "private" | "users"; principal?: SessionPrincipal }
  | undefined => {
  if (!value || typeof value !== "object") return
  const mode = "mode" in value ? value.mode : undefined
  const userId = mode === "users" && "user" in value ? decodeId(value.user) : undefined
  const tenantId = mode === "users" && "tenant" in value ? decodeId(value.tenant) : undefined
  return {
    authenticated:
      "authenticated" in value && typeof value.authenticated === "boolean" ? value.authenticated : undefined,
    sessionRequired:
      "sessionRequired" in value && typeof value.sessionRequired === "boolean" ? value.sessionRequired : undefined,
    mode: mode === "users" || mode === "private" ? mode : undefined,
    principal: userId && tenantId ? { userId, tenantId } : undefined,
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
      sessionRequired?: boolean
    }>({
      status: auth ? "authenticated" : "loading",
      mode: "private",
    })
    const sessionURL = new URL("/auth/session", server.http.url)
    let channel: BroadcastChannel | undefined
    let sessionCheck: { controller: AbortController; signingIn: boolean } | undefined
    let principal: SessionPrincipal | undefined
    let generation = 0
    let disposed = false

    const invalidateSessionChecks = () => {
      generation++
      sessionCheck?.controller.abort()
      sessionCheck = undefined
    }

    const retireSession = (mode = state.mode) => {
      invalidateSessionChecks()
      principal = undefined
      setState({ status: "anonymous", mode })
    }

    const fetchSession = (signal: AbortSignal) =>
      fetch(sessionURL, {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal,
      }).catch(() => undefined)

    const checkSession = async (reason: "passive" | "refresh" | "login" | "late-logout" = "passive") => {
      if (auth || disposed || (state.status === "authenticated" && !state.sessionRequired)) return
      const loading = state.status === "loading"
      const signingIn = reason === "login" || sessionCheck?.signingIn === true
      if (state.status === "anonymous" && !signingIn && reason !== "late-logout") return
      if (sessionCheck && reason === "passive") return
      sessionCheck?.controller.abort()
      const check = { controller: new AbortController(), signingIn }
      sessionCheck = check
      const { signal } = check.controller
      let response = await fetchSession(signal)
      if (!response && reason !== "passive" && !signal.aborted) response = await fetchSession(signal)
      const session = response?.ok ? decodeSession(await response.json().catch(() => undefined)) : undefined
      if (sessionCheck !== check) return
      sessionCheck = undefined

      if (loading || signingIn) {
        const users = session?.mode === "users" || (signingIn && state.mode === "users")
        const authenticated = session?.authenticated === true && (!users || !!session.principal)
        const enterWorkspace = authenticated && !(loading && users && hasUserActionToken)
        if (signingIn && !enterWorkspace) return
        principal = enterWorkspace ? session?.principal : undefined
        setState({
          status: enterWorkspace ? "authenticated" : "anonymous",
          mode: session?.mode ?? "private",
          sessionRequired: session?.sessionRequired ?? (signingIn ? (state.sessionRequired ?? true) : undefined),
        })
        return
      }
      if (state.status !== "authenticated") return
      const replacement =
        session?.authenticated === true &&
        principal &&
        session.principal &&
        (session.principal.userId !== principal.userId || session.principal.tenantId !== principal.tenantId)
      if (replacement || (session?.authenticated === false && session.sessionRequired === true))
        retireSession(session?.mode)
    }

    const checkOnFocus = () => {
      if (document.visibilityState === "visible") void checkSession()
    }
    const checkOnPageShow = (event: PageTransitionEvent) => {
      if (document.visibilityState === "visible") void checkSession(event.persisted ? "refresh" : "passive")
    }
    onMount(() => {
      if (auth) return
      window.addEventListener("focus", checkOnFocus)
      window.addEventListener("pageshow", checkOnPageShow)
      document.addEventListener("visibilitychange", checkOnFocus)
      void checkSession()
      if (typeof BroadcastChannel === "function") {
        try {
          channel = new BroadcastChannel(`arforge:web-session:${sessionURL.origin}`)
        } catch {
          return
        }
        channel.onmessage = (event) => {
          // An earlier read may still reflect the cookie from before the peer changed it.
          if (event.data === "logout" || event.data === "login") void checkSession("refresh")
        }
      }
    })
    onCleanup(() => {
      disposed = true
      invalidateSessionChecks()
      channel?.close()
      channel = undefined
      window.removeEventListener("focus", checkOnFocus)
      window.removeEventListener("pageshow", checkOnPageShow)
      document.removeEventListener("visibilitychange", checkOnFocus)
    })

    const logout = async (path: "/auth/logout" | "/auth/logout-all") => {
      const current = generation
      const response = await fetch(new URL(path, sessionURL), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
      })
      if (!response.ok) throw new Error("Sign out did not complete")
      channel?.postMessage("logout")
      if (disposed) return
      if (current !== generation) {
        // The late response may have cleared the cookie for a newer local sign-in.
        await checkSession("late-logout")
        return
      }
      retireSession()
    }

    const signIn = () => {
      if (disposed || state.status !== "anonymous") return
      invalidateSessionChecks()
      if (state.mode === "users") channel?.postMessage("login")
      void checkSession("login")
    }

    return (
      <Switch>
        <Match when={state.status === "loading"}>
          <div class="arforge-login arforge-login--loading" role="status" aria-label="Loading Arforge">
            <div class="arforge-login__loader" />
          </div>
        </Match>
        <Match when={state.status === "anonymous"}>
          <PrivateLogin serverUrl={getCurrentUrl()} mode={state.mode} onAuthenticated={signIn} />
        </Match>
        <Match when={state.status === "authenticated"}>
          <div class="arforge-private-app">
            <WebSessionActionsOwner
              mode={state.mode}
              serverURL={getCurrentUrl()}
              logout={() => logout("/auth/logout")}
              logoutAll={() => logout("/auth/logout-all")}
              chinese={getLocale() === "zh"}
            />
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
