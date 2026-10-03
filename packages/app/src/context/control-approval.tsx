import type { AgentRuntimeControlRequest } from "@arforge-ai/sdk/v2/client"
import { createSimpleContext } from "@arforge-ai/ui/context"
import { batch, createEffect, createRoot, createSignal, getOwner, onCleanup, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobal } from "./global"
import { ServerConnection } from "./server"
import type { ServerSDK } from "./server-sdk"
import { ServerScope } from "@/utils/server-scope"
import { decode64 } from "@/utils/base64"

export type ControlApprovalReply = "once" | "reject"
export type ControlApprovalKey = string
export type ControlApprovalBinding = Readonly<{ project?: string; location: string }>
export type ControlApprovalEvent =
  | { type: "authorizer.control.asked"; properties: AgentRuntimeControlRequest }
  | {
      type: "authorizer.control.replied"
      properties: {
        subject: AgentRuntimeControlRequest["subject"]
        requestID: string
      }
    }
export type ControlApprovalEnvelope = Readonly<{ name: string; details: unknown }>

export type PendingControlApproval = AgentRuntimeControlRequest & {
  approvalKey: ControlApprovalKey
  serverKey: ServerConnection.Key
  sourceID?: string
}

export type ControlApprovalReceipt = Readonly<{
  id: string
  sourceID: string
  server: string
  project: string
  location: string
  requestID: string
  controlRequestID: string
  reply: ControlApprovalReply
  status: "pending" | "confirmed" | "failed"
  error?: string
}>

let sourceSequence = 0
let receiptSequence = 0

/** Never render credential-bearing connection URLs, query strings or transport metadata. */
export function safeControlServerLabel(key: string) {
  try {
    const url = new URL(key)
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin
  } catch { /* Native connection keys are not URLs. */ }
  return /^(?:sidecar|wsl:[A-Za-z0-9._-]{1,64}|ssh:[A-Za-z0-9._-]{1,128})$/.test(key) ? key : "Server"
}

function operationReceipt(item: PendingControlApproval, reply: ControlApprovalReply): ControlApprovalReceipt {
  return {
    id: `control-reply-${++receiptSequence}`,
    sourceID: item.sourceID ?? "unavailable",
    server: safeControlServerLabel(item.serverKey),
    project: isSafeIdentifier(item.subject.project) ? item.subject.project : "Unavailable",
    location: isSafeControlLocation(item.subject.location) ? item.subject.location : "Unavailable",
    requestID: isSafeIdentifier(item.id) ? item.id : "Unavailable",
    controlRequestID: isSafeIdentifier(item.subject.requestID) ? item.subject.requestID : "Unavailable",
    reply,
    status: "pending",
  }
}

export type ControlApprovalTransport = {
  list(directory: string): Promise<readonly AgentRuntimeControlRequest[]>
  reply(directory: string, requestID: string, reply: ControlApprovalReply): Promise<void>
  subscribe(listener: (event: ControlApprovalEnvelope) => void): () => void
}

export const SAFE_CONTROL_ACTIONS = [
  "worktree.create",
  "worktree.remove",
  "worktree.reset",
  "skill.enable",
  "skill.disable",
  "plugin.enable",
  "plugin.disable",
  "plugin.install",
  "plugin.update",
  "plugin.uninstall",
  "plugin.rollback",
  "session.revert",
  "session.unrevert",
  "session.share",
  "session.unshare",
  "evolution.proposal.create",
  "evolution.proposal.evaluate",
  "evolution.proposal.transition",
  "evolution.exposure.archive",
  "evolution.exposure.restore",
] as const
export type SafeControlAction = (typeof SAFE_CONTROL_ACTIONS)[number]
export type SafeControlResourceKind =
  | "filesystem"
  | "gitMetadata"
  | "git"
  | "branch"
  | "commit"
  | "reservation"
  | "skill"
  | "plugin"
  | "recovery"
  | "session"
  | "project"
  | "process"
  | "snapshot"
  | "sharing"
  | "organization"
  | "evolution"
