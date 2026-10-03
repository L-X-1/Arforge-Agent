import { createHash } from "node:crypto"
import type { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import type {
  MaybePromise,
  ReconciliationAdapter,
  ReconciliationEvidence,
  ReconciliationRequest,
} from "@arforge-ai/core/runtime/reconciliation"
import { ReconciliationRegistry } from "@arforge-ai/core/runtime/reconciliation"
import { Mcp } from "@arforge-ai/schema/mcp"
import { DateTime } from "effect"

const digestPattern = /^[a-f0-9]{64}$/
const sourcePattern = /^[a-z][a-z0-9._:-]{0,63}$/
const referencePartPattern = /^[^\u0000-\u001f\u007f]{1,160}$/
const taskIDPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const providerIDPattern = /^[a-z][a-z0-9._:-]{0,63}$/
const providerOperationIDPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

/**
 * Read-only MCP reconciliation input. The loader should normally delegate to
 * the existing DurableAction service; it must not maintain a second action
 * or response journal.
 */
export type McpReconciliationSnapshot = Pick<
  DurableAction.Snapshot,
  "action" | "observation" | "reconciliation" | "externalOperation"
>

/** Stable, non-secret marker emitted by the unified MCP child-action pipeline. */
export const MCP_CHILD_ACTION_RESOURCE = Mcp.CHILD_ACTION_RESOURCE

/** Stable resource prefix for the configured MCP server identity. */
export const MCP_SERVER_RESOURCE_PREFIX = "mcp-server:"

/** Stable resource prefix for an explicitly persisted MCP task reference. */
export const MCP_TASK_RESOURCE_PREFIX = "mcp-task:"

/**
 * Stable resource prefix for an explicitly registered vendor operation
 * provider. A vendor-specific asynchronous operation is never inferred from
 * a tool name, status string or response body.
 */
export const MCP_PROVIDER_RESOURCE_PREFIX = "mcp-provider:"

/** Stable resource prefix for an opaque vendor operation reference. */
export const MCP_OPERATION_RESOURCE_PREFIX = "mcp-operation:"

export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled"

/** Redacted state returned by a read-only `tasks/get` operation. */
export type McpTaskLookupState = Readonly<{
  readonly status: McpTaskStatus
  readonly observedAt?: number
}>

const isMcpTaskStatus = (value: unknown): value is McpTaskStatus =>
  value === "working" ||
  value === "input_required" ||
  value === "completed" ||
  value === "failed" ||
  value === "cancelled"

/** Lookup callback used by the MCP reconciliation adapter; it cannot submit a tool call. */
export type McpTaskLookup = (input: {
  readonly server: string
  readonly taskID: string
}) => MaybePromise<McpTaskLookupState | undefined>

/**
 * Read-only lookup callback for a non-`tasks` MCP vendor operation. The
 * provider receives only immutable identity and cannot submit a tool call or
 * return a result payload through this seam.
 */
export type McpProviderLookup = (input: {
  readonly server: string
  readonly provider: string
  readonly operationID: string
}) => MaybePromise<McpTaskLookupState | undefined>

export type McpTaskReconciliationLookupOptions = Readonly<{
  readonly lookupTask: McpTaskLookup
  readonly now?: () => number
}>

export type McpProviderReconciliationLookupOptions = Readonly<{
  /** Registry of explicitly supported vendor operation providers. */
  readonly providers: Pick<McpProviderRegistry, "get">
  readonly now?: () => number
}>

export type McpOperationReconciliationLookupOptions = Readonly<{
  /** Optional official MCP `tasks/get` contract. */
  readonly lookupTask?: McpTaskLookup
  /** Optional non-`tasks` vendor provider registry. */
  readonly providers?: Pick<McpProviderRegistry, "get">
  readonly now?: () => number
}>

export type McpTaskReference = Readonly<{
  readonly server: string
  readonly taskID: string
}>

export type McpProviderOperationReference = Readonly<{
  readonly server: string
  readonly provider: string
  readonly operationID: string
}>

/**
 * Transport-free registry for explicitly supported vendor operation
 * providers. Durable Action/session state remains owned by Core; this registry
 * stores only read-only callbacks for a caller-owned reconciliation request.
 */
export class McpProviderRegistry {
  private readonly providers = new Map<string, McpProviderLookup>()

  register(provider: string, lookup: McpProviderLookup): this {
    if (!providerIDPattern.test(provider)) throw new Error("MCP provider id is invalid")
    if (typeof lookup !== "function") throw new Error("MCP provider lookup is required")
    if (this.providers.has(provider)) throw new Error(`MCP provider already registered: ${provider}`)
    this.providers.set(provider, lookup)
    return this
  }

  get(provider: string): McpProviderLookup | undefined {
    return this.providers.get(provider)
  }

  list(): ReadonlyArray<string> {
    return Object.freeze([...this.providers.keys()].sort((left, right) => left.localeCompare(right)))
  }
}

export const isMcpTaskID = (value: string): boolean => taskIDPattern.test(value)

/**
 * A write-back path must never accept an arbitrary durable action merely
 * because a caller labels it `mcp`.  New MCP child actions carry this marker
 * and a parent binding; older unmarked actions remain readable but cannot be
 * operator-written through the MCP reconciliation endpoint.
 */
export const isMcpChildAction = (snapshot: Pick<McpReconciliationSnapshot, "action">): boolean =>
  snapshot.action.parentActionID !== undefined && snapshot.action.resources.includes(MCP_CHILD_ACTION_RESOURCE)

/**
 * Extracts a task reference only when the durable action contains exactly one
 * bounded server marker and one bounded task marker.  Ambiguous or malformed
 * resources fail closed instead of guessing which remote operation to query.
 */
export const mcpTaskReference = (
  snapshot: Pick<McpReconciliationSnapshot, "action" | "externalOperation">,
): McpTaskReference | undefined => {
  if (!snapshot.action.resources.includes(MCP_CHILD_ACTION_RESOURCE)) return undefined
  const bound = snapshot.externalOperation
  if (bound !== undefined) {
    if (
      snapshot.action.resources.some(
        (resource) =>
          resource.startsWith(MCP_PROVIDER_RESOURCE_PREFIX) || resource.startsWith(MCP_OPERATION_RESOURCE_PREFIX),
      )
    )
      return undefined
    const taskMarkers = [
      ...new Set(
        snapshot.action.resources
          .filter((resource) => resource.startsWith(MCP_TASK_RESOURCE_PREFIX))
          .map((resource) => resource.slice(MCP_TASK_RESOURCE_PREFIX.length))
          .filter(isMcpTaskID),
      ),
    ]
    if (
      bound.kind !== "mcp_task" ||
      !isMcpTaskID(bound.taskID) ||
      !referencePartPattern.test(bound.server) ||
      !snapshot.action.resources.includes(`${MCP_SERVER_RESOURCE_PREFIX}${bound.server}`) ||
      (taskMarkers.length > 0 && (taskMarkers.length !== 1 || taskMarkers[0] !== bound.taskID))
    )
      return undefined
    return { server: bound.server, taskID: bound.taskID }
  }
  if (
    snapshot.action.resources.some(
      (resource) =>
        resource.startsWith(MCP_PROVIDER_RESOURCE_PREFIX) || resource.startsWith(MCP_OPERATION_RESOURCE_PREFIX),
    )
  )
    return undefined
  const servers = [
    ...new Set(
      snapshot.action.resources
        .filter((resource) => resource.startsWith(MCP_SERVER_RESOURCE_PREFIX))
        .map((resource) => resource.slice(MCP_SERVER_RESOURCE_PREFIX.length))
        .filter((value) => referencePartPattern.test(value)),
    ),
  ]
  const tasks = [
    ...new Set(
      snapshot.action.resources
        .filter((resource) => resource.startsWith(MCP_TASK_RESOURCE_PREFIX))
        .map((resource) => resource.slice(MCP_TASK_RESOURCE_PREFIX.length))
        .filter(isMcpTaskID),
    ),
  ]
  if (servers.length !== 1 || tasks.length !== 1) return undefined
  return { server: servers[0], taskID: tasks[0] }
}

/**
 * Extract a vendor operation reference only from dedicated immutable resource
 * markers. A persisted standard task binding wins over vendor markers; any
 * other external binding or mixed task/vendor markers fails closed instead of
 * guessing which remote operation is authoritative.
 */
export const mcpProviderOperationReference = (
  snapshot: Pick<McpReconciliationSnapshot, "action" | "externalOperation">,
): McpProviderOperationReference | undefined => {
  if (!snapshot.action.resources.includes(MCP_CHILD_ACTION_RESOURCE)) return undefined
  if (snapshot.externalOperation !== undefined) return undefined

  const servers = [
    ...new Set(
      snapshot.action.resources
        .filter((resource) => resource.startsWith(MCP_SERVER_RESOURCE_PREFIX))
        .map((resource) => resource.slice(MCP_SERVER_RESOURCE_PREFIX.length))
        .filter((value) => referencePartPattern.test(value)),
    ),
  ]
  const providers = [
    ...new Set(
      snapshot.action.resources
        .filter((resource) => resource.startsWith(MCP_PROVIDER_RESOURCE_PREFIX))
        .map((resource) => resource.slice(MCP_PROVIDER_RESOURCE_PREFIX.length))
        .filter((value) => providerIDPattern.test(value)),
    ),
  ]
  const operations = [
    ...new Set(
      snapshot.action.resources
        .filter((resource) => resource.startsWith(MCP_OPERATION_RESOURCE_PREFIX))
        .map((resource) => resource.slice(MCP_OPERATION_RESOURCE_PREFIX.length))
        .filter((value) => providerOperationIDPattern.test(value)),
    ),
  ]
  const taskMarkers = snapshot.action.resources.filter((resource) => resource.startsWith(MCP_TASK_RESOURCE_PREFIX))
  if (taskMarkers.length > 0 || servers.length !== 1 || providers.length !== 1 || operations.length !== 1)
    return undefined
  return { server: servers[0], provider: providers[0], operationID: operations[0] }
}

/**
 * Optional server-side lookup after the durable action has no known result.
 * It receives only durable identity and the already loaded action snapshot;
 * returning protocol bodies or an executable callback is intentionally not
 * part of this contract.
 */
export type McpReconciliationLookup = (
  input: ReconciliationRequest,
  snapshot: McpReconciliationSnapshot,
) => MaybePromise<ReconciliationEvidence>

export type McpReconciliationOptions = Readonly<{
  /** Load the existing durable Action aggregate by its actionID. */
  readonly loadAction: (actionID: string) => MaybePromise<McpReconciliationSnapshot | undefined>
  /** Optional read-only external lookup; it must never submit an MCP request. */
  readonly lookup?: McpReconciliationLookup
  readonly now?: () => number
}>

/**
 * Registers the MCP adapter into the caller-owned shared registry. Keeping
 * registration explicit makes the application boundary visible while still
 * leaving adapter selection/state ownership with Core's registry.
 */
export function registerMcpReconciliationAdapter(
  registry: ReconciliationRegistry,
  options: McpReconciliationOptions,
): ReconciliationRegistry {
  return registry.register(createMcpReconciliationAdapter(options))
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const observedAt = (value: unknown, fallback: () => number) => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  if (DateTime.isDateTime(value)) {
    const millis = DateTime.toEpochMillis(value)
    if (Number.isSafeInteger(millis) && millis >= 0) return millis
  }
  const current = fallback()
  return Number.isSafeInteger(current) && current >= 0 ? current : Date.now()
}

const makeEvidence = (
  input: ReconciliationRequest,
  state: ReconciliationEvidence["state"],
  source: string,
  summary: string,
  marker: string,
  at: unknown,
  now: () => number,
): ReconciliationEvidence => {
  const observed = observedAt(at, now)
  return {
    state,
    evidenceDigest: sha256(
      JSON.stringify({
        actionID: input.actionID,
        intentDigest: input.intentDigest,
        idempotencyKey: input.idempotencyKey,
        state,
        source,
        marker,
        observedAt: observed,
      }),
    ),
    source,
    observedAt: observed,
    summary,
  }
}

/**
 * Builds the real MCP server-side read-only lookup used after durable state is
 * unknown.  It uses only the official task status operation (`tasks/get`)
 * through a caller-owned callback; it never requests `tasks/result` and never
 * repeats `tools/call`.  Task IDs and server identity come solely from the
 * immutable, marker-bound Action resources.
 */
export function createMcpTaskReconciliationLookup(
  options: McpTaskReconciliationLookupOptions,
): McpReconciliationLookup {
  const now = options.now ?? Date.now
  return async (input, snapshot) => {
    const reference = mcpTaskReference(snapshot)
    if (!reference)
      return makeEvidence(
        input,
        "unknown",
        "mcp-server-task",
        "MCP server operation reference is not durably bound",
        "missing-reference",
        snapshot.action.time.updated,
        now,
      )

    let task: McpTaskLookupState | undefined
    try {
      task = await options.lookupTask(reference)
    } catch {
      return makeEvidence(
        input,
        "unknown",
        "mcp-server-task",
        "MCP server task status could not be read",
        "lookup-failed",
        snapshot.action.time.updated,
        now,
      )
    }
    if (!task)
      return makeEvidence(
        input,
        "unknown",
        "mcp-server-task",
        "MCP server task is unavailable for read-only lookup",
        "missing-task",
        snapshot.action.time.updated,
        now,
      )
    if (!isMcpTaskStatus(task.status))
      return makeEvidence(
        input,
        "unknown",
        "mcp-server-task",
        "MCP server task returned an invalid status",
        "malformed-task",
        snapshot.action.time.updated,
        now,
      )

    if (task.status === "completed")
      return makeEvidence(
        input,
        "known_success",
        "mcp-server-task",
        "MCP server task reports completed",
        "completed",
        task.observedAt,
        now,
      )
    if (task.status === "failed" || task.status === "cancelled")
      return makeEvidence(
        input,
        "known_failure",
        "mcp-server-task",
        "MCP server task reports a terminal failure",
        task.status,
        task.observedAt,
        now,
      )
    return makeEvidence(
      input,
      "unknown",
      "mcp-server-task",
      "MCP server task is still in progress",
      task.status,
      task.observedAt,
      now,
    )
  }
}

/**
 * Builds a read-only lookup for one explicitly registered non-`tasks` MCP
 * provider. The provider is selected by the immutable `mcp-provider:*`
 * marker; a missing registration is a first-class unavailable result rather
 * than an invitation to guess a vendor endpoint or replay the tool call.
 */
export function createMcpProviderReconciliationLookup(
  options: McpProviderReconciliationLookupOptions,
): McpReconciliationLookup {
  const now = options.now ?? Date.now
  return async (input, snapshot) => {
    const reference = mcpProviderOperationReference(snapshot)
    if (!reference)
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation reference is not durably bound",
        "missing-reference",
        snapshot.action.time.updated,
        now,
      )

    const provider = options.providers.get(reference.provider)
    if (!provider)
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation provider contract is unavailable",
        "provider-unavailable",
        snapshot.action.time.updated,
        now,
      )

    let operation: McpTaskLookupState | undefined
    try {
      operation = await provider(reference)
    } catch {
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation status could not be read",
        "lookup-failed",
        snapshot.action.time.updated,
        now,
      )
    }
    if (!operation)
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation is unavailable for read-only lookup",
        "missing-operation",
        snapshot.action.time.updated,
        now,
      )
    if (!isMcpTaskStatus(operation.status))
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation returned an invalid status",
        "malformed-operation",
        snapshot.action.time.updated,
        now,
      )
    if (operation.status === "completed")
      return makeEvidence(
        input,
        "known_success",
        "mcp-provider",
        "MCP vendor operation reports completed",
        "completed",
        operation.observedAt,
        now,
      )
    if (operation.status === "failed" || operation.status === "cancelled")
      return makeEvidence(
        input,
        "known_failure",
        "mcp-provider",
        "MCP vendor operation reports a terminal failure",
        operation.status,
        operation.observedAt,
        now,
      )
    return makeEvidence(
      input,
      "unknown",
      "mcp-provider",
      "MCP vendor operation is still in progress",
      operation.status,
      operation.observedAt,
      now,
    )
  }
}

