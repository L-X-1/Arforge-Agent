import { pathKey } from "@/utils/path-key"

const STORAGE_PREFIX = "arforge.control-operation.v1."

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

type Common = {
  /** Canonical server scope; never credentials or an authorization header. */
  readonly server: string
  /** Project root identity on that server. */
  readonly project: string
  /** Location whose state the operation can affect. */
  readonly location: string
}

export type ControlOperationSpec =
  | (Common & {
      readonly kind: "worktree.create"
      readonly input: { readonly name?: string }
    })
  | (Common & {
      readonly kind: "worktree.remove" | "worktree.reset"
      readonly input: { readonly directory: string }
    })
  | (Common & {
      readonly kind: "session.revert"
      readonly input: { readonly sessionID: string; readonly messageID: string; readonly partID?: string }
    })
  | (Common & {
      readonly kind: "session.unrevert"
      readonly input: { readonly sessionID: string }
    })

export type CanonicalControlOperationBinding = {
  readonly server: string
  readonly project: string
  readonly location: string
  readonly kind: ControlOperationSpec["kind"]
  readonly input: Readonly<Record<string, string>>
}

export type ControlOperationPhase =
  | "preparing"
  | "waiting_for_confirmation"
  | "queued"
  | "executing"
  | "recovering"
  | "verifying"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"

/**
 * Display projection returned by the control-operation mutation and status
 * endpoints. It contains no checkpoint or raw payload. Only a strictly
 * validated `phase=completed` projection may include the minimal terminal
 * result needed by the original desktop continuation.
 */
export type ServerControlOperationStatus = {
  readonly runID: string
  readonly actionID: string
  readonly requestID: string
  readonly operation: CanonicalControlOperationBinding["kind"]
  readonly phase: ControlOperationPhase
  readonly recovery: "awaiting_authorization" | "resume" | "recover" | "none"
  readonly canApprove: boolean
  readonly result?: ServerControlOperationResult
}

export type ServerControlOperationResult =
  | {
      readonly kind: "worktree.create"
      readonly name: string
      readonly directory: string
      readonly branch: string
    }
  | {
      readonly kind: "worktree.remove" | "worktree.reset"
      readonly completed: true
    }
  | {
      readonly kind: "session.revert" | "session.unrevert"
      readonly completed: true
    }

export type CompletedWorktree = Omit<Extract<ServerControlOperationResult, { kind: "worktree.create" }>, "kind">

export type ControlOperationRunResult<A> =
  | { readonly state: "completed"; readonly value: A }
  | { readonly state: "status"; readonly status: ServerControlOperationStatus }

export type ControlOperationStatusLookup = (input: {
  readonly requestID: string
  readonly operation: CanonicalControlOperationBinding["kind"]
  readonly location: string
}) => Promise<unknown>

type StoredIntent = {
  readonly version: 1
  readonly binding: CanonicalControlOperationBinding
  readonly inputDigest: string
  readonly bindingDigest: string
  readonly requestID: string
}

export type ControlOperationIntent = StoredIntent & { readonly storageKey: string }

export type ControlOperationOptions = {
  readonly storage?: StorageLike
  readonly randomUUID?: () => string
}

function storageFor(options?: ControlOperationOptions) {
  if (options?.storage) return options.storage
  if (typeof localStorage !== "object") throw new Error("Durable control-operation storage is unavailable")
  return localStorage
}

function canonicalPath(input: string) {
  const value = pathKey(input)
  const windows = /^[a-zA-Z]:\//.test(value) || value.startsWith("//")
  return windows ? value.toLowerCase() : value
}