export type SafeControlMetadataDetail = Readonly<{
  field: "riskTier" | "idempotency" | "reversibility" | "retryability" | "policyVersion"
  value: string | boolean
}>

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const SAFE_POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SAFE_RISK_TIERS = new Set(["low", "medium", "high", "critical"])
const MAX_DIRECTORY_LENGTH = 1_024
const MAX_IDENTIFIER_LENGTH = 160
const MAX_ACTION_LENGTH = 96
const MAX_RESOURCE_LENGTH = 1_024
const MAX_RESOURCES = 32
const MAX_METADATA_DEPTH = 4
const MAX_METADATA_ITEMS = 32
const MAX_METADATA_TEXT = 1_024

const knownResources: ReadonlyArray<readonly [prefix: string, kind: SafeControlResourceKind]> = [
  ["filesystem:", "filesystem"],
  ["git-metadata:", "gitMetadata"],
  ["git-head:", "gitMetadata"],
  ["git-index:", "gitMetadata"],
  ["git-dirty:", "gitMetadata"],
  ["git:", "git"],
  ["branch:", "branch"],
  ["commit:", "commit"],
  ["reservation:", "reservation"],
  ["skill:", "skill"],
  ["plugin:", "plugin"],
  ["recovery:", "recovery"],
  ["session-event:", "session"],
  ["session:", "session"],
  ["project:", "project"],
  ["project-registry:", "project"],
  ["process:", "process"],
  ["snapshot:", "snapshot"],
  ["share-", "sharing"],
  ["organization:", "organization"],
  ["evolution:", "evolution"],
]
const knownActions = new Set<string>(SAFE_CONTROL_ACTIONS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL_CHARACTERS.test(value)
}

function isSafeIdentifier(value: unknown) {
  return isBoundedText(value, MAX_IDENTIFIER_LENGTH) && SAFE_IDENTIFIER.test(value)
}

export function isSafeControlLocation(value: unknown) {
  return isBoundedText(value, MAX_DIRECTORY_LENGTH)
}

export function controlApprovalRouteLocation(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0]
  const decoded = decode64(segment)
  if (!decoded || !/^(?:[A-Za-z]:[\\/]|\/)/.test(decoded) || !isSafeControlLocation(decoded)) return
  return decoded
}

function isSafeControlAction(value: unknown) {
  return isBoundedText(value, MAX_ACTION_LENGTH)
}

function isSafeControlResource(value: unknown) {
  return isBoundedText(value, MAX_RESOURCE_LENGTH)
}

function isBoundedMetadata(value: unknown, depth = 0): boolean {
  if (depth >= MAX_METADATA_DEPTH) return false
  if (typeof value === "string") return isBoundedText(value, MAX_METADATA_TEXT)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return true
  if (Array.isArray(value))
    return value.length <= MAX_METADATA_ITEMS && value.every((item) => isBoundedMetadata(item, depth + 1))
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_METADATA_ITEMS &&
    entries.every(([key, item]) => isBoundedText(key, MAX_IDENTIFIER_LENGTH) && isBoundedMetadata(item, depth + 1))
  )
}

function isControlSubject(value: unknown): value is AgentRuntimeControlRequest["subject"] {
  if (!isRecord(value)) return false
  return (
    value.type === "control-plane" &&
    isSafeIdentifier(value.project) &&
    isSafeControlLocation(value.location) &&
    isSafeIdentifier(value.requestID)
  )
}

function isControlRequest(value: unknown): value is AgentRuntimeControlRequest {
  if (!isRecord(value)) return false
  if (!isSafeIdentifier(value.id) || !isSafeControlAction(value.action) || !Array.isArray(value.resources)) return false
  if (value.resources.length > MAX_RESOURCES || !value.resources.every(isSafeControlResource)) return false
  if (!isControlSubject(value.subject)) return false
  return value.metadata === undefined || isBoundedMetadata(value.metadata)
}

function isControlReply(
  value: unknown,
): value is Extract<ControlApprovalEvent, { type: "authorizer.control.replied" }>["properties"] {
  return isRecord(value) && isSafeIdentifier(value.requestID) && isControlSubject(value.subject)
}

export function parseControlApprovalEvent(value: unknown): ControlApprovalEvent | undefined {
  if (!isRecord(value)) return
  if (value.type === "authorizer.control.asked" && isControlRequest(value.properties)) {
    return { type: "authorizer.control.asked", properties: value.properties }
  }
  if (value.type === "authorizer.control.replied" && isControlReply(value.properties)) {
    return { type: "authorizer.control.replied", properties: value.properties }
  }
}

