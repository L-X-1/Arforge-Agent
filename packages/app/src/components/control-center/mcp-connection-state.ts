import type { Config, McpLocalConfig, McpOAuthConfig, McpRemoteConfig } from "@arforge-ai/sdk/v2"
import { createStore } from "solid-js/store"
import { createScopeRequestGuard } from "../../utils/scope-request"

export type { McpLocalConfig, McpOAuthConfig, McpRemoteConfig }
export type ConfigMcpMap = NonNullable<Config["mcp"]>
export type McpEntry = ConfigMcpMap[string]
export type McpConnectionSource = { scope: string; name?: string; ready: boolean }
export type McpConnectionCallbacks = {
  load: (name?: string) => Promise<ConfigMcpMap>
  save: (name: string, value: McpEntry) => Promise<void>
  onSaved?: () => void
}
export type McpValueRow = { key: string; value: string }
export type McpConnectionDraft = {
  name: string
  type: "override" | "local" | "remote"
  command: string
  cwd: string
  readOnlyPaths: string
  environment: McpValueRow[]
  url: string
  headers: McpValueRow[]
  oauth: "auto" | "disabled" | "configured"
  clientId: string
  clientSecret: string
  oauthScope: string
  callbackPort: string
  redirectUri: string
  enabled: "inherit" | "enabled" | "disabled"
  startup: string
  request: string
}
export type McpFormError =
  | "name"
  | "duplicate-name"
  | "command"
  | "paths"
  | "environment"
  | "headers"
  | "url"
  | "positive-integer"
  | "port"
  | "redirect"
  | "incomplete"
export type McpFormErrors = Partial<Record<keyof McpConnectionDraft, McpFormError>>

export const supportedMcpConnectionName = (name: string) =>
  !!name.trim() && !/[\0\r\n]/.test(name) && !["__proto__", "constructor", "prototype"].includes(name)

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" ? value : "")
const rows = (value: unknown): McpValueRow[] =>
  record(value) ? Object.entries(value).map(([key, value]) => ({ key, value: text(value) })) : []

/** Only volatile form memory. Never persist or stringify a configuration snapshot for diagnostics. */
export function mcpConnectionDraft(name = "", entry?: McpEntry): McpConnectionDraft {
  const value: Record<string, unknown> = entry ?? {}
  const timeout =
    typeof value.timeout === "number"
      ? { startup: value.timeout, request: value.timeout }
      : record(value.timeout)
        ? value.timeout
        : {}
  const oauth = record(value.oauth) ? value.oauth : {}
  return {
    name,
    type: value.type === "local" || value.type === "remote" ? value.type : entry ? "override" : "local",
    command: Array.isArray(value.command) ? JSON.stringify(value.command, null, 2) : "",
    cwd: text(value.cwd),
    readOnlyPaths: Array.isArray(value.read_only_paths) ? JSON.stringify(value.read_only_paths, null, 2) : "",
    environment: rows(value.environment),
    url: text(value.url),
    headers: rows(value.headers),
    oauth: value.oauth === false ? "disabled" : record(value.oauth) ? "configured" : "auto",
    clientId: text(oauth.clientId),
    clientSecret: text(oauth.clientSecret),
    oauthScope: text(oauth.scope),
    callbackPort: typeof oauth.callbackPort === "number" ? String(oauth.callbackPort) : "",
    redirectUri: text(oauth.redirectUri),
    enabled: value.enabled === undefined ? "inherit" : value.enabled ? "enabled" : "disabled",
    startup: typeof timeout.startup === "number" ? String(timeout.startup) : "",
    request: typeof timeout.request === "number" ? String(timeout.request) : "",
  }
}

function stringArray(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string" && !item.includes("\0"))
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

function rowMap(values: McpValueRow[], headers: boolean): Record<string, string> | undefined {
  const seen = new Set<string>()
  const entries: [string, string][] = []
  for (const row of values) {
    if (!row.key && !row.value) continue
    const key = row.key.trim()
    const identity = headers ? key.toLowerCase() : key
    if (!key || seen.has(identity) || /[\0=\r\n]/.test(key)) return undefined
    if (headers && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(row.value))) return undefined
    if (!headers && row.value.includes("\0")) return undefined
    seen.add(identity)
    entries.push([key, row.value])
  }
  return Object.fromEntries(entries)
}