function canonicalInput(spec: ControlOperationSpec): Readonly<Record<string, string>> {
  const keys = Object.keys(spec.input)
  if (spec.kind === "worktree.create") {
    if (keys.some((key) => key !== "name")) {
      throw new Error("Worktree create recovery cannot persist unapproved or secret input fields")
    }
    const name = spec.input.name?.trim()
    return name ? Object.freeze({ name }) : Object.freeze({} as Record<string, string>)
  }

  if (spec.kind === "session.revert") {
    if (
      keys.some((key) => !["sessionID", "messageID", "partID"].includes(key)) ||
      !spec.input.sessionID ||
      !spec.input.messageID
    ) {
      throw new Error("Session revert recovery requires only session, message, and optional part identity")
    }
    return Object.freeze({
      sessionID: spec.input.sessionID,
      messageID: spec.input.messageID,
      ...(spec.input.partID ? { partID: spec.input.partID } : {}),
    })
  }

  if (spec.kind === "session.unrevert") {
    if (keys.length !== 1 || keys[0] !== "sessionID" || !spec.input.sessionID) {
      throw new Error("Session unrevert recovery requires only session identity")
    }
    return Object.freeze({ sessionID: spec.input.sessionID })
  }

  if (keys.some((key) => key !== "directory") || !("directory" in spec.input) || !spec.input.directory) {
    throw new Error("Worktree mutation recovery requires only its target directory")
  }
  return Object.freeze({ directory: canonicalPath(spec.input.directory) })
}

function canonicalBinding(spec: ControlOperationSpec): CanonicalControlOperationBinding {
  if (!spec.server || !spec.project || !spec.location) {
    throw new Error("Control-operation recovery requires server, project, and location identity")
  }
  return Object.freeze({
    server: spec.server,
    project: canonicalPath(spec.project),
    location: canonicalPath(spec.location),
    kind: spec.kind,
    input: canonicalInput(spec),
  })
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`
  if (input && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`).join(",")}}`
  }
  return JSON.stringify(input)
}

async function digest(input: unknown) {
  const bytes = new TextEncoder().encode(stableJson(input))
  const value = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function isStoredIntent(input: unknown): input is StoredIntent {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const value = input as Partial<StoredIntent>
  return (
    value.version === 1 &&
    isCanonicalBinding(value.binding) &&
    typeof value.inputDigest === "string" &&
    value.inputDigest.length === 64 &&
    typeof value.bindingDigest === "string" &&
    value.bindingDigest.length === 64 &&
    typeof value.requestID === "string" &&
    value.requestID.startsWith("cpr_")
  )
}

function isCanonicalBinding(input: unknown): input is CanonicalControlOperationBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const value = input as Partial<CanonicalControlOperationBinding>
  if (
    typeof value.server !== "string" ||
    !value.server ||
    typeof value.project !== "string" ||
    !value.project ||
    typeof value.location !== "string" ||
    !value.location ||
    !["worktree.create", "worktree.remove", "worktree.reset", "session.revert", "session.unrevert"].includes(
      value.kind ?? "",
    ) ||
    !value.input ||
    typeof value.input !== "object" ||
    Array.isArray(value.input)
  ) {
    return false
  }
  const entries = Object.entries(value.input)
  if (entries.some(([, item]) => typeof item !== "string")) return false
  if (value.kind === "worktree.create") return entries.every(([key]) => key === "name")
  if (value.kind === "session.revert") {
    const fields = new Map(entries)
    return (
      entries.every(([key]) => ["sessionID", "messageID", "partID"].includes(key)) &&
      !!fields.get("sessionID") &&
      !!fields.get("messageID")
    )
  }
  if (value.kind === "session.unrevert") {
    return entries.length === 1 && entries[0]?.[0] === "sessionID" && entries[0][1].length > 0
  }
  return entries.length === 1 && entries[0]?.[0] === "directory" && entries[0][1].length > 0
}

function parseStored(raw: string, storageKey: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Control-operation intent ${storageKey} is corrupt; recovery stopped`)
  }
  if (!isStoredIntent(parsed)) {
    throw new Error(`Control-operation intent ${storageKey} is invalid; recovery stopped`)
  }
  return parsed
}

/**
 * Persist one user gesture before its HTTP request starts. Unknown results
 * deliberately retain this record, so a recreated desktop window can submit
 * the frozen input under the exact same durable request identity.
 */