/** Canonical identity is never built from a malformed server value. */
export function controlApprovalKey(
  input: Pick<AgentRuntimeControlRequest, "id" | "subject">,
): ControlApprovalKey | undefined {
  if (!isSafeIdentifier(input.id) || !isControlSubject(input.subject)) return
  return [input.subject.project, input.subject.location, input.subject.requestID, input.id].join("\u0000")
}

/** An aria id must not include the canonical key's internal NUL separators. */
export function controlApprovalDOMID(approvalKey: ControlApprovalKey) {
  const bytes = new TextEncoder().encode(approvalKey)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
  return `control-approval-${encoded}`
}

export function knownControlAction(action: string): SafeControlAction | undefined {
  if (knownActions.has(action)) return action as SafeControlAction
}

/** Only expose category labels for expected resource prefixes; resource payloads remain private. */
export function safeControlResourceKinds(resources: readonly string[]) {
  const kinds = new Set<SafeControlResourceKind>()
  let unavailable = resources.length === 0
  for (const resource of resources) {
    const known = knownResources.find(([prefix]) => resource.startsWith(prefix))?.[1]
    if (known) kinds.add(known)
    else unavailable = true
  }
  return { kinds: [...kinds], unavailable }
}

/** Keep technical details to fixed enums, booleans, and a constrained policy version. */
export function safeControlMetadataDetails(metadata: unknown): readonly SafeControlMetadataDetail[] {
  if (!isRecord(metadata)) return []
  const details: SafeControlMetadataDetail[] = []
  const riskTier = metadata.riskTier
  if (typeof riskTier === "string" && SAFE_RISK_TIERS.has(riskTier))
    details.push({ field: "riskTier", value: riskTier })
  for (const field of ["idempotency", "reversibility", "retryability"] as const) {
    if (typeof metadata[field] === "boolean") details.push({ field, value: metadata[field] })
  }
  const policyVersion = metadata.policyVersion
  if (
    typeof policyVersion === "string" &&
    policyVersion.length <= 64 &&
    SAFE_POLICY_VERSION.test(policyVersion) &&
    !CONTROL_CHARACTERS.test(policyVersion)
  )
    details.push({ field: "policyVersion", value: policyVersion })
  return details
}

export function shortControlIdentifier(value: string) {
  if (!isSafeIdentifier(value)) return
  return value.length <= 24 ? value : `${value.slice(0, 14)}…${value.slice(-8)}`
}

function errorText(error: unknown) {
  const value =
    error instanceof Error ? error.message : typeof error === "string" ? error : "The approval reply failed."
  if (
    !isBoundedText(value, MAX_METADATA_TEXT) ||
    /(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]/i.test(value) ||
    /(?:[?&](?:token|key|secret|password)=|:\/\/[^/\s:@]+:[^@\s]+@)/i.test(value)
  )
    return "The approval request could not be completed."
  return value
}

function bindingKey(binding: ControlApprovalBinding) {
  return `${binding.project ?? "*"}\u0000${binding.location}`
}

function sameBinding(left: ControlApprovalBinding, right: ControlApprovalBinding) {
  return left.project === right.project && left.location === right.location
}

function validBindings(bindings: readonly ControlApprovalBinding[]) {
  const output = new Map<string, ControlApprovalBinding>()
  for (const binding of bindings) {
    if (
      (binding.project !== undefined && !isSafeIdentifier(binding.project)) ||
      !isSafeControlLocation(binding.location)
    )
      continue
    output.set(bindingKey(binding), binding)
  }
  return [...output.values()]
}

