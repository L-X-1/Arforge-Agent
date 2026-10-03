import { createEffect, createMemo, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@arforge-ai/ui/context"
import type { PermissionRequest } from "@arforge-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useParams, useSearchParams } from "@solidjs/router"
import { decode64 } from "@/utils/base64"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, useTabs } from "./tabs"
import { useSettings } from "./settings"
import { requireServerKey } from "@/utils/session-route"
import type { ServerScope } from "@/utils/server-scope"
import { normalizePermissionRequest } from "./global-sync/utils"
import {
  acceptKey,
  directoryAcceptKey,
  isDirectoryAutoAccepting,
  autoRespondsPermission,
  sessionAutoAccept,
  sessionLineage,
} from "./permission-auto-respond"
import {
  permissionModeAutoRespond,
  permissionModeFromRules,
  sessionPermissionRules,
  type SessionPermissionMode,
} from "./permission-mode"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "always" | "reject"
  directory?: string
}) => void

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasPermissionPromptRules(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  return Object.values(config).some(isNonAllowRule)
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const params = useParams<{ serverKey?: string; dir?: string; id?: string }>()
    const [search] = useSearchParams<{ draftId?: string }>()
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const settings = useSettings()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()

    const activeDraft = createMemo(() => {
      if (!search.draftId) return
      return tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)
    })

    const activeServer = createMemo(() => {
      if (params.serverKey && settings.general.newLayoutDesigns()) return requireServerKey(params.serverKey)
      return activeDraft()?.server ?? server.key
    })

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      if (existing) {
        existing.dispose()
        states.delete(ctx.sdk.scope)
      }
      const root = createRoot(
        (dispose) => ({
          key,
          dispose,
          state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync }),
        }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => {
      global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn)))
    })

    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
        const replacement = list.find((conn) => server.scope(ServerConnection.key(conn)) === scope)
        if (replacement) ensure(ServerConnection.key(replacement))
      })
    })

    onCleanup(() => states.forEach((value) => value.dispose()))

    let lastSelected: PermissionState | undefined
    const selected = () => {
      const key = activeServer()
      if (global.servers.list().some((conn) => ServerConnection.key(conn) === key)) {
        lastSelected = ensure(key)
      }
      if (lastSelected) return lastSelected
      return ensure(server.key)
    }
    const activeDirectory = createMemo(() => {
      const directory = decode64(params.dir)
      if (directory) return directory
      const draft = activeDraft()
      if (draft) return draft.directory
      if (!params.id) return
      if (!global.servers.list().some((conn) => ServerConnection.key(conn) === activeServer())) return
      return selected().sync.session.lineage.peek(params.id)?.session.directory
    })

    createEffect(() => {
      const directory = activeDirectory()
      if (!directory) return
      selected().enableConfiguredDirectory(directory)
    })

    const permissionsEnabled = createMemo(() => {
      const directory = activeDirectory()
      if (!directory) return false
      return selected().permissionsEnabled(directory)
    })

    return {
      ready: () => selected().ready(),
      ensureServerState: (key: ServerConnection.Key) => ensure(key).api,
      currentServerState: () => selected().api,
      respond(input: Parameters<PermissionRespondFn>[0]) {
        selected().respond(input)
      },
      autoResponds(permission: PermissionRequest, directory?: string) {
        return selected().autoResponds(permission, directory)
      },
      isAutoAccepting(sessionID: string, directory?: string) {
        return selected().isAutoAccepting(sessionID, directory)
      },
      isAutoAcceptingDirectory(directory: string) {
        return selected().isAutoAcceptingDirectory(directory)
      },
      toggleAutoAccept(sessionID: string, directory: string) {
        selected().toggleAutoAccept(sessionID, directory)
      },
      toggleAutoAcceptDirectory(directory: string) {
        selected().toggleAutoAcceptDirectory(directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        selected().enableAutoAccept(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        selected().disableAutoAccept(sessionID, directory)
      },
      mode(sessionID: string | undefined, directory: string) {
        return selected().mode(sessionID, directory)
      },
      setMode(sessionID: string, directory: string, mode: SessionPermissionMode) {
        return selected().setMode(sessionID, directory, mode)
      },
      permissionsEnabled,
      isPermissionAllowAll(directory: string) {
        return selected().isPermissionAllowAll(directory)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>
type PermissionEvent = Parameters<Parameters<ServerSDK["event"]["listen"]>[0]>[0]

function createServerPermissionState(input: { sdk: ServerSDK; sync: ServerSync }) {
  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value

        const data = value as Record<string, unknown>
        if (data.autoAccept) {
          return {
            ...data,
            mode: typeof data.mode === "object" && data.mode && !Array.isArray(data.mode) ? data.mode : {},
          }
        }

        return {
          ...data,
          autoAccept:
            typeof data.autoAcceptEdits === "object" && data.autoAcceptEdits && !Array.isArray(data.autoAcceptEdits)
              ? data.autoAcceptEdits
              : {},
          mode: {},
        }
      },
    },
    createStore({
      autoAccept: {} as Record<string, boolean>,
      mode: {} as Record<string, SessionPermissionMode>,
    }),
  )

  function enableConfiguredDirectory(directory: string) {
    if (input.sdk.protocolKind() !== "v1") return
    if (meta.disposed || !ready()) return
    const [childStore] = input.sync.child(directory)
    if (childStore.config.permission !== "allow") return
    const key = directoryAcceptKey(directory)
    if (store.autoAccept[key] !== undefined) return
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
        draft.mode[key] = "fullAccess"
      }),
    )
  }

  const MAX_RESPONDED = 1000
  const RESPONDED_TTL_MS = 60 * 60 * 1000
  const responded = new Map<string, number>()
  const enableVersion = new Map<string, number>()
  const meta = { disposed: false }

  function pruneResponded(now: number) {
    for (const [id, ts] of responded) {
      if (now - ts < RESPONDED_TTL_MS) break
      responded.delete(id)
    }

    for (const id of responded.keys()) {
      if (responded.size <= MAX_RESPONDED) break
      responded.delete(id)
    }
  }

  const respond: PermissionRespondFn = (request) => {
    if (meta.disposed) return
    input.sdk.api.permission
      .reply({
        sessionID: request.sessionID,
        requestID: request.permissionID,
        reply: request.response,
        location: request.directory ? { directory: request.directory } : undefined,
      })
      .catch(() => {
        responded.delete(request.permissionID)
      })
  }

  const list = async (directory: string) => {
    if ((await input.sdk.protocol) === "v1") {
      return (await input.sdk.client.permission.list({ directory })).data ?? []
    }
    return input.sdk.api.permission.request
      .list({ location: { directory } })
      .then((result) => result.data.map(normalizePermissionRequest))
  }

  function respondOnce(permission: PermissionRequest, directory?: string) {
    const now = Date.now()
    const hit = responded.has(permission.id)
    responded.delete(permission.id)
    responded.set(permission.id, now)
    pruneResponded(now)
    if (hit) return
    respond({
      sessionID: permission.sessionID,
      permissionID: permission.id,
      response: "once",
      directory,
    })
  }

  function sessions(directory?: string) {
    const info = Object.values(input.sync.session.data.info).filter((session) => !!session)
    if (!directory) return info
    return [...info, ...input.sync.child(directory, { bootstrap: false })[0].session]
  }

  function isAutoAccepting(sessionID: string, directory?: string) {
    return autoRespondsPermission(store.autoAccept, sessions(directory), { sessionID }, directory)
  }

  function isAutoAcceptingDirectory(directory: string) {
    return isDirectoryAutoAccepting(store.autoAccept, directory)
  }

  function mode(sessionID: string | undefined, directory: string): SessionPermissionMode {
    if (sessionID) {
      const lineage = sessionLineage(sessions(directory), sessionID)
      for (const id of lineage) {
        const value = store.mode[acceptKey(id, directory)] ?? store.mode[id]
        if (value) return value
        const backend = permissionModeFromRules(sessions(directory).find((session) => session.id === id)?.permission)
        if (backend) return backend
        const accepting = sessionAutoAccept(store.autoAccept, sessions(directory), { sessionID: id }, directory)
        if (accepting !== undefined) return accepting ? "fullAccess" : "acceptEdits"
      }
    }
    const directoryMode = store.mode[directoryAcceptKey(directory)]
    if (directoryMode) return directoryMode
    return isDirectoryAutoAccepting(store.autoAccept, directory) ? "fullAccess" : "acceptEdits"
  }

  function shouldAutoRespond(permission: PermissionRequest, directory?: string) {
    // Full-access mode is an L2 convenience, not an L3 approval. This flag
    // comes from the trusted PermissionV2 service when `forceAsk` was used;
    // it must never be reconstructed from command text or presentation
    // metadata, and it always requires an explicit user reply.
    if (requiresHumanConfirmation(permission)) return false
    if (!directory) return autoRespondsPermission(store.autoAccept, sessions(directory), permission, directory)
    const current = mode(permission.sessionID, directory)
    return permissionModeAutoRespond(current, permission.permission, requiresHumanConfirmation(permission))
  }

  function isPending(permission: PermissionRequest) {
    const pending = input.sync.session.data.permission[permission.sessionID]
    return pending === undefined || pending.some((item) => item.id === permission.id)
  }

  async function shouldAutoRespondResolved(permission: PermissionRequest, directory?: string) {
    if (requiresHumanConfirmation(permission)) return false
    const override = sessionAutoAccept(store.autoAccept, sessions(directory), permission, directory)
    if (override !== undefined) return override
    if (input.sync.session.lineage.peek(permission.sessionID)) return shouldAutoRespond(permission, directory)
    const lineage = await input.sync.session.lineage.resolve(permission.sessionID).catch(() => undefined)
    if (meta.disposed || !lineage) return false
    return shouldAutoRespond(permission, directory)
  }

  async function respondPending(
    permission: PermissionRequest,
    directory?: string,
    current: () => boolean = () => true,
  ) {
    if (!current() || !isPending(permission)) return
    if (!(await shouldAutoRespondResolved(permission, directory))) return
    if (meta.disposed || !current() || !isPending(permission)) return
    respondOnce(permission, directory)
  }

  function bumpEnableVersion(sessionID: string, directory?: string) {
    const key = acceptKey(sessionID, directory)
    const next = (enableVersion.get(key) ?? 0) + 1
    enableVersion.set(key, next)
    return next
  }

  const handlePermission = (e: PermissionEvent) => {
    const event = e.details
    if (event?.type !== "permission.asked") return
    void respondPending(event.properties, e.name)
  }

  const unsubscribe = input.sdk.event.listen((event) => {
    if (ready()) {
      handlePermission(event)
      return
    }
    void ready.promise?.then(() => {
      if (meta.disposed) return
      handlePermission(event)
    })
  })
  onCleanup(() => {
    meta.disposed = true
    unsubscribe()
  })

  function enableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
        draft.mode[key] = "fullAccess"
      }),
    )

    list(directory)
      .then((permissions) => {
        if (meta.disposed) return
        if (!isAutoAcceptingDirectory(directory)) return
        for (const permission of permissions) {
          void respondPending(permission, directory, () => isAutoAcceptingDirectory(directory))
        }
      })
      .catch(() => undefined)
  }

  function disableDirectory(directory: string) {
    if (meta.disposed) return
    const key = directoryAcceptKey(directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
        draft.mode[key] = "acceptEdits"
      }),
    )
  }

  function enable(sessionID: string, directory: string) {
    if (meta.disposed) return
    const key = acceptKey(sessionID, directory)
    const version = bumpEnableVersion(sessionID, directory)
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = true
        draft.mode[key] = "fullAccess"
        delete draft.autoAccept[sessionID]
        delete draft.mode[sessionID]
      }),
    )

    list(directory)
      .then((permissions) => {
        if (meta.disposed) return
        if (enableVersion.get(key) !== version) return
        if (!isAutoAccepting(sessionID, directory)) return
        for (const permission of permissions) {
          void respondPending(
            permission,
            directory,
            () => enableVersion.get(key) === version && isAutoAccepting(sessionID, directory),
          )
        }
      })
      .catch(() => undefined)
  }

  function disable(sessionID: string, directory?: string) {
    if (meta.disposed) return
    bumpEnableVersion(sessionID, directory)
    const key = directory ? acceptKey(sessionID, directory) : sessionID
    setStore(
      produce((draft) => {
        draft.autoAccept[key] = false
        draft.mode[key] = "acceptEdits"
        if (!directory) return
        delete draft.autoAccept[sessionID]
        delete draft.mode[sessionID]
      }),
    )
  }

  const modeVersion = new Map<string, number>()

  async function setMode(sessionID: string, directory: string, next: SessionPermissionMode) {
    if (meta.disposed) return
    const key = acceptKey(sessionID, directory)
    if (store.mode[key] === next && store.autoAccept[key] === (next === "fullAccess")) return
    const version = (modeVersion.get(key) ?? 0) + 1
    modeVersion.set(key, version)
    const previousMode = store.mode[key]
    const previousAccept = store.autoAccept[key]

    setStore(
      produce((draft) => {
        draft.mode[key] = next
        draft.autoAccept[key] = next === "fullAccess"
        delete draft.mode[sessionID]
        delete draft.autoAccept[sessionID]
      }),
    )

    try {
      const client = input.sdk.createClient({ directory, throwOnError: true })
      await client.session.update({
        sessionID,
        permission: sessionPermissionRules(next),
      })
      if (modeVersion.get(key) !== version || next === "plan") return
      const pending = await list(directory)
      if (meta.disposed || modeVersion.get(key) !== version) return
      for (const permission of pending) {
        if (!permissionModeAutoRespond(next, permission.permission, requiresHumanConfirmation(permission))) continue
        void respondPending(
          permission,
          directory,
          () => modeVersion.get(key) === version && mode(sessionID, directory) === next,
        )
      }
    } catch (error) {
      if (modeVersion.get(key) === version) {
        setStore(
          produce((draft) => {
            if (previousMode === undefined) delete draft.mode[key]
            else draft.mode[key] = previousMode
            if (previousAccept === undefined) delete draft.autoAccept[key]
            else draft.autoAccept[key] = previousAccept
          }),
        )
      }
      throw error
    }
  }

  const api = {
    ready: () => !meta.disposed && ready(),
    respond,
    autoResponds(permission: PermissionRequest, directory?: string) {
      if (meta.disposed) return false
      return shouldAutoRespond(permission, directory)
    },
    isAutoAccepting(sessionID: string, directory?: string) {
      if (meta.disposed) return false
      return isAutoAccepting(sessionID, directory)
    },
    isAutoAcceptingDirectory(directory: string) {
      if (meta.disposed) return false
      return isAutoAcceptingDirectory(directory)
    },
    mode(sessionID: string | undefined, directory: string) {
      if (meta.disposed) return "acceptEdits" as const
      return mode(sessionID, directory)
    },
    setMode(sessionID: string, directory: string, next: SessionPermissionMode) {
      if (meta.disposed) return Promise.resolve()
      return setMode(sessionID, directory, next)
    },
    toggleAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      const next = isAutoAccepting(sessionID, directory) ? "acceptEdits" : "fullAccess"
      void setMode(sessionID, directory, next).catch(() => undefined)
    },
    toggleAutoAcceptDirectory(directory: string) {
      if (meta.disposed) return
      if (isAutoAcceptingDirectory(directory)) {
        disableDirectory(directory)
        return
      }
      enableDirectory(directory)
    },
    enableAutoAccept(sessionID: string, directory: string) {
      if (meta.disposed) return
      if (mode(sessionID, directory) === "fullAccess") return
      void setMode(sessionID, directory, "fullAccess").catch(() => undefined)
    },
    disableAutoAccept(sessionID: string, directory?: string) {
      if (meta.disposed) return
      if (directory) {
        void setMode(sessionID, directory, "acceptEdits").catch(() => undefined)
        return
      }
      disable(sessionID, directory)
    },
    isPermissionAllowAll(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return childStore.config.permission === "allow"
    },
  }

  return {
    ...api,
    api,
    sync: input.sync,
    enableConfiguredDirectory,
    permissionsEnabled(directory: string) {
      if (meta.disposed) return false
      const [childStore] = input.sync.child(directory)
      return hasPermissionPromptRules(childStore.config.permission)
    },
  }
}

function requiresHumanConfirmation(permission: PermissionRequest) {
  return (
    "requiresHumanConfirmation" in permission &&
    (permission as PermissionRequest & { requiresHumanConfirmation?: unknown }).requiresHumanConfirmation === true
  )
}