export async function beginControlOperation(
  spec: ControlOperationSpec,
  options?: ControlOperationOptions,
): Promise<ControlOperationIntent> {
  const storage = storageFor(options)
  const binding = canonicalBinding(spec)
  const inputDigest = await digest(binding.input)
  const bindingDigest = await digest({
    server: binding.server,
    project: binding.project,
    location: binding.location,
    kind: binding.kind,
    inputDigest,
  })
  const storageKey = `${STORAGE_PREFIX}${bindingDigest}`
  const existingRaw = storage.getItem(storageKey)
  if (existingRaw) {
    const existing = parseStored(existingRaw, storageKey)
    if (
      existing.bindingDigest !== bindingDigest ||
      existing.inputDigest !== inputDigest ||
      stableJson(existing.binding) !== stableJson(binding)
    ) {
      throw new Error(`Control-operation intent ${storageKey} does not match its frozen input; recovery stopped`)
    }
    return { ...existing, storageKey }
  }

  const makeUUID = options?.randomUUID ?? (() => crypto.randomUUID())
  const intent: StoredIntent = {
    version: 1,
    binding,
    inputDigest,
    bindingDigest,
    requestID: `cpr_${makeUUID()}`,
  }
  const encoded = JSON.stringify(intent)
  // Web Storage replaces one key atomically. Read-after-write prevents an
  // unavailable/quota-limited store from silently degrading to random IDs.
  storage.setItem(storageKey, encoded)
  const published = storage.getItem(storageKey)
  if (!published) throw new Error("Control-operation intent was not durably published")
  const verified = parseStored(published, storageKey)
  if (stableJson(verified) !== stableJson(intent)) {
    throw new Error("Control-operation intent changed while it was being published; recovery stopped")
  }
  return { ...verified, storageKey }
}

/** Remove only the exact settled/blocked intent; never erase a newer gesture. */
export function settleControlOperation(intent: ControlOperationIntent, options?: ControlOperationOptions) {
  const storage = storageFor(options)
  const raw = storage.getItem(intent.storageKey)
  if (!raw) return
  const current = parseStored(raw, intent.storageKey)
  if (current.requestID !== intent.requestID || current.bindingDigest !== intent.bindingDigest) return
  storage.removeItem(intent.storageKey)
}

export async function listPendingControlOperations(options?: ControlOperationOptions, server?: string) {
  const storage = storageFor(options)
  const intents: ControlOperationIntent[] = []
  const corruptKeys: string[] = []
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => typeof key === "string" && key.startsWith(STORAGE_PREFIX),
  )
  for (const storageKey of keys) {
    try {
      const raw = storage.getItem(storageKey)
      if (!raw) continue
      const intent = parseStored(raw, storageKey)
      if (storageKey !== `${STORAGE_PREFIX}${intent.bindingDigest}`) throw new Error("intent key mismatch")
      if ((await digest(intent.binding.input)) !== intent.inputDigest) throw new Error("input digest mismatch")
      if (
        (await digest({
          server: intent.binding.server,
          project: intent.binding.project,
          location: intent.binding.location,
          kind: intent.binding.kind,
          inputDigest: intent.inputDigest,
        })) !== intent.bindingDigest
      ) {
        throw new Error("binding digest mismatch")
      }
      if (server === undefined || intent.binding.server === server) intents.push({ ...intent, storageKey })
    } catch {
      corruptKeys.push(storageKey)
    }
  }
  return { intents, corruptKeys }
}

const controlOperationPhases = new Set<ControlOperationPhase>([
  "preparing",
  "waiting_for_confirmation",
  "queued",
  "executing",
  "recovering",
  "verifying",
  "paused",
  "completed",
  "failed",
  "cancelled",
])
const controlOperationRecoveries = new Set<ServerControlOperationStatus["recovery"]>([
  "awaiting_authorization",
  "resume",
  "recover",
  "none",
])
const controlOperationKinds = new Set<CanonicalControlOperationBinding["kind"]>([
  "worktree.create",
  "worktree.remove",
  "worktree.reset",
  "session.revert",
  "session.unrevert",
])
const statusFields = new Set([
  "runID",
  "actionID",
  "requestID",
  "operation",
  "phase",
  "recovery",
  "canApprove",
  "result",
])