export function createControlApprovalState(input: {
  serverKey: ServerConnection.Key
  bindings: Accessor<readonly ControlApprovalBinding[]>
  transport: ControlApprovalTransport
  onReceipt?: (receipt: ControlApprovalReceipt) => void
}) {
  const sourceID = `control-source-${++sourceSequence}`
  const [store, setStore] = createStore({
    requests: {} as Record<ControlApprovalKey, PendingControlApproval>,
    receipts: {} as Record<string, ControlApprovalReceipt>,
    busy: {} as Record<ControlApprovalKey, boolean | undefined>,
    errors: {} as Record<ControlApprovalKey, string | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    loadErrors: {} as Record<string, string | undefined>,
  })
  const revisions = new Map<string, number>()
  const settled = new Set<ControlApprovalKey>()
  const loaded = new Set<string>()
  const startupRetryTimers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false
  const recordReceipt = (receipt: ControlApprovalReceipt) => {
    if (!disposed) setStore("receipts", receipt.id, receipt)
    input.onReceipt?.(receipt)
  }

  const knownBinding = (subject: AgentRuntimeControlRequest["subject"]) => {
    if (!isControlSubject(subject)) return
    const bindings = validBindings(input.bindings()).filter((binding) => binding.location === subject.location)
    return (
      bindings.find((binding) => binding.project === subject.project) ?? bindings.find((binding) => !binding.project)
    )
  }
  const requestKey = (request: Pick<AgentRuntimeControlRequest, "id" | "subject">) => {
    const canonical = controlApprovalKey(request)
    return canonical ? `${input.serverKey}\u0000${canonical}` : undefined
  }
  const revisionKey = (binding: ControlApprovalBinding) => bindingKey(binding)
  const bump = (binding: ControlApprovalBinding) => {
    const next = revisionKey(binding)
    revisions.set(next, (revisions.get(next) ?? 0) + 1)
  }

  const upsert = (request: AgentRuntimeControlRequest) => {
    if (!isControlRequest(request) || !knownBinding(request.subject)) return
    const approvalKey = requestKey(request)
    if (!approvalKey || settled.has(approvalKey)) return
    setStore("requests", approvalKey, { ...request, approvalKey, serverKey: input.serverKey, sourceID })
  }

  const remove = (subject: AgentRuntimeControlRequest["subject"], requestID: string) => {
    const approvalKey = requestKey({ id: requestID, subject })
    if (!approvalKey) return
    setStore(
      produce((draft) => {
        delete draft.requests[approvalKey]
        delete draft.errors[approvalKey]
      }),
    )
  }

  const refreshBinding = async (binding: ControlApprovalBinding) => {
    if (disposed || !validBindings(input.bindings()).some((candidate) => sameBinding(candidate, binding))) return
    const id = revisionKey(binding)
    bump(binding)
    const revision = revisions.get(id) ?? 0
    const current = () => !disposed && (revisions.get(id) ?? 0) === revision &&
      validBindings(input.bindings()).some((candidate) => sameBinding(candidate, binding))
    setStore("loading", id, true)
    setStore("loadErrors", id, undefined)
    try {
      const listed = await input.transport.list(binding.location)
      if (!current()) return
      const next = listed.filter(
        (request) =>
          isControlRequest(request) &&
          (binding.project === undefined || request.subject.project === binding.project) &&
          request.subject.location === binding.location,
      )
      const nextKeys = new Set(next.map(requestKey).filter((key): key is ControlApprovalKey => !!key))
      const stale = Object.values(store.requests).filter(
        (request) =>
          (binding.project === undefined || request.subject.project === binding.project) &&
          request.subject.location === binding.location &&
          !nextKeys.has(request.approvalKey),
      )
      batch(() => {
        stale.forEach((request) => remove(request.subject, request.id))
        next.forEach(upsert)
      })
    } catch (error) {
      if (current()) setStore("loadErrors", id, errorText(error))
    } finally {
      if (current()) setStore("loading", id, undefined)
    }
  }

  const refresh = async () => {
    await Promise.all(validBindings(input.bindings()).map((binding) => refreshBinding(binding)))
  }

  const unsubscribe = input.transport.subscribe((envelope) => {
    const event = parseControlApprovalEvent(envelope.details)
    if (!event || !isSafeControlLocation(envelope.name)) return
    const subject = event.properties.subject
    if (envelope.name !== subject.location) return
    const binding = knownBinding(subject)
    if (!binding) return

    bump(binding)
    // Event envelopes are only invalidation hints. The server-side pending
    // list remains the source of truth for both asked and replied events, so
    // a forged/stale reply cannot temporarily hide a real approval card.
    void refreshBinding(binding)
  })

  const reconcileBindings = () => {
    const current = validBindings(input.bindings())
    const currentKeys = new Set(current.map(revisionKey))
    for (const id of loaded) {
      if (currentKeys.has(id)) continue
      revisions.set(id, (revisions.get(id) ?? 0) + 1)
      loaded.delete(id)
      setStore("loading", id, undefined)
      setStore("loadErrors", id, undefined)
    }
    Object.values(store.requests).forEach((request) => {
      const binding = knownBinding(request.subject)
      if (!binding || !currentKeys.has(revisionKey(binding))) remove(request.subject, request.id)
    })
    for (const binding of current) {
      const id = revisionKey(binding)
      if (loaded.has(id)) continue
      loaded.add(id)
      void refreshBinding(binding)
    }
  }

  // Solid's createEffect waits for a renderer-owned update cycle. The state
  // factory is also used directly by headless startup/tests, so perform the
  // first reconciliation explicitly; the effect remains responsible for
  // later reactive binding changes. `loaded` prevents a renderer's initial
  // effect from issuing the same list request twice.
  createEffect(reconcileBindings)
  reconcileBindings()
  // Project metadata and the local control principal can both become
  // available shortly after the renderer mounts. Recompute bindings as well
  // as their lists so a deep-link reload does not require a manual Refresh.
  for (const delay of [500, 2_000]) {
    const timer = setTimeout(() => {
      startupRetryTimers.delete(timer)
      if (disposed) return
      reconcileBindings()
      void refresh()
    }, delay)
    startupRetryTimers.add(timer)
  }

  onCleanup(() => {
    disposed = true
    startupRetryTimers.forEach(clearTimeout)
    startupRetryTimers.clear()
    unsubscribe()
  })

  return {
    sourceID,
    receipts: () => Object.values(store.receipts),
    items: () => Object.values(store.requests).sort((left, right) => left.approvalKey.localeCompare(right.approvalKey)),
    loading: () => Object.values(store.loading).some(Boolean),
    loadErrors: () => Object.values(store.loadErrors).filter((error): error is string => !!error),
    busy(item: PendingControlApproval) {
      return store.busy[item.approvalKey] === true
    },
    error(item: PendingControlApproval) {
      return store.errors[item.approvalKey]
    },
    async reply(item: PendingControlApproval, reply: ControlApprovalReply) {
      if (reply !== "once" && reply !== "reject") return false
      if (disposed || item.sourceID !== sourceID || item.serverKey !== input.serverKey ||
        requestKey(item) !== item.approvalKey || !knownBinding(item.subject) ||
        !store.requests[item.approvalKey] || settled.has(item.approvalKey) || store.busy[item.approvalKey]) return false
      const receipt = operationReceipt(item, reply)
      setStore("busy", item.approvalKey, true)
      setStore("errors", item.approvalKey, undefined)
      recordReceipt(receipt)
      try {
        await input.transport.reply(item.subject.location, item.id, reply)
        if (!disposed) {
          settled.add(item.approvalKey)
          // Invalidate every overlapping binding, including wildcard project bindings.
          for (const binding of validBindings(input.bindings())) {
            if (binding.location !== item.subject.location ||
              (binding.project !== undefined && binding.project !== item.subject.project)) continue
            bump(binding)
            setStore("loading", revisionKey(binding), undefined)
          }
          remove(item.subject, item.id)
        }
        recordReceipt({ ...receipt, status: "confirmed" })
        return !disposed
      } catch (error) {
        const message = errorText(error)
        if (!disposed) setStore("errors", item.approvalKey, message)
        recordReceipt({ ...receipt, status: "failed", error: message })
        return false
      } finally {
        if (!disposed) setStore("busy", item.approvalKey, undefined)
      }
    },
    refresh,
  }
}