/**
 * Dispatches the one supported standard task contract or an explicitly
 * registered vendor contract. Keeping the dispatch here prevents a caller
 * from accidentally treating a vendor marker as a standard `tasks/get`
 * request, while preserving the existing task-only factory for compatibility.
 */
export function createMcpOperationReconciliationLookup(
  options: McpOperationReconciliationLookupOptions,
): McpReconciliationLookup {
  const now = options.now ?? Date.now
  const taskLookup = options.lookupTask
    ? createMcpTaskReconciliationLookup({ lookupTask: options.lookupTask, now })
    : undefined
  const providerLookup = options.providers
    ? createMcpProviderReconciliationLookup({ providers: options.providers, now })
    : undefined

  return async (input, snapshot) => {
    if (mcpTaskReference(snapshot)) {
      if (taskLookup) return taskLookup(input, snapshot)
      return makeEvidence(
        input,
        "unknown",
        "mcp-server-task",
        "MCP tasks/get provider contract is unavailable",
        "provider-unavailable",
        snapshot.action.time.updated,
        now,
      )
    }
    if (mcpProviderOperationReference(snapshot)) {
      if (providerLookup) return providerLookup(input, snapshot)
      return makeEvidence(
        input,
        "unknown",
        "mcp-provider",
        "MCP vendor operation provider contract is unavailable",
        "provider-unavailable",
        snapshot.action.time.updated,
        now,
      )
    }
    return makeEvidence(
      input,
      "unknown",
      "mcp-server-operation",
      "MCP operation reference is not durably bound",
      "missing-reference",
      snapshot.action.time.updated,
      now,
    )
  }
}