function validateServerControlOperationResult(
  input: unknown,
  operation: CanonicalControlOperationBinding["kind"],
): ServerControlOperationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid control operation result")
  const value = input as Partial<ServerControlOperationResult>
  if (value.kind !== operation) throw new Error("Invalid control operation result")
  if (value.kind === "worktree.create") {
    const keys = Object.keys(value)
    if (
      keys.some((key) => !["kind", "name", "directory", "branch"].includes(key)) ||
      typeof value.name !== "string" ||
      !value.name ||
      typeof value.directory !== "string" ||
      !value.directory ||
      typeof value.branch !== "string" ||
      !value.branch
    ) {
      throw new Error("Invalid control operation result")
    }
    return value as ServerControlOperationResult
  }
  const completed = value as { readonly completed?: unknown }
  if (
    !["worktree.remove", "worktree.reset", "session.revert", "session.unrevert"].includes(value.kind ?? "") ||
    completed.completed !== true ||
    Object.keys(value).some((key) => !["kind", "completed"].includes(key))
  ) {
    throw new Error("Invalid control operation result")
  }
  return value as ServerControlOperationResult
}

export function validateServerControlOperationStatus(
  input: unknown,
  expected?: {
    readonly requestID: string
    readonly operation: CanonicalControlOperationBinding["kind"]
  },
): ServerControlOperationStatus {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid control operation status")
  const value = input as Partial<ServerControlOperationStatus>
  if (
    Object.keys(value).some((key) => !statusFields.has(key)) ||
    typeof value.runID !== "string" ||
    !value.runID ||
    typeof value.actionID !== "string" ||
    !value.actionID ||
    typeof value.requestID !== "string" ||
    !value.requestID ||
    typeof value.operation !== "string" ||
    !controlOperationKinds.has(value.operation as CanonicalControlOperationBinding["kind"]) ||
    typeof value.phase !== "string" ||
    !controlOperationPhases.has(value.phase as ControlOperationPhase) ||
    typeof value.recovery !== "string" ||
    !controlOperationRecoveries.has(value.recovery as ServerControlOperationStatus["recovery"]) ||
    typeof value.canApprove !== "boolean" ||
    value.canApprove !== (value.phase === "waiting_for_confirmation") ||
    (expected && (value.requestID !== expected.requestID || value.operation !== expected.operation))
  ) {
    throw new Error("Invalid control operation status")
  }
  const result =
    value.result === undefined
      ? undefined
      : validateServerControlOperationResult(value.result, value.operation as CanonicalControlOperationBinding["kind"])
  if (
    result !== undefined &&
    (value.phase !== "completed" || value.recovery !== "none" || value.canApprove !== false)
  ) {
    throw new Error("Invalid control operation status")
  }
  return { ...value, ...(result ? { result } : {}) } as ServerControlOperationStatus
}

function looksLikeControlOperationStatus(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  return Object.keys(input).some((key) => statusFields.has(key))
}

function isLegacyCompletedResponse(intent: ControlOperationIntent, input: unknown) {
  if (intent.binding.kind === "worktree.create") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false
    const value = input as { readonly directory?: unknown }
    return typeof value.directory === "string" && value.directory.length > 0
  }
  if (intent.binding.kind === "session.revert" || intent.binding.kind === "session.unrevert") return false
  return input === true
}

function terminalResultValue(result: ServerControlOperationResult) {
  if (result.kind !== "worktree.create") return true
  return {
    name: result.name,
    directory: result.directory,
    branch: result.branch,
  }
}

function resolveControlOperationStatus<A>(
  intent: ControlOperationIntent,
  input: unknown,
  options?: ControlOperationOptions,
): ControlOperationRunResult<A> {
  const status = validateServerControlOperationStatus(input, {
    requestID: intent.requestID,
    operation: intent.binding.kind,
  })
  if (!status.result) return { state: "status", status }
  settleControlOperation(intent, options)
  return { state: "completed", value: terminalResultValue(status.result) as A }
}