type ControlApprovalState = ReturnType<typeof createControlApprovalState>

function createServerControlApprovalState(input: {
  onReceipt: (receipt: ControlApprovalReceipt) => void
  sdk: ServerSDK
  bindings: Accessor<readonly ControlApprovalBinding[]>
}) {
  const serverKey = ServerConnection.key(input.sdk.server)
  const transport: ControlApprovalTransport = {
    async list(directory) {
      const client = input.sdk.createClient({ directory, throwOnError: true })
      const response = await client.experimental.controlApproval.list()
      return response.data ?? []
    },
    async reply(directory, requestID, reply) {
      const client = input.sdk.createClient({ directory, throwOnError: true })
      const response = await client.experimental.controlApproval.reply({ requestID, reply })
      if (response.data !== true) throw new Error("The server did not confirm the approval reply.")
    },
    subscribe(listener) {
      return input.sdk.event.listen((event) => listener({ name: event.name, details: event.details }))
    },
  }

  void input.sdk.event.start()
  return createControlApprovalState({ serverKey, bindings: input.bindings, transport, onReceipt: input.onReceipt })
}

export const { use: useControlApproval, provider: ControlApprovalProvider } = createSimpleContext({
  name: "ControlApproval",
  gate: false,
  init: () => {
    const global = useGlobal()
    const owner = getOwner()
    const [routeLocations, setRouteLocations] = createSignal<readonly string[]>([])
    const states = new Map<ServerScope, { sdk: ServerSDK; dispose: () => void; state: ControlApprovalState }>()
    const [receipts, setReceipts] = createStore<Record<string, ControlApprovalReceipt>>({})
    let disposed = false
    const recordReceipt = (receipt: ControlApprovalReceipt) => {
      if (!disposed) setReceipts(receipt.id, receipt)
    }

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Control approval server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing?.sdk === ctx.sdk) return existing.state
      existing?.dispose()
      const root = createRoot(
        (dispose) => ({
          sdk: ctx.sdk,
          dispose,
          state: createServerControlApprovalState({
            sdk: ctx.sdk,
            onReceipt: recordReceipt,
            bindings: () => {
              const bindings = new Map<string, ControlApprovalBinding>()
              const add = (binding: ControlApprovalBinding) => {
                if (!isSafeControlLocation(binding.location)) return
                if (binding.project !== undefined && !isSafeIdentifier(binding.project)) return
                const current = bindings.get(binding.location)
                if (!current || binding.project) bindings.set(binding.location, binding)
              }
              const routeLocation = controlApprovalRouteLocation(globalThis.location?.pathname ?? "")
              if (routeLocation) add({ location: routeLocation })
              routeLocations().forEach((location) => add({ location }))
              for (const project of ctx.sync.data.project) {
                add({ project: project.id, location: project.worktree })
              }
              for (const project of ctx.projects.list()) {
                add({ project: typeof project.id === "string" ? project.id : undefined, location: project.worktree })
              }
              return [...bindings.values()]
            },
          }),
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
      const scopes = new Set(global.servers.list().map((conn) => ServerScope.fromServerKey(ServerConnection.key(conn))))
      states.forEach((value, scope) => {
        if (scopes.has(scope)) return
        value.dispose()
        states.delete(scope)
      })
    })
    onCleanup(() => { disposed = true; states.forEach((value) => value.dispose()) })

    const all = () => global.servers.list().flatMap((conn) => ensure(ServerConnection.key(conn)).items())
    const stateFor = (item: PendingControlApproval) => {
      const conn = global.servers.list().find((candidate) => ServerConnection.key(candidate) === item.serverKey)
      const state = conn ? ensure(ServerConnection.key(conn)) : undefined
      return state?.sourceID === item.sourceID ? state : undefined
    }

    return {
      receipts: () => Object.values(receipts).reverse(),
      items: () => all().sort((left, right) => left.approvalKey.localeCompare(right.approvalKey)),
      count: () => all().length,
      loading: () => global.servers.list().some((conn) => ensure(ServerConnection.key(conn)).loading()),
      loadErrors: () => global.servers.list().flatMap((conn) => ensure(ServerConnection.key(conn)).loadErrors()),
      busy: (item: PendingControlApproval) => stateFor(item)?.busy(item) ?? false,
      error: (item: PendingControlApproval) => stateFor(item)?.error(item),
      reply: (item: PendingControlApproval, reply: ControlApprovalReply) => {
        const state = stateFor(item)
        if (state) return state.reply(item, reply)
        recordReceipt({ ...operationReceipt(item, reply), status: "failed",
          error: "The originating connection is unavailable. Refresh and review the request again." })
        return Promise.resolve(false)
      },
      refresh: () => Promise.all(global.servers.list().map((conn) => ensure(ServerConnection.key(conn)).refresh())),
      registerLocation(location: string | undefined) {
        if (!isSafeControlLocation(location) || !/^(?:[A-Za-z]:[\\/]|\/)/.test(location)) return
        setRouteLocations((current) => (current.includes(location) ? current : [...current.slice(-15), location]))
        queueMicrotask(() => {
          states.forEach((entry) => void entry.state.refresh())
        })
      },
    }
  },
})