const validDurableReconciliation = (
  input: ReconciliationRequest,
  value: McpReconciliationSnapshot["reconciliation"],
): value is NonNullable<McpReconciliationSnapshot["reconciliation"]> =>
  value !== undefined &&
  value.actionID === input.actionID &&
  value.intentDigest === input.intentDigest &&
  value.idempotencyKey === input.idempotencyKey &&
  digestPattern.test(value.evidenceDigest) &&
  sourcePattern.test(value.source) &&
  DateTime.isDateTime(value.observedAt) &&
  Number.isSafeInteger(DateTime.toEpochMillis(value.observedAt)) &&
  DateTime.toEpochMillis(value.observedAt) >= 0

/**
 * Projects only durable MCP identity and status into the shared reconciliation
 * registry. It never exposes request arguments, endpoint credentials or
 * response bodies, and it never authorizes a retry.
 */
export function createMcpReconciliationAdapter(options: McpReconciliationOptions): ReconciliationAdapter {
  const now = options.now ?? Date.now

  const identityMatches = (input: ReconciliationRequest, snapshot: McpReconciliationSnapshot) =>
    snapshot.action.id === input.actionID &&
    snapshot.action.intentDigest === input.intentDigest &&
    snapshot.action.idempotencyKey === input.idempotencyKey

  const evidence = (
    input: ReconciliationRequest,
    state: ReconciliationEvidence["state"],
    source: string,
    summary: string,
    marker: string,
    at?: unknown,
  ): ReconciliationEvidence => {
    return makeEvidence(input, state, source, summary, marker, at, now)
  }

  const inspect = async (input: ReconciliationRequest): Promise<ReconciliationEvidence> => {
    let snapshot: McpReconciliationSnapshot | undefined
    try {
      snapshot = await options.loadAction(input.actionID)
    } catch {
      return evidence(input, "unknown", "mcp-durable-action", "durable MCP action could not be loaded", "load-failed")
    }
    if (!snapshot) return evidence(input, "unknown", "mcp-durable-action", "no durable MCP action was found", "missing")
    if (!identityMatches(input, snapshot))
      return evidence(
        input,
        "unknown",
        "mcp-durable-action",
        "durable MCP action identity or intent digest does not match",
        "identity-mismatch",
      )

    const durableEvidence = snapshot.reconciliation
    if (validDurableReconciliation(input, durableEvidence))
      return {
        state: durableEvidence.state,
        evidenceDigest: durableEvidence.evidenceDigest,
        source: durableEvidence.source,
        observedAt: DateTime.toEpochMillis(durableEvidence.observedAt),
        ...(durableEvidence.summary === undefined ? {} : { summary: durableEvidence.summary }),
      }

    const observation = snapshot.observation
    if (observation?.status === "succeeded")
      return evidence(
        input,
        "known_success",
        "mcp-durable-action",
        "durable MCP action has a successful observation",
        observation.id,
        DateTime.toEpochMillis(observation.observedAt),
      )
    if (observation?.status === "failed")
      return evidence(
        input,
        "known_failure",
        "mcp-durable-action",
        "durable MCP action has a failed observation",
        observation.id,
        DateTime.toEpochMillis(observation.observedAt),
      )
    return evidence(
      input,
      "unknown",
      "mcp-durable-action",
      "durable MCP action has no known external observation",
      snapshot.action.status,
      DateTime.toEpochMillis(snapshot.action.time.updated),
    )
  }

  return Object.freeze({
    actionKind: "mcp",
    actionVersion: "1",
    inspect,
    ...(options.lookup
      ? {
          reconcile: async (input: ReconciliationRequest, initial: ReconciliationEvidence) => {
            if (initial.state !== "unknown") return initial
            let snapshot: McpReconciliationSnapshot | undefined
            try {
              snapshot = await options.loadAction(input.actionID)
            } catch {
              return initial
            }
            if (!snapshot || !identityMatches(input, snapshot)) return initial
            return await options.lookup!(input, snapshot)
          },
        }
      : {}),
  })
}