function numberField(value: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!value.trim()) return undefined
  if (!/^\d+$/.test(value.trim())) return NaN
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : NaN
}

function httpUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

/** Build only the selected entry; the existing writer owns the rest of the document. */
export function buildMcpConnection(
  draft: McpConnectionDraft,
  original?: McpEntry,
  existingNames: readonly string[] = [],
  lockedName?: string,
): { ok: true; name: string; value: McpEntry } | { ok: false; errors: McpFormErrors } {
  const errors: McpFormErrors = {}
  const name = lockedName ?? draft.name.trim()
  if (!supportedMcpConnectionName(name)) errors.name = "name"
  else if (lockedName === undefined && existingNames.includes(name)) errors.name = "duplicate-name"
  const value: Record<string, unknown> = { ...original }
  const put = (target: Record<string, unknown>, key: string, next: unknown) => {
    if (next === undefined) delete target[key]
    else target[key] = next
  }
  put(value, "enabled", draft.enabled === "inherit" ? undefined : draft.enabled === "enabled")
  const startup = numberField(draft.startup)
  const request = numberField(draft.request)
  if (Number.isNaN(startup)) errors.startup = "positive-integer"
  if (Number.isNaN(request)) errors.request = "positive-integer"
  const timeout = { ...(record(value.timeout) ? value.timeout : {}) }
  put(timeout, "startup", startup)
  put(timeout, "request", request)
  // An unchanged legacy number remains a number; unrelated edits do not migrate it.
  const legacyTimeout = original && "timeout" in original ? original.timeout : undefined
  if (!(typeof legacyTimeout === "number" && startup === legacyTimeout && request === legacyTimeout)) {
    put(value, "timeout", Object.keys(timeout).length ? timeout : undefined)
  }
  if (draft.type === "override") {
    // A toggle-only override is not a runnable connection. Do not invent a transport.
    if (!original || original.type !== undefined || draft.enabled === "inherit") errors.type = "incomplete"
  } else {
    value.type = draft.type
    if (draft.type === "local") {
      const command = stringArray(draft.command)
      if (!command?.length || !command[0].trim()) errors.command = "command"
      else value.command = command
      put(value, "cwd", draft.cwd || undefined)
      if (draft.cwd.includes("\0")) errors.cwd = "incomplete"
      const paths = draft.readOnlyPaths.trim() ? stringArray(draft.readOnlyPaths) : undefined
      if (draft.readOnlyPaths.trim() && (!paths || paths.some((path) => !path.trim()))) errors.readOnlyPaths = "paths"
      else put(value, "read_only_paths", paths)
      const environment = rowMap(draft.environment, false)
      if (!environment) errors.environment = "environment"
      else if (draft.environment.length || "environment" in value) value.environment = environment
      for (const key of ["url", "headers", "oauth"]) delete value[key]
    } else {
      const url = draft.url.trim()
      if (!httpUrl(url)) errors.url = "url"
      else value.url = url
      const headers = rowMap(draft.headers, true)
      if (!headers) errors.headers = "headers"
      else if (draft.headers.length || "headers" in value) value.headers = headers
      if (draft.oauth === "disabled") value.oauth = false
      else if (draft.oauth === "auto") {
        // Preserve unknown future OAuth fields, but omit explicitly cleared known fields.
        const oauth = { ...(record(value.oauth) ? value.oauth : {}) }
        for (const key of ["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"]) delete oauth[key]
        put(value, "oauth", Object.keys(oauth).length ? oauth : undefined)
      } else {
        const oauth = { ...(record(value.oauth) ? value.oauth : {}) }
        put(oauth, "clientId", draft.clientId || undefined)
        put(oauth, "clientSecret", draft.clientSecret || undefined)
        put(oauth, "scope", draft.oauthScope || undefined)
        put(oauth, "redirectUri", draft.redirectUri.trim() || undefined)
        const port = numberField(draft.callbackPort, 65535)
        if (Number.isNaN(port)) errors.callbackPort = "port"
        put(oauth, "callbackPort", port)
        if (draft.redirectUri.trim() && !httpUrl(draft.redirectUri.trim())) errors.redirectUri = "redirect"
        value.oauth = oauth
      }
      for (const key of ["command", "cwd", "read_only_paths", "environment"]) delete value[key]
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, name, value: value as McpEntry }
}

export function createMcpConnectionState(input: {
  source: () => McpConnectionSource
  callbacks: () => McpConnectionCallbacks
}) {
  const sourceKey = () => {
    const source = input.source()
    return JSON.stringify([source.scope, source.name, source.ready])
  }
  const guard = createScopeRequestGuard(sourceKey)
  let disposed = false
  let revision = 0
  let entries: ConfigMcpMap = {}
  let original: McpEntry | undefined
  const [state, setState] = createStore({
    owner: 0,
    loading: false,
    loaded: false,
    busy: false,
    lockedName: undefined as string | undefined,
    unsupportedName: false,
    entryState: "new" as "new" | "complete" | "override" | "incomplete" | "missing",
    draft: mcpConnectionDraft(),
    errors: {} as McpFormErrors,
    error: "" as "" | "load" | "save",
    notice: "" as "" | "saved" | "saved-with-edits",
  })
  const live = (owner: number) => !disposed && state.owner === owner && input.source().ready && activeCurrent()
  let activeCurrent = () => false
  return {
    state,
    live,
    async open() {
      if (disposed) return
      const source = { ...input.source() }
      const callbacks = input.callbacks()
      const token = guard.invalidate()
      const current = () => !disposed && guard.isCurrent(token) && input.source().ready
      activeCurrent = current
      entries = {}
      original = undefined
      revision = 0
      setState({
        owner: state.owner + 1,
        loading: source.ready,
        loaded: false,
        busy: false,
        lockedName: source.name,
        unsupportedName: source.name !== undefined && !supportedMcpConnectionName(source.name),
        entryState: "new",
        draft: mcpConnectionDraft(source.name),
        errors: {},
        error: "",
        notice: "",
      })
      if (!source.ready) return
      try {
        const loaded = await callbacks.load(source.name)
        if (!current()) return
        entries = loaded
        original = source.name !== undefined && Object.hasOwn(loaded, source.name) ? loaded[source.name] : undefined
        const draft = mcpConnectionDraft(source.name, original)
        const valid = original && buildMcpConnection(draft, original, [], source.name).ok
        setState({
          loaded: true,
          draft,
          entryState:
            source.name === undefined
              ? "new"
              : !original
                ? "missing"
                : draft.type === "override" && valid
                  ? "override"
                  : valid
                    ? "complete"
                    : "incomplete",
        })
      } catch {
        if (current()) setState("error", "load")
      } finally {
        if (current()) setState("loading", false)
      }
    },
    edit(owner: number, patch: Partial<McpConnectionDraft>) {
      if (!live(owner) || !state.loaded || state.unsupportedName) return
      revision++
      setState("draft", patch)
      setState({ errors: {}, error: "", notice: "" })
    },
    async submit(owner: number) {
      if (!live(owner) || !state.loaded || state.busy || state.unsupportedName || state.entryState === "missing") return
      const result = buildMcpConnection(state.draft, original, Object.keys(entries), state.lockedName)
      if (!result.ok) {
        setState({ errors: result.errors, notice: "" })
        return
      }
      const callbacks = input.callbacks()
      const current = activeCurrent
      const savedRevision = revision
      setState({ busy: true, errors: {}, error: "", notice: "" })
      try {
        if (!current()) return
        await callbacks.save(result.name, result.value)
        if (!current()) return
        original = result.value
        entries = { ...entries, [result.name]: result.value }
        setState({
          lockedName: result.name,
          entryState: result.value.type === undefined ? "override" : "complete",
          notice: revision === savedRevision ? "saved" : "saved-with-edits",
        })
      } catch {
        if (current()) setState("error", "save")
        return
      } finally {
        if (current()) setState("busy", false)
      }
      // A refresh/close callback must not consume input typed during this save.
      if (current() && revision === savedRevision) callbacks.onSaved?.()
    },
    dispose() {
      disposed = true
      guard.invalidate()
      entries = {}
      original = undefined
      setState({ draft: mcpConnectionDraft(), loaded: false, busy: false, loading: false })
    },
  }
}