function structuredClientError(error: unknown) {
  // The generated SDK throws the decoded error body directly when
  // `throwOnError` is enabled. Older/compatible clients wrap that body in an
  // Error cause. Recognize both shapes without treating arbitrary text as a
  // structured response.
  const direct = error && typeof error === "object" && !Array.isArray(error) ? error : undefined
  const cause =
    error instanceof Error && error.cause && typeof error.cause === "object" && !Array.isArray(error.cause)
      ? (error.cause as { status?: unknown; body?: unknown })
      : undefined
  const body = cause?.body ?? direct
  const name =
    body && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : undefined
  return { status: typeof cause?.status === "number" ? cause.status : undefined, name }
}

/**
 * Only a structured terminal response can retire the desktop identity.
 * Network loss, an in-progress lease, and recovery-required responses keep it
 * for reload/reconnect under the same request ID.
 */
export function isTerminalControlOperationError(error: unknown) {
  const structured = structuredClientError(error)
  if (!structured?.status) return false
  if (
    structured.name === "ActionGateway.RecoveryRequiredError" ||
    structured.name === "ActionGateway.ActionInProgressError"
  ) {
    return false
  }
  return structured.status >= 400 && structured.status < 500
}

export async function runControlOperation<A>(
  intent: ControlOperationIntent,
  execute: (requestID: string) => Promise<unknown>,
  options?: ControlOperationOptions,
): Promise<ControlOperationRunResult<A>> {
  try {
    const result = await execute(intent.requestID)

    // The asynchronous HTTP contract normally returns only a display/status
    // DTO. Keep the durable browser identity unless a completed status also
    // contains the strict, matching terminal result required by the original
    // continuation.
    if (looksLikeControlOperationStatus(result)) {
      return resolveControlOperationStatus<A>(intent, result, options)
    }

    // Compatibility with pre-ControlRun servers remains deliberately narrow.
    // A malformed 2xx cannot retire the durable identity or trigger cleanup.
    if (!isLegacyCompletedResponse(intent, result)) {
      throw new Error("Control operation returned neither an authoritative status nor a completed result")
    }
    settleControlOperation(intent, options)
    return { state: "completed", value: result as A }
  } catch (error) {
    if (isTerminalControlOperationError(error)) settleControlOperation(intent, options)
    throw error
  }
}

export type WaitForControlOperationOptions = ControlOperationOptions & {
  readonly retryDelayMs?: number
  readonly maxWaitMs?: number
}

/**
 * Follow an already accepted operation only through the read-only status
 * endpoint. This never reissues the mutation. A missing, paused, failed, or
 * malformed terminal result leaves the durable intent in place and prevents
 * the caller's continuation.
 */
export async function waitForControlOperationCompletion<A>(
  intent: ControlOperationIntent,
  initial: ServerControlOperationStatus,
  lookup: ControlOperationStatusLookup,
  options?: WaitForControlOperationOptions,
): Promise<ControlOperationRunResult<A>> {
  let current = resolveControlOperationStatus<A>(intent, initial, options)
  if (current.state === "completed") return current
  const started = Date.now()
  const retryDelayMs = options?.retryDelayMs ?? 500
  const maxWaitMs = options?.maxWaitMs ?? 5 * 60_000

  while (
    current.status.phase !== "completed" &&
    current.status.phase !== "failed" &&
    current.status.phase !== "cancelled" &&
    current.status.phase !== "paused" &&
    Date.now() - started < maxWaitMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    current = resolveControlOperationStatus<A>(
      intent,
      await lookup({
        requestID: intent.requestID,
        operation: intent.binding.kind,
        location: intent.binding.location,
      }),
      options,
    )
    if (current.state === "completed") return current
  }
  return current
}

/**
 * Submit the user-authorized presentation once, then switch permanently to
 * read-only status polling. The mutation callback is never used as a poll or
 * recovery mechanism.
 */
export async function runControlOperationToCompletion<A>(
  intent: ControlOperationIntent,
  execute: (requestID: string) => Promise<unknown>,
  lookup: ControlOperationStatusLookup,
  options?: WaitForControlOperationOptions,
): Promise<ControlOperationRunResult<A>> {
  const initial = await runControlOperation<A>(intent, execute, options)
  if (initial.state === "completed") return initial
  return waitForControlOperationCompletion<A>(intent, initial.status, lookup, options)
}
