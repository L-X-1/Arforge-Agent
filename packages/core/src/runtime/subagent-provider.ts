/**
 * Provider-neutral execution boundary for delegated child sessions.
 *
 * DurableRun, Session permissions, ActionGateway and usage settlement remain
 * the authorities for identity, capabilities, budgets and results. This
 * service only tracks the in-process provider's ephemeral execution lease so
 * a caller can inspect or drain a provider without inventing a second durable
 * child-run state machine. Future ACP/Codex/Claude adapters can implement the
 * same interface and keep the durable child handle as their source of truth.
 */

export * as SubagentProvider from "./subagent-provider"

import { Cause, Context, Deferred, Effect, Exit, Layer, Option, Schema, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { NonNegativeInt, PositiveInt } from "../schema"
import { canonicalHash } from "../util/canonical-hash"
import * as RuntimeInvariants from "./invariants"

export const Kind = Schema.Literals(["in-process", "acp", "codex", "claude"] as const)
export type Kind = typeof Kind.Type

export const Phase = Schema.Literals([
  "running",
  "draining",
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const)
export type Phase = typeof Phase.Type

export const EventKind = Schema.Literals([
  "started",
  "output",
  "tool_call",
  "usage",
  "completed",
  "failed",
  "cancelled",
  "outcome_unknown",
] as const)
export type EventKind = typeof EventKind.Type

export const StopReason = Schema.Literals([
  "completed",
  "cancelled",
  "max_tokens",
  "deadline",
  "provider_error",
  "unknown",
] as const)
export type StopReason = typeof StopReason.Type

export const UsageSchema = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheWriteTokens: NonNegativeInt,
  costMicros: Schema.optional(NonNegativeInt),
})
export interface Usage extends Schema.Schema.Type<typeof UsageSchema> {}

export const ProviderEventSchema = Schema.Struct({
  provider: Kind,
  executionID: Schema.String,
  epoch: PositiveInt,
  /** Monotonic per-execution sequence; payload bytes stay outside this contract. */
  sequence: NonNegativeInt,
  kind: EventKind,
  outputDigest: Schema.optional(Schema.String),
  stopReason: Schema.optional(StopReason),
  usage: Schema.optional(UsageSchema),
})
export interface ProviderEvent extends Schema.Schema.Type<typeof ProviderEventSchema> {}

/** Adapter input deliberately carries metadata only; identity/sequence are assigned by Core. */
export type ProviderEventDraft = Omit<ProviderEvent, "provider" | "executionID" | "epoch" | "sequence">

export interface ProviderEventSink {
  readonly emit: (event: ProviderEventDraft) => Effect.Effect<ProviderEvent, InvalidInputError>
}

export interface ContinuationCursor {
  readonly schemaVersion: 1
  readonly provider: Kind
  readonly executionID: string
  readonly epoch: number
  /** The next event sequence the adapter is allowed to append. */
  readonly nextSequence: number
  /** Digest of the last provider-visible output, never the output itself. */
  readonly outputDigest: string
}

/** Optional observer used by the durable owner to append accepted event progress. */
export interface ExecuteOptions {
  readonly onEvent?: (
    event: ProviderEvent,
    continuation: ContinuationCursor | undefined,
  ) => Effect.Effect<void, unknown>
}

/** Strict wire shape used when a cursor is embedded in a DurableRun checkpoint. */
export const ContinuationCursorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: Kind,
  executionID: Schema.String,
  epoch: Schema.Number,
  nextSequence: Schema.Number,
  outputDigest: Schema.String,
})

/**
 * The durable binding around a cursor. These fields are opaque identity and
 * digests only; lease and permission authorities remain owned by DurableRun
 * and Session respectively.
 */
export interface ContinuationCheckpointBinding {
  readonly cursor: ContinuationCursor
  readonly attempt: number
  readonly leaseID: string
  readonly leaseOwnerID: string
  readonly permissionDigest: string
}

const ContinuationCheckpointSchema = Schema.Struct({
  phase: Schema.Literal("subagent-provider"),
  provider: Kind,
  executionID: Schema.String,
  epoch: Schema.Number,
  attempt: Schema.Number,
  leaseID: Schema.String,
  leaseOwnerID: Schema.String,
  permissionDigest: Schema.String,
  subagentContinuation: ContinuationCursorSchema,
})

export const CONTINUATION_CHECKPOINT_KEY = "subagentContinuation"

export type ParentControlOperation = "cancel" | "steer" | "followup" | "wait" | "drain" | "dispose"

const parentControlOperations: ReadonlySet<ParentControlOperation> = new Set([
  "cancel",
  "steer",
  "followup",
  "wait",
  "drain",
  "dispose",
])

export interface DirectParentControlInput {
  readonly operation: ParentControlOperation
  /** Caller identity resolved by the existing DurableRun/ActionGateway owner. */
  readonly callerRunID: string
  /** Parent identity read from the immutable child binding. */
  readonly childParentRunID: string
  readonly childRunID: string
}

/**
 * Parent control request for one provider execution. The caller/parent/child
 * tuple is supplied by the durable owner; provider state is only used to
 * verify that the request targets the same immutable child binding.
 */
export interface ParentControlInput extends DirectParentControlInput {
  readonly executionID: string
  readonly timeoutMs?: number
}

export type ParentWaitInput = ParentControlInput & { readonly operation: "wait" }
export type ParentCancelInput = ParentControlInput & { readonly operation: "cancel" }

/** Metadata-only drain request sent to a provider adapter.  The durable
 * child/run owner remains authoritative for the result; this hook only gives
 * a native adapter a bounded opportunity to stop accepting new work. */
export interface AdapterDrainInput {
  readonly operation: "drain"
  readonly provider: Kind
  readonly executionID: string
  readonly epoch: number
  readonly timeoutMs: number
}

/** Metadata-only disposal request.  No prompt, tool argument, credential or
 * provider payload may cross this boundary. */
export interface AdapterDisposeInput {
  readonly operation: "dispose"
  readonly provider: Kind
}

/**
 * Metadata-only parent message control.  The prompt bytes remain in the
 * durable SessionInput inbox; a native adapter receives only the exact
 * request/envelope identity and digests so it can route the already-admitted
 * message without creating a second prompt pipeline.
 */
export interface ParentMessageControlInput extends DirectParentControlInput {
  readonly operation: "steer" | "followup"
  readonly executionID: string
  /** Provider execution epoch bound to the active DurableRun attempt. */
  readonly epoch: number
  readonly requestID: string
  readonly messageID: string
  readonly promptDigest: string
  readonly envelopeDigest: string
  readonly delivery: "steer" | "queue"
}

export type ParentSteerInput = ParentMessageControlInput & { readonly operation: "steer" }
export type ParentFollowupInput = ParentMessageControlInput & { readonly operation: "followup" }

/** Adapter output is intentionally a tiny closed result; no provider payload
 * or raw error text can cross the native-control boundary. */
export interface AdapterControlResult {
  readonly status: "accepted" | "unsupported"
}

export interface ParentMessageControlResult {
  readonly executionID: string
  readonly provider?: Kind
  readonly status: "accepted" | "unsupported" | "unavailable"
}

export interface AdapterCapabilities {
  readonly provider: Kind
  readonly available: boolean
  readonly supportsColdResume: boolean
  readonly supportsEvents: boolean
  readonly supportsUsage: boolean
  readonly supportsStopReason: boolean
  /** Native steer support; the same metadata-only seam is used for followup. */
  readonly supportsSteer: boolean
  /** Optional explicit followup capability.  Omitted legacy adapters remain
   * steer-only and therefore use the durable inbox fallback for followup. */
  readonly supportsFollowup?: boolean
  /** Optional native cancellation capability.  Omitted legacy adapters use
   * the Core cancellation signal and remain fully compatible. */
  readonly supportsCancel?: boolean
  /** Optional native graceful-drain capability. */
  readonly supportsDrain?: boolean
  /** Optional native adapter disposal capability. */
  readonly supportsDispose?: boolean
}

const digestPattern = /^[a-f0-9]{64}$/i

const cursorError = (cursor: ContinuationCursor, reason: string) =>
  new InvalidInputError({ executionID: cursor.executionID, reason })

/**
 * Decode and normalize one adapter event at the Core boundary. The adapter
 * cannot choose another child identity or sequence number, and no raw payload
 * field is accepted by the schema.
 */
export const normalizeProviderEvent = (input: {
  readonly identity: Pick<ExecuteInput, "provider" | "executionID" | "epoch">
  readonly sequence: number
  readonly event: ProviderEventDraft
}): ProviderEvent => {
  const allowedKeys = new Set(["kind", "outputDigest", "stopReason", "usage"])
  const unexpectedKey = Object.keys(input.event).find((key) => !allowedKeys.has(key))
  if (unexpectedKey)
    throw new InvalidInputError({
      executionID: input.identity.executionID,
      reason: `provider event contains unsupported metadata key: ${unexpectedKey}`,
    })
  const { kind, outputDigest, stopReason, usage } = input.event
  let decoded: ProviderEvent
  try {
    decoded = Schema.decodeUnknownSync(ProviderEventSchema, { onExcessProperty: "error" })({
      provider: input.identity.provider,
      executionID: input.identity.executionID,
      epoch: input.identity.epoch,
      sequence: input.sequence,
      kind,
      ...(outputDigest === undefined ? {} : { outputDigest }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(usage === undefined ? {} : { usage }),
    })
  } catch {
    throw new InvalidInputError({
      executionID: input.identity.executionID,
      reason: "provider event metadata failed strict schema validation",
    })
  }
  if (decoded.outputDigest !== undefined && !digestPattern.test(decoded.outputDigest))
    throw new InvalidInputError({
      executionID: input.identity.executionID,
      reason: "provider event outputDigest must be a 64-character hexadecimal digest",
    })
  if (decoded.kind === "usage" && decoded.usage === undefined)
    throw new InvalidInputError({
      executionID: input.identity.executionID,
      reason: "usage provider events must include normalized usage metadata",
    })
  return decoded
}

const mergeUsage = (previous: Usage | undefined, next: Usage): { readonly value?: Usage; readonly error?: string } => {
  type CounterResult = { readonly value: number } | { readonly error: string }
  const add = (left: number, right: number, label: string): CounterResult => {
    const value = left + right
    return Number.isSafeInteger(value) ? { value } : { error: `provider usage ${label} exceeds safe integer bounds` }
  }
  const inputTokens = add(previous?.inputTokens ?? 0, next.inputTokens, "inputTokens")
  if ("error" in inputTokens) return { error: inputTokens.error }
  const outputTokens = add(previous?.outputTokens ?? 0, next.outputTokens, "outputTokens")
  if ("error" in outputTokens) return { error: outputTokens.error }
  const reasoningTokens = add(previous?.reasoningTokens ?? 0, next.reasoningTokens, "reasoningTokens")
  if ("error" in reasoningTokens) return { error: reasoningTokens.error }
  const cacheReadTokens = add(previous?.cacheReadTokens ?? 0, next.cacheReadTokens, "cacheReadTokens")
  if ("error" in cacheReadTokens) return { error: cacheReadTokens.error }
  const cacheWriteTokens = add(previous?.cacheWriteTokens ?? 0, next.cacheWriteTokens, "cacheWriteTokens")
  if ("error" in cacheWriteTokens) return { error: cacheWriteTokens.error }
  const costMicros: CounterResult | undefined =
    previous?.costMicros === undefined && next.costMicros === undefined
      ? undefined
      : add(previous?.costMicros ?? 0, next.costMicros ?? 0, "costMicros")
  if (costMicros && "error" in costMicros) return { error: costMicros.error }
  return {
    value: {
      inputTokens: inputTokens.value,
      outputTokens: outputTokens.value,
      reasoningTokens: reasoningTokens.value,
      cacheReadTokens: cacheReadTokens.value,
      cacheWriteTokens: cacheWriteTokens.value,
      ...(costMicros === undefined ? {} : { costMicros: costMicros.value }),
    },
  }
}

/** Build a serializable, payload-free continuation cursor for an adapter. */
export const makeContinuationCursor = (input: {
  readonly provider: Kind
  readonly executionID: string
  readonly epoch: number
  readonly outputDigest: string
}): ContinuationCursor => {
  if (!digestPattern.test(input.outputDigest))
    throw cursorError(
      { ...input, schemaVersion: 1, nextSequence: 0 },
      "continuation outputDigest must be a 64-character hexadecimal digest",
    )
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1)
    throw cursorError(
      { ...input, schemaVersion: 1, nextSequence: 0 },
      "continuation epoch must be a positive safe integer",
    )
  return {
    schemaVersion: 1,
    provider: input.provider,
    executionID: input.executionID,
    epoch: input.epoch,
    nextSequence: 0,
    outputDigest: input.outputDigest,
  }
}

/** Validate a cold-resume cursor against the newly selected child epoch. */
export const validateContinuationCursor = (
  cursor: ContinuationCursor,
  input: Pick<ExecuteInput, "provider" | "executionID" | "epoch">,
): string | undefined => {
  if (cursor.schemaVersion !== 1) return "unsupported continuation cursor schema version"
  if (cursor.provider !== input.provider) return "continuation provider does not match the execution provider"
  if (cursor.executionID !== input.executionID) return "continuation execution identity does not match"
  if (cursor.epoch !== input.epoch) return "continuation epoch does not match the execution epoch"
  if (!Number.isSafeInteger(cursor.nextSequence) || cursor.nextSequence < 0)
    return "continuation nextSequence must be a non-negative safe integer"
  if (!digestPattern.test(cursor.outputDigest)) return "continuation outputDigest is not a valid digest"
  return undefined
}

/**
 * A zero-sequence cursor is a fresh execution seed: no provider event has
 * been observed yet, so accepting it does not claim that an adapter can
 * reconstruct work after a process restart.  Any non-zero cursor is a real
 * cold continuation and requires explicit adapter capability evidence.
 */
export const validateContinuationCapability = (
  capabilities: Pick<AdapterCapabilities, "supportsColdResume">,
  cursor: ContinuationCursor,
): string | undefined =>
  cursor.nextSequence > 0 && !capabilities.supportsColdResume
    ? `provider continuation at sequence ${cursor.nextSequence} requires cold-resume capability`
    : undefined

/**
 * Advance a cursor using a structured provider event. Raw text/tool payloads
 * are intentionally not accepted, so this helper cannot accidentally become
 * a second transcript or secret-bearing event log.
 */
export const advanceContinuationCursor = (cursor: ContinuationCursor, event: ProviderEvent): ContinuationCursor => {
  const mismatch = validateContinuationCursor(cursor, event)
  if (mismatch) throw cursorError(cursor, mismatch)
  if (event.sequence !== cursor.nextSequence)
    throw cursorError(cursor, `provider event sequence must be ${cursor.nextSequence}`)
  if (event.outputDigest !== undefined && !digestPattern.test(event.outputDigest))
    throw cursorError(cursor, "provider event outputDigest is not a valid digest")
  if (cursor.nextSequence >= Number.MAX_SAFE_INTEGER)
    throw cursorError(cursor, "provider continuation sequence exceeds safe integer bounds")
  return {
    ...cursor,
    nextSequence: cursor.nextSequence + 1,
    ...(event.outputDigest === undefined ? {} : { outputDigest: event.outputDigest }),
  }
}

/**
 * Store a cursor in the existing DurableRun checkpoint state. The helper is
 * intentionally immutable and rejects a conflicting prior cursor instead of
 * silently replacing a cold-recovery identity.
 */
export const bindContinuationToCheckpointState = (
  state: Readonly<Record<string, unknown>>,
  cursor: ContinuationCursor,
): Readonly<Record<string, unknown>> => {
  const existing = state[CONTINUATION_CHECKPOINT_KEY]
  if (existing !== undefined) {
    let decoded: ContinuationCursor
    try {
      decoded = Schema.decodeUnknownSync(ContinuationCursorSchema, { onExcessProperty: "error" })(existing)
    } catch {
      throw new InvalidInputError({
        executionID: cursor.executionID,
        reason: "existing DurableRun checkpoint continuation cursor is invalid",
      })
    }
    const mismatch = validateContinuationCursor(decoded, cursor)
    if (mismatch) throw cursorError(cursor, `DurableRun checkpoint continuation conflict: ${mismatch}`)
    if (decoded.nextSequence !== cursor.nextSequence || decoded.outputDigest !== cursor.outputDigest)
      throw cursorError(cursor, "DurableRun checkpoint continuation cursor would be rewritten")
  }
  return { ...state, [CONTINUATION_CHECKPOINT_KEY]: cursor }
}

const checkpointStateValue = (state: Readonly<Record<string, unknown>>) => ({
  phase: state.phase,
  provider: state.provider,
  executionID: state.executionID,
  epoch: state.epoch,
  attempt: state.attempt,
  leaseID: state.leaseID,
  leaseOwnerID: state.leaseOwnerID,
  permissionDigest: state.permissionDigest,
  subagentContinuation: state[CONTINUATION_CHECKPOINT_KEY],
})

const validOpaqueID = (value: string, label: string) => {
  if (typeof value !== "string" || value.trim().length === 0) return `${label} must be a non-empty identifier`
  if (value.length > 512) return `${label} exceeds the 512-character bound`
  return undefined
}

/**
 * Bind cursor plus revalidation facts into the same DurableRun checkpoint.
 * Existing metadata is never silently rewritten: a caller must either write
 * the identical binding or fail closed before publishing a new checkpoint.
 */
export const bindContinuationCheckpointState = (
  state: Readonly<Record<string, unknown>>,
  cursor: ContinuationCursor,
  binding: Omit<ContinuationCheckpointBinding, "cursor">,
): Readonly<Record<string, unknown>> => {
  const invalid = [
    !Number.isSafeInteger(binding.attempt) || binding.attempt < 1
      ? "continuation checkpoint attempt must be a positive safe integer"
      : undefined,
    validOpaqueID(binding.leaseID, "continuation checkpoint leaseID"),
    validOpaqueID(binding.leaseOwnerID, "continuation checkpoint leaseOwnerID"),
    !digestPattern.test(binding.permissionDigest)
      ? "continuation checkpoint permissionDigest must be a 64-character hexadecimal digest"
      : undefined,
  ].find((reason): reason is string => reason !== undefined)
  if (invalid) throw cursorError(cursor, invalid)

  const hasExistingBinding =
    state[CONTINUATION_CHECKPOINT_KEY] !== undefined ||
    ["attempt", "leaseID", "leaseOwnerID", "permissionDigest"].some((key) => state[key] !== undefined)
  if (hasExistingBinding) {
    let existing: ContinuationCheckpointBinding & { readonly phase: "subagent-provider"; readonly provider: Kind }
    try {
      const decoded = Schema.decodeUnknownSync(ContinuationCheckpointSchema, { onExcessProperty: "error" })(
        checkpointStateValue(state),
      )
      existing = {
        cursor: decoded.subagentContinuation,
        attempt: decoded.attempt,
        leaseID: decoded.leaseID,
        leaseOwnerID: decoded.leaseOwnerID,
        permissionDigest: decoded.permissionDigest,
        phase: decoded.phase,
        provider: decoded.provider,
      }
    } catch {
      throw cursorError(cursor, "existing DurableRun checkpoint continuation binding is invalid")
    }
    const same =
      existing.provider === cursor.provider &&
      existing.cursor.executionID === cursor.executionID &&
      existing.cursor.epoch === cursor.epoch &&
      existing.cursor.nextSequence === cursor.nextSequence &&
      existing.cursor.outputDigest === cursor.outputDigest &&
      existing.attempt === binding.attempt &&
      existing.leaseID === binding.leaseID &&
      existing.leaseOwnerID === binding.leaseOwnerID &&
      existing.permissionDigest === binding.permissionDigest
    if (!same) throw cursorError(cursor, "DurableRun checkpoint continuation binding would be rewritten")
  }

  return {
    ...state,
    phase: "subagent-provider",
    provider: cursor.provider,
    executionID: cursor.executionID,
    epoch: cursor.epoch,
    attempt: binding.attempt,
    leaseID: binding.leaseID,
    leaseOwnerID: binding.leaseOwnerID,
    permissionDigest: binding.permissionDigest,
    [CONTINUATION_CHECKPOINT_KEY]: cursor,
  }
}

const continuationBindingFacts = (binding: Omit<ContinuationCheckpointBinding, "cursor">): string | undefined => {
  const invalid = [
    !Number.isSafeInteger(binding.attempt) || binding.attempt < 1
      ? "continuation checkpoint attempt must be a positive safe integer"
      : undefined,
    validOpaqueID(binding.leaseID, "continuation checkpoint leaseID"),
    validOpaqueID(binding.leaseOwnerID, "continuation checkpoint leaseOwnerID"),
    !digestPattern.test(binding.permissionDigest)
      ? "continuation checkpoint permissionDigest must be a 64-character hexadecimal digest"
      : undefined,
  ].find((reason): reason is string => reason !== undefined)
  return invalid
}

/**
 * Append an advanced provider cursor to the same DurableRun checkpoint
 * binding.  Cursor identity and the attempt/lease/permission facts remain
 * immutable; only a monotonic provider event sequence and its latest digest
 * may advance.  Replaying the exact cursor is idempotent, while regressions,
 * metadata rewrites, and identity changes fail closed.
 */
export const advanceContinuationCheckpointState = (
  state: Readonly<Record<string, unknown>>,
  cursor: ContinuationCursor,
  binding: Omit<ContinuationCheckpointBinding, "cursor">,
): Readonly<Record<string, unknown>> => {
  const bindingError = continuationBindingFacts(binding)
  if (bindingError) throw cursorError(cursor, bindingError)
  const cursorErrorText = validateContinuationCursor(cursor, {
    provider: cursor.provider,
    executionID: cursor.executionID,
    epoch: cursor.epoch,
  })
  if (cursorErrorText) throw cursorError(cursor, cursorErrorText)

  const hasExistingBinding =
    state[CONTINUATION_CHECKPOINT_KEY] !== undefined ||
    ["attempt", "leaseID", "leaseOwnerID", "permissionDigest"].some((key) => state[key] !== undefined)
  if (!hasExistingBinding) return bindContinuationCheckpointState(state, cursor, binding)

  const existing = readContinuationCheckpointState(state, {
    provider: cursor.provider,
    executionID: cursor.executionID,
    epoch: cursor.epoch,
  })
  if (
    existing.attempt !== binding.attempt ||
    existing.leaseID !== binding.leaseID ||
    existing.leaseOwnerID !== binding.leaseOwnerID ||
    existing.permissionDigest !== binding.permissionDigest
  )
    throw cursorError(cursor, "DurableRun checkpoint continuation binding facts would be rewritten")
  if (cursor.nextSequence < existing.cursor.nextSequence)
    throw cursorError(cursor, "DurableRun checkpoint continuation sequence would move backwards")
  if (cursor.nextSequence === existing.cursor.nextSequence && cursor.outputDigest !== existing.cursor.outputDigest)
    throw cursorError(cursor, "DurableRun checkpoint continuation digest would be rewritten")
  if (cursor.nextSequence === existing.cursor.nextSequence) return state
  return { ...state, [CONTINUATION_CHECKPOINT_KEY]: cursor }
}

/** Read and identity-check a cursor from an existing DurableRun checkpoint. */
export const readContinuationFromCheckpointState = (
  state: Readonly<Record<string, unknown>>,
  expected: Pick<ExecuteInput, "provider" | "executionID" | "epoch">,
): ContinuationCursor | undefined => {
  const existing = state[CONTINUATION_CHECKPOINT_KEY]
  if (existing === undefined) return undefined
  let decoded: ContinuationCursor
  try {
    decoded = Schema.decodeUnknownSync(ContinuationCursorSchema, { onExcessProperty: "error" })(existing)
  } catch {
    throw new InvalidInputError({
      executionID: expected.executionID,
      reason: "DurableRun checkpoint continuation cursor is invalid",
    })
  }
  const mismatch = validateContinuationCursor(decoded, expected)
  if (mismatch) throw new InvalidInputError({ executionID: expected.executionID, reason: mismatch })
  return decoded
}

/** Read the complete opaque cursor binding from a DurableRun checkpoint. */
export const readContinuationCheckpointState = (
  state: Readonly<Record<string, unknown>>,
  expected: Pick<ExecuteInput, "provider" | "executionID" | "epoch">,
): ContinuationCheckpointBinding => {
  let decoded: Schema.Schema.Type<typeof ContinuationCheckpointSchema>
  try {
    decoded = Schema.decodeUnknownSync(ContinuationCheckpointSchema, { onExcessProperty: "error" })(
      checkpointStateValue(state),
    )
  } catch {
    throw new InvalidInputError({
      executionID: expected.executionID,
      reason: "DurableRun checkpoint continuation binding is invalid",
    })
  }
  const mismatch = validateContinuationCursor(decoded.subagentContinuation, expected)
  if (mismatch) throw new InvalidInputError({ executionID: expected.executionID, reason: mismatch })
  if (
    decoded.executionID !== expected.executionID ||
    decoded.provider !== expected.provider ||
    decoded.epoch !== expected.epoch
  )
    throw new InvalidInputError({
      executionID: expected.executionID,
      reason: "DurableRun checkpoint continuation binding identity does not match",
    })
  if (decoded.attempt !== decoded.epoch)
    throw new InvalidInputError({
      executionID: expected.executionID,
      reason: "DurableRun checkpoint continuation attempt does not match its epoch",
    })
  if (!digestPattern.test(decoded.permissionDigest))
    throw new InvalidInputError({
      executionID: expected.executionID,
      reason: "DurableRun checkpoint permissionDigest is not a valid digest",
    })
  return {
    cursor: decoded.subagentContinuation,
    attempt: decoded.attempt,
    leaseID: decoded.leaseID,
    leaseOwnerID: decoded.leaseOwnerID,
    permissionDigest: decoded.permissionDigest,
  }
}

export interface ContinuationCheckpointRevalidationInput {
  readonly expected: Pick<ExecuteInput, "provider" | "executionID" | "epoch">
  readonly checkpoint: ContinuationCheckpointBinding
  readonly activeAttempt?: number
  readonly lease?: {
    readonly runID: string
    readonly leaseID: string
    readonly ownerID: string
    readonly expiresAtMs: number
  }
  readonly expectedLeaseID: string
  readonly expectedLeaseOwnerID: string
  readonly expectedPermissionDigest: string
  readonly currentPermissionDigest: string
  readonly nowMs?: number
}

/**
 * Validate all facts needed before a cold continuation may be dispatched.
 * This is deliberately pure: it cannot acquire a lease, grant permission or
 * settle a result, and therefore cannot become a second authority.
 */
export const validateContinuationCheckpointRevalidation = (
  input: ContinuationCheckpointRevalidationInput,
): string | undefined => {
  const cursorMismatch = validateContinuationCursor(input.checkpoint.cursor, input.expected)
  if (cursorMismatch) return cursorMismatch
  if (input.checkpoint.attempt !== input.expected.epoch)
    return "continuation checkpoint attempt does not match the execution epoch"
  if (input.activeAttempt !== input.expected.epoch)
    return "durable child active attempt does not match the continuation epoch"
  if (input.checkpoint.leaseID !== input.expectedLeaseID)
    return "continuation checkpoint lease identity does not match the worker lease"
  if (input.checkpoint.leaseOwnerID !== input.expectedLeaseOwnerID)
    return "continuation checkpoint lease owner does not match the worker"
  if (input.checkpoint.permissionDigest !== input.expectedPermissionDigest)
    return "continuation checkpoint permission policy has changed"
  if (input.currentPermissionDigest !== input.expectedPermissionDigest)
    return "child session permission policy has changed since checkpoint"
  if (!input.lease) return "durable child worker lease is missing"
  if (input.lease.runID !== input.expected.executionID) return "durable child worker lease belongs to a different run"
  if (input.lease.leaseID !== input.expectedLeaseID || input.lease.ownerID !== input.expectedLeaseOwnerID)
    return "durable child worker lease identity changed before provider dispatch"
  const nowMs = input.nowMs ?? Date.now()
  if (!Number.isFinite(input.lease.expiresAtMs) || input.lease.expiresAtMs <= nowMs)
    return "durable child worker lease expired before provider dispatch"
  return undefined
}

/**
 * Parent-only control is checked against the immutable child binding already
 * loaded by DurableRun. This is a guard, not a replacement authorization
 * system; callers still need the normal ActionGateway/control lease.
 */
export const validateDirectParentControl = (input: DirectParentControlInput): string | undefined => {
  if (typeof input.operation !== "string" || !parentControlOperations.has(input.operation))
    return "control operation is unsupported"
  if (!input.callerRunID || !input.childParentRunID || !input.childRunID)
    return "parent and child run identities are required"
  if (input.callerRunID !== input.childParentRunID) return "only the direct parent run may control a delegated child"
  if (input.callerRunID === input.childRunID) return "a child cannot control itself"
  return undefined
}

export const assertDirectParentControl = (input: DirectParentControlInput): void => {
  const reason = validateDirectParentControl(input)
  if (reason) throw new InvalidInputError({ executionID: input.childRunID || "child", reason })
}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "SubagentProvider.InvalidInputError",
  {
    executionID: Schema.String,
    reason: Schema.String,
  },
) {}

export class UnsupportedProviderError extends Schema.TaggedErrorClass<UnsupportedProviderError>()(
  "SubagentProvider.UnsupportedProviderError",
  {
    executionID: Schema.String,
    provider: Kind,
  },
) {}

export class ProviderConflictError extends Schema.TaggedErrorClass<ProviderConflictError>()(
  "SubagentProvider.ProviderConflictError",
  {
    executionID: Schema.String,
    expected: Kind,
    received: Kind,
  },
) {}

export class EpochConflictError extends Schema.TaggedErrorClass<EpochConflictError>()(
  "SubagentProvider.EpochConflictError",
  {
    executionID: Schema.String,
    expectedGreaterThan: Schema.Number,
    received: Schema.Number,
    reason: Schema.String,
  },
) {}

export class ProviderBusyError extends Schema.TaggedErrorClass<ProviderBusyError>()("SubagentProvider.BusyError", {
  executionID: Schema.String,
  epoch: Schema.Number,
  reason: Schema.String,
}) {}

export class ProviderDrainingError extends Schema.TaggedErrorClass<ProviderDrainingError>()(
  "SubagentProvider.DrainingError",
  {
    executionID: Schema.String,
    epoch: Schema.Number,
    reason: Schema.String,
  },
) {}

export class ProviderDisposedError extends Schema.TaggedErrorClass<ProviderDisposedError>()(
  "SubagentProvider.DisposedError",
  {
    executionID: Schema.String,
    reason: Schema.String,
  },
) {}

/** A native lifecycle hook failed or returned malformed metadata.  The
 * provider entry is kept failed/unknown by the caller before this error is
 * exposed, so a hook failure can never be mistaken for a successful child. */
export class ProviderLifecycleError extends Schema.TaggedErrorClass<ProviderLifecycleError>()(
  "SubagentProvider.LifecycleError",
  {
    executionID: Schema.String,
    provider: Kind,
    operation: Schema.Literals(["cancel", "drain", "dispose"] as const),
    reason: Schema.String,
  },
) {}

export type Error =
  | InvalidInputError
  | UnsupportedProviderError
  | ProviderConflictError
  | EpochConflictError
  | ProviderBusyError
  | ProviderDrainingError
  | ProviderDisposedError
  | ProviderLifecycleError

/**
 * The request is intentionally metadata-only. It carries no prompt, tool
 * arguments, credentials or result bytes; those remain in the existing
 * session/action/durable-run owners.
 */
export interface ExecuteInput {
  readonly provider: Kind
  readonly executionID: string
  /** Monotonic continuation epoch, normally bound to DurableRun attempt. */
  readonly epoch: number
  readonly sessionID: string
  readonly modelID: string
  readonly modelProviderID: string
  readonly childRunID?: string
  readonly parentRunID?: string
  readonly attempt?: number
  readonly continuation?: ContinuationCursor
}

export interface InspectInput {
  readonly executionID: string
  readonly provider?: Kind
}

export interface DrainInput {
  /** Drain one child execution when supplied; otherwise drain this provider. */
  readonly executionID?: string
  readonly provider?: Kind
  readonly epoch?: number
  readonly timeoutMs?: number
}

export interface Snapshot {
  readonly provider: Kind
  readonly executionID: string
  readonly epoch: number
  readonly phase: Phase
  readonly active: boolean
  /** Number of normalized metadata events accepted for this execution. */
  readonly nextSequence: number
  readonly startedAtMs: number
  readonly finishedAtMs?: number
  readonly childRunID?: string
  readonly reason?: string
  readonly continuation?: ContinuationCursor
  readonly usage?: Usage
  readonly stopReason?: StopReason
}

export interface ParentControlResult {
  readonly snapshot?: Snapshot
  readonly timedOut: boolean
}

export interface DrainResult {
  readonly provider?: Kind
  readonly executionID?: string
  readonly epoch?: number
  readonly status: "drained" | "timed_out"
  readonly active: number
}

export interface Interface {
  /**
   * Execute an already-authorized child operation through a provider adapter.
   * The supplied effect is still responsible for Session/ActionGateway work.
   */
  readonly execute: <A, E, R>(
    input: ExecuteInput,
    operation: Effect.Effect<A, E, R>,
    options?: ExecuteOptions,
  ) => Effect.Effect<A, E | Error, R>
  /** Provider adapter capability metadata; this is not an authorization grant. */
  readonly capabilities: (provider: Kind) => AdapterCapabilities
  /** Return a redacted, ephemeral provider projection for one child execution. */
  readonly inspect: (input: InspectInput) => Effect.Effect<Snapshot | undefined>
  /** Wait for a child, after validating that the caller is its direct parent. */
  readonly wait: (input: ParentWaitInput) => Effect.Effect<ParentControlResult, Error>
  /** Interrupt a child through the provider boundary, after direct-parent validation. */
  readonly cancel: (input: ParentCancelInput) => Effect.Effect<ParentControlResult, Error>
  /**
   * Optionally deliver an already-admitted steer/followup to a native
   * provider.  `unavailable`/`unsupported` are normal outcomes and require
   * the caller to use the durable SessionInput wakeup path instead.
   */
  readonly control: (input: ParentMessageControlInput) => Effect.Effect<ParentMessageControlResult, Error>
  /** Wait for active provider work; a timeout preserves outcome_unknown. */
  readonly drain: (input: DrainInput) => Effect.Effect<DrainResult, Error>
  /** Mark active work unknown and reject new executions after runtime disposal. */
  readonly dispose: Effect.Effect<void, Error>
}

/** Implemented by a concrete in-process or remote adapter. */
export interface Adapter {
  readonly kind: Kind
  readonly capabilities: AdapterCapabilities
  readonly execute: <A, E, R>(
    input: ExecuteInput,
    operation: Effect.Effect<A, E, R>,
    events?: ProviderEventSink,
  ) => Effect.Effect<A, E | Error, R>
  /**
   * Native message control receives metadata only.  It must not accept or
   * persist prompt bytes; the durable SessionInput admission remains the
   * source of truth and is used whenever this hook is absent/unsupported.
   */
  readonly control?: (input: ParentMessageControlInput) => Effect.Effect<AdapterControlResult, Error>
  /** Optional native cancellation hook.  Core still signals the local
   * operation after this hook; a failed hook keeps the result unknown. */
  readonly cancel?: (input: ParentCancelInput) => Effect.Effect<AdapterControlResult, unknown>
  /** Optional native graceful-drain hook. */
  readonly drain?: (input: AdapterDrainInput) => Effect.Effect<AdapterControlResult, unknown>
  /** Optional native disposal hook. */
  readonly dispose?: (input: AdapterDisposeInput) => Effect.Effect<AdapterControlResult, unknown>
}

export type AdapterLifecycleOperation = "cancel" | "drain" | "dispose"

const lifecycleCapabilityKeys = [
  ["supportsCancel", "cancel"],
  ["supportsDrain", "drain"],
  ["supportsDispose", "dispose"],
] as const satisfies ReadonlyArray<readonly ["supportsCancel" | "supportsDrain" | "supportsDispose", "cancel" | "drain" | "dispose"]>

/** Validate the capability/hook symmetry before an adapter can enter the
 * runtime.  This prevents an adapter from silently claiming a lifecycle
 * operation that Core cannot actually dispatch (or from hiding an unadvertised
 * side effect behind a legacy adapter). */
export const validateAdapterLifecycleContract = (adapter: Adapter): string | undefined => {
  for (const [capability, hook] of lifecycleCapabilityKeys) {
    const value = adapter.capabilities[capability]
    if (value !== undefined && typeof value !== "boolean")
      return `provider adapter ${adapter.kind} ${capability} must be boolean`
    const advertised = value === true
    const present = typeof adapter[hook] === "function"
    if (advertised !== present)
      return advertised
        ? `provider adapter ${adapter.kind} advertises native ${hook} without a ${hook} hook`
        : `provider adapter ${adapter.kind} provides native ${hook} without advertising ${capability}`
  }
  return undefined
}

const lifecycleError = (executionID: string, provider: Kind, operation: AdapterLifecycleOperation, reason: string) =>
  new ProviderLifecycleError({ executionID, provider, operation, reason })

const normalizeAdapterLifecycleResult = (
  executionID: string,
  provider: Kind,
  operation: AdapterLifecycleOperation,
  value: AdapterControlResult,
): AdapterControlResult | InvalidInputError => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return idError(executionID, `provider ${provider} ${operation} result failed strict metadata validation`)
  const keys = Object.keys(value as unknown as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== "status" || (value.status !== "accepted" && value.status !== "unsupported"))
    return idError(executionID, `provider ${provider} ${operation} result failed strict metadata validation`)
  return { status: value.status }
}

type AdapterLifecycleHookInput = ParentCancelInput | AdapterDrainInput | AdapterDisposeInput

/** Invoke one native lifecycle hook with a bounded deadline and a closed,
 * payload-free result.  Unsupported hooks are deliberately a normal result:
 * Core keeps its existing local signal/timeout fallback for those adapters. */
const invokeAdapterLifecycle = (
  adapter: Adapter,
  operation: AdapterLifecycleOperation,
  input: AdapterLifecycleHookInput,
  executionID: string,
  timeoutMs: number,
): Effect.Effect<AdapterControlResult, ProviderLifecycleError | InvalidInputError> => {
  const hook = operation === "cancel" ? adapter.cancel : operation === "drain" ? adapter.drain : adapter.dispose
  if (typeof hook !== "function") return Effect.succeed({ status: "unsupported" as const })
  return Effect.suspend(() => {
    let effect: Effect.Effect<AdapterControlResult, unknown>
    try {
      effect = hook(input as never)
    } catch {
      return Effect.fail(
        lifecycleError(executionID, adapter.kind, operation, `native ${operation} hook threw before returning an effect`),
      )
    }
    return effect.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              lifecycleError(
                executionID,
                adapter.kind,
                operation,
                `native ${operation} hook exceeded its bounded deadline`,
              ),
            ),
      ),
      Effect.mapError((error) =>
        error instanceof ProviderLifecycleError || error instanceof InvalidInputError
          ? error
          : lifecycleError(executionID, adapter.kind, operation, `native ${operation} hook failed`),
      ),
      Effect.flatMap((result) => {
        const normalized = normalizeAdapterLifecycleResult(executionID, adapter.kind, operation, result)
        return normalized instanceof InvalidInputError ? Effect.fail(normalized) : Effect.succeed(normalized)
      }),
    )
  })
}

type AdapterLifecycleOutcome =
  | { readonly result: AdapterControlResult }
  | { readonly error: ProviderLifecycleError | InvalidInputError }

const observeAdapterLifecycle = (
  effect: Effect.Effect<AdapterControlResult, ProviderLifecycleError | InvalidInputError>,
): Effect.Effect<AdapterLifecycleOutcome> =>
  effect.pipe(
    Effect.map((result) => ({ result }) as const),
    Effect.catch((error) => Effect.succeed({ error })),
  )

const capabilityCatalog: Record<Kind, Omit<AdapterCapabilities, "provider" | "available">> = {
  "in-process": {
    supportsColdResume: false,
    supportsEvents: true,
    supportsUsage: true,
    supportsStopReason: true,
    supportsSteer: false,
    supportsFollowup: false,
    supportsCancel: false,
    supportsDrain: false,
    supportsDispose: false,
  },
  acp: {
    supportsColdResume: false,
    supportsEvents: false,
    supportsUsage: false,
    supportsStopReason: false,
    supportsSteer: false,
    supportsFollowup: false,
    supportsCancel: false,
    supportsDrain: false,
    supportsDispose: false,
  },
  codex: {
    supportsColdResume: false,
    supportsEvents: false,
    supportsUsage: false,
    supportsStopReason: false,
    supportsSteer: false,
    supportsFollowup: false,
    supportsCancel: false,
    supportsDrain: false,
    supportsDispose: false,
  },
  claude: {
    supportsColdResume: false,
    supportsEvents: false,
    supportsUsage: false,
    supportsStopReason: false,
    supportsSteer: false,
    supportsFollowup: false,
    supportsCancel: false,
    supportsDrain: false,
    supportsDispose: false,
  },
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/SubagentProvider") {}

type Entry = {
  readonly input: ExecuteInput
  readonly phase: Phase
  readonly active: boolean
  readonly nextSequence: number
  readonly startedAtMs: number
  readonly finishedAtMs?: number
  readonly reason?: string
  readonly continuation?: ContinuationCursor
  readonly usage?: Usage
  readonly stopReason?: StopReason
  /** Accepted native controls are replayed without calling the adapter twice. */
  readonly controlRequests: ReadonlyMap<
    string,
    { readonly fingerprint: string; readonly result: ParentMessageControlResult }
  >
  readonly done: import("effect/Deferred").Deferred<void>
  /** Completion signal used to interrupt the in-flight adapter operation. */
  readonly cancelSignal: import("effect/Deferred").Deferred<void>
}

type AcceptedEvent = {
  readonly event: ProviderEvent
  readonly continuation?: ContinuationCursor
}

type State = {
  readonly disposed: boolean
  readonly entries: ReadonlyMap<string, Entry>
}

const keyFor = (executionID: string) => executionID

const idError = (executionID: string, reason: string) => new InvalidInputError({ executionID, reason })

const validIdentifier = (value: string, label: string) => {
  if (typeof value !== "string" || value.trim().length === 0) return `${label} must be a non-empty identifier`
  if (value.length > 512) return `${label} exceeds the 512-character bound`
  return undefined
}

const parentControlBindingError = (input: ParentControlInput, entry: Entry): string | undefined => {
  const directParentError = validateDirectParentControl(input)
  if (directParentError) return directParentError
  const targetError = validIdentifier(input.executionID, "executionID")
  if (targetError) return targetError
  if (entry.input.executionID !== input.executionID)
    return "provider control execution identity does not match the requested child"
  if (entry.input.parentRunID !== input.childParentRunID)
    return "provider control parent identity does not match the child binding"
  const boundChildRunID = entry.input.childRunID ?? entry.input.executionID
  if (boundChildRunID !== input.childRunID) return "provider control child identity does not match the child binding"
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 60_000)
  )
    return "timeoutMs must be between 0 and 60000"
  return undefined
}

const parentMessageControlKeys = new Set([
  "operation",
  "callerRunID",
  "childParentRunID",
  "childRunID",
  "executionID",
  "epoch",
  "requestID",
  "messageID",
  "promptDigest",
  "envelopeDigest",
  "delivery",
])

const validateParentMessageControl = (input: ParentMessageControlInput): string | undefined => {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return "provider message control must be a metadata object"
  const unexpectedKey = Object.keys(input as unknown as Record<string, unknown>).find(
    (key) => !parentMessageControlKeys.has(key),
  )
  if (unexpectedKey) return `provider message control contains unsupported metadata key: ${unexpectedKey}`
  const directParentError = validateDirectParentControl(input)
  if (directParentError) return directParentError
  const executionError = validIdentifier(input.executionID, "executionID")
  if (executionError) return executionError
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) return "epoch must be a positive safe integer"
  const requestError = validIdentifier(input.requestID, "requestID")
  if (requestError) return requestError
  const messageError = validIdentifier(input.messageID, "messageID")
  if (messageError) return messageError
  if (!digestPattern.test(input.promptDigest)) return "promptDigest must be a 64-character hexadecimal digest"
  if (!digestPattern.test(input.envelopeDigest)) return "envelopeDigest must be a 64-character hexadecimal digest"
  if (input.delivery !== (input.operation === "steer" ? "steer" : "queue"))
    return "delivery must match the parent message operation"
  return undefined
}

const adapterSupportsMessageControl = (
  capabilities: AdapterCapabilities,
  operation: ParentMessageControlInput["operation"],
) => (operation === "steer" ? capabilities.supportsSteer : capabilities.supportsFollowup === true)

const normalizeAdapterControlResult = (
  executionID: string,
  provider: Kind,
  value: AdapterControlResult,
): ParentMessageControlResult | InvalidInputError => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return idError(executionID, `provider ${provider} control result failed strict metadata validation`)
  const keys = Object.keys(value as unknown as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== "status" || (value.status !== "accepted" && value.status !== "unsupported"))
    return idError(executionID, `provider ${provider} control result failed strict metadata validation`)
  return { executionID, provider, status: value.status }
}

const controlRequestKey = (input: ParentMessageControlInput) => `${input.operation}\u0000${input.requestID}`

const controlRequestFingerprint = (input: ParentMessageControlInput) =>
  canonicalHash({
    domain: "arforge.provider-parent-message/v1",
    operation: input.operation,
    callerRunID: input.callerRunID,
    childParentRunID: input.childParentRunID,
    childRunID: input.childRunID,
    executionID: input.executionID,
    epoch: input.epoch,
    requestID: input.requestID,
    messageID: input.messageID,
    promptDigest: input.promptDigest,
    envelopeDigest: input.envelopeDigest,
    delivery: input.delivery,
  })

const validateInput = (input: ExecuteInput) => {
  const errors = [
    validIdentifier(input.executionID, "executionID"),
    validIdentifier(input.sessionID, "sessionID"),
    validIdentifier(input.modelID, "modelID"),
    validIdentifier(input.modelProviderID, "modelProviderID"),
  ].filter((value): value is string => value !== undefined)
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) errors.push("epoch must be a positive safe integer")
  if (input.continuation) {
    const continuationError = validateContinuationCursor(input.continuation, input)
    if (continuationError) errors.push(continuationError)
  }
  return errors.length ? errors.join("; ") : undefined
}

type ProviderInvariantContext =
  | { readonly kind: "input"; readonly input: ExecuteInput }
  | { readonly kind: "control"; readonly input: ParentMessageControlInput }
  | { readonly kind: "entry"; readonly entry: Snapshot }

/** Register the provider's phase-boundary checks into the shared registry. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (!registry.get("subagent-provider", "execution-input", "1"))
    registry.register({
      owner: "subagent-provider",
      key: "execution-input",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as ProviderInvariantContext).kind !== "input"
          )
            throw new Error("provider execution invariant context is invalid")
          const input = (context as Extract<ProviderInvariantContext, { readonly kind: "input" }>).input
          const invalid = validateInput(input)
          if (invalid) throw new Error(invalid)
          if (input.childRunID !== undefined && input.parentRunID === undefined)
            throw new Error("child provider execution must retain its parent binding")
        }),
    })

  if (!registry.get("subagent-provider", "message-control", "1"))
    registry.register({
      owner: "subagent-provider",
      key: "message-control",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as ProviderInvariantContext).kind !== "control"
          )
            throw new Error("provider message-control invariant context is invalid")
          const input = (context as Extract<ProviderInvariantContext, { readonly kind: "control" }>).input
          const invalid = validateParentMessageControl(input)
          if (invalid) throw new Error(invalid)
          if (!controlRequestFingerprint(input)) throw new Error("provider message-control identity is not hashable")
        }),
    })

  if (!registry.get("subagent-provider", "lifecycle", "1"))
    registry.register({
      owner: "subagent-provider",
      key: "lifecycle",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as ProviderInvariantContext).kind !== "entry"
          )
            throw new Error("provider lifecycle invariant context is invalid")
          const entry = (context as Extract<ProviderInvariantContext, { readonly kind: "entry" }>).entry
          if (!Number.isSafeInteger(entry.epoch) || entry.epoch < 1)
            throw new Error("provider lifecycle epoch must be a positive safe integer")
          if (!Number.isSafeInteger(entry.nextSequence) || entry.nextSequence < 0)
            throw new Error("provider lifecycle sequence must be a non-negative safe integer")
          const activePhase = entry.phase === "running" || entry.phase === "draining"
          if (entry.active !== activePhase) throw new Error("provider lifecycle active flag disagrees with phase")
          if (entry.active && entry.finishedAtMs !== undefined)
            throw new Error("active provider execution cannot have a finished timestamp")
          if (!entry.active && activePhase)
            throw new Error("inactive provider execution cannot remain in an active phase")
        }),
    })
}

const runtimeInvariantMode = (): RuntimeInvariants.InvariantMode =>
  process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"

const assertProviderInvariant = (
  registry: RuntimeInvariants.RuntimeInvariantRegistry,
  executionID: string,
  context: ProviderInvariantContext,
): Effect.Effect<void, InvalidInputError> =>
  registry
    .assert(context, {
      owner: "subagent-provider",
      key: context.kind === "input" ? "execution-input" : context.kind === "control" ? "message-control" : "lifecycle",
      mode: runtimeInvariantMode(),
    })
    .pipe(
      Effect.mapError((error) =>
        idError(
          executionID,
          `provider runtime invariant failed (${error instanceof RuntimeInvariants.RuntimeInvariantError ? error.code : "CHECK_FAILED"})`,
        ),
      ),
      Effect.asVoid,
    )

const snapshotOf = (entry: Entry): Snapshot => ({
  provider: entry.input.provider,
  executionID: entry.input.executionID,
  epoch: entry.input.epoch,
  phase: entry.phase,
  active: entry.active,
  nextSequence: entry.nextSequence,
  startedAtMs: entry.startedAtMs,
  ...(entry.finishedAtMs === undefined ? {} : { finishedAtMs: entry.finishedAtMs }),
  ...(entry.input.childRunID === undefined ? {} : { childRunID: entry.input.childRunID }),
  ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  ...(entry.continuation === undefined ? {} : { continuation: entry.continuation }),
  ...(entry.usage === undefined ? {} : { usage: entry.usage }),
  ...(entry.stopReason === undefined ? {} : { stopReason: entry.stopReason }),
})

/**
 * Build the default in-process adapter. It is deliberately an ordinary
 * service, not a durable store: disposing/rebuilding the runtime must never
 * be mistaken for a completed child run.
 */
export const InProcessAdapter: Adapter = {
  kind: "in-process",
  capabilities: {
    provider: "in-process",
    available: true,
    ...capabilityCatalog["in-process"],
  },
  execute: <A, E, R>(
    _input: ExecuteInput,
    operation: Effect.Effect<A, E, R>,
    events?: ProviderEventSink,
  ): Effect.Effect<A, E | InvalidInputError, R> => {
    const started: Effect.Effect<void, InvalidInputError> = events
      ? events.emit({ kind: "started" }).pipe(Effect.asVoid)
      : Effect.void
    const completed = (exit: Exit.Exit<A, E>): Effect.Effect<void, InvalidInputError> => {
      if (!events) return Effect.void
      const event: ProviderEventDraft = Exit.isSuccess(exit)
        ? { kind: "completed", stopReason: "completed" }
        : Cause.hasInterruptsOnly(exit.cause)
          ? { kind: "cancelled", stopReason: "cancelled" }
          : { kind: "failed", stopReason: "provider_error" }
      return events.emit(event).pipe(Effect.asVoid)
    }
    return started.pipe(Effect.andThen(operation.pipe(Effect.onExit(completed))))
  },
}

export const make = (options?: {
  readonly adapters?: ReadonlyArray<Adapter>
  /** Optional shared registry; the composition-root layer supplies the global one. */
  readonly invariants?: RuntimeInvariants.RuntimeInvariantRegistry
}): Effect.Effect<Interface, InvalidInputError> =>
  Effect.gen(function* () {
    const invariants = options?.invariants ?? RuntimeInvariants.createRuntimeInvariantRegistry()
    registerInvariants(invariants)
    const adapters = new Map<Kind, Adapter>()
    for (const adapter of options?.adapters ?? [InProcessAdapter]) {
      if (adapter.capabilities.provider !== adapter.kind)
        return yield* Effect.fail(
          new InvalidInputError({
            executionID: "provider",
            reason: `provider adapter capability identity does not match ${adapter.kind}`,
          }),
        )
      const lifecycleContractError = validateAdapterLifecycleContract(adapter)
      if (lifecycleContractError)
        return yield* Effect.fail(new InvalidInputError({ executionID: "provider", reason: lifecycleContractError }))
      if (
        (adapter.capabilities.supportsSteer || adapter.capabilities.supportsFollowup === true) &&
        typeof adapter.control !== "function"
      )
        return yield* Effect.fail(
          new InvalidInputError({
            executionID: "provider",
            reason: `provider adapter ${adapter.kind} advertises native message control without a control hook`,
          }),
        )
      if (adapters.has(adapter.kind))
        return yield* Effect.fail(
          new InvalidInputError({ executionID: "provider", reason: `duplicate provider adapter: ${adapter.kind}` }),
        )
      adapters.set(adapter.kind, adapter)
    }
    const state = yield* SynchronizedRef.make<State>({ disposed: false, entries: new Map() })
    // Continuations for one child are FIFO; independent child identities can
    // still execute concurrently. The mutex is process-local and never
    // replaces the durable child/run lease.
    const continuationLocks = KeyedMutex.makeUnsafe<string>()
    // Native control requests have their own lock.  They must remain usable
    // while an adapter execution is running (the continuation lock spans the
    // full execute lifecycle), but identical request identities still need a
    // single adapter dispatch.
    const controlLocks = KeyedMutex.makeUnsafe<string>()
    const capabilities = (provider: Kind): AdapterCapabilities => ({
      provider,
      available: adapters.get(provider)?.capabilities.available === true,
      ...capabilityCatalog[provider],
      ...(adapters.has(provider) ? adapters.get(provider)!.capabilities : {}),
    })

    type EventResult =
      | ({ readonly ok: true } & AcceptedEvent & { readonly entry: Entry })
      | { readonly ok: false; readonly error: InvalidInputError }

    const emitEvent = Effect.fn("SubagentProvider.emitEvent")(function* (
      input: ExecuteInput,
      draft: ProviderEventDraft,
    ) {
      const result = yield* SynchronizedRef.modify(state, (current): readonly [EventResult, State] => {
        const previous = current.entries.get(keyFor(input.executionID))
        const terminalDuringDrain = draft.kind === "completed" || draft.kind === "failed" || draft.kind === "cancelled"
        if (
          !previous ||
          !previous.active ||
          (previous.phase !== "running" && !(previous.phase === "draining" && terminalDuringDrain)) ||
          previous.input.epoch !== input.epoch
        )
          return [
            {
              ok: false,
              error: idError(input.executionID, "provider event arrived after the execution was no longer active"),
            },
            current,
          ] as const

        let event: ProviderEvent
        try {
          event = normalizeProviderEvent({ identity: input, sequence: previous.nextSequence, event: draft })
        } catch (error) {
          return [
            {
              ok: false,
              error:
                error instanceof InvalidInputError
                  ? error
                  : idError(input.executionID, "provider event metadata normalization failed"),
            },
            current,
          ] as const
        }

        let usage = previous.usage
        if (event.usage !== undefined) {
          const merged = mergeUsage(previous.usage, event.usage)
          if (merged.error) return [{ ok: false, error: idError(input.executionID, merged.error) }, current] as const
          usage = merged.value
        }
        let continuation = previous.continuation
        if (continuation !== undefined) {
          try {
            continuation = advanceContinuationCursor(continuation, event)
          } catch (error) {
            return [
              {
                ok: false,
                error:
                  error instanceof InvalidInputError
                    ? error
                    : idError(input.executionID, "provider event could not advance the continuation cursor"),
              },
              current,
            ] as const
          }
        }
        const updated: Entry = {
          ...previous,
          nextSequence: previous.nextSequence + 1,
          ...(continuation === undefined ? {} : { continuation }),
          ...(usage === undefined ? {} : { usage }),
          ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
        }
        return [
          { ok: true, event, entry: updated, ...(continuation === undefined ? {} : { continuation }) },
          { disposed: current.disposed, entries: new Map(current.entries).set(keyFor(input.executionID), updated) },
        ] as const
      })
      if (!result.ok) return yield* Effect.fail(result.error)
      yield* assertProviderInvariant(invariants, input.executionID, {
        kind: "entry",
        entry: snapshotOf(result.entry),
      })
      return result
    })

    const reserve = Effect.fn("SubagentProvider.reserve")(function* (input: ExecuteInput) {
      const invalid = validateInput(input)
      if (invalid) return yield* Effect.fail(idError(input.executionID, invalid))
      const adapter = adapters.get(input.provider)
      if (!adapter || adapter.capabilities.available !== true)
        return yield* Effect.fail(
          new UnsupportedProviderError({ executionID: input.executionID, provider: input.provider }),
        )
      if (input.continuation) {
        const continuationError = validateContinuationCapability(adapter.capabilities, input.continuation)
        if (continuationError) return yield* Effect.fail(idError(input.executionID, continuationError))
      }

      const done = yield* Deferred.make<void>()
      const cancelSignal = yield* Deferred.make<void>()
      type ReserveResult = { readonly ok: true; readonly entry: Entry } | { readonly ok: false; readonly error: Error }
      const result = yield* SynchronizedRef.modify(state, (current): readonly [ReserveResult, State] => {
        const key = keyFor(input.executionID)
        const previous = current.entries.get(key)
        if (current.disposed)
          return [
            {
              ok: false,
              error: new ProviderDisposedError({
                executionID: input.executionID,
                reason: "provider runtime is disposed",
              }),
            },
            current,
          ] as const
        if (previous && previous.input.provider !== input.provider)
          return [
            {
              ok: false,
              error: new ProviderConflictError({
                executionID: input.executionID,
                expected: previous.input.provider,
                received: input.provider,
              }),
            },
            current,
          ] as const
        if (previous && previous.phase === "outcome_unknown")
          return [
            {
              ok: false,
              error: new ProviderDrainingError({
                executionID: input.executionID,
                epoch: previous.input.epoch,
                reason: "previous provider outcome is unknown; reconcile the durable child before continuing",
              }),
            },
            current,
          ] as const
        if (previous && previous.active)
          return [
            {
              ok: false,
              error: new ProviderBusyError({
                executionID: input.executionID,
                epoch: previous.input.epoch,
                reason:
                  previous.phase === "draining" ? "provider execution is draining" : "provider execution is active",
              }),
            },
            current,
          ] as const
        if (previous && input.epoch <= previous.input.epoch)
          return [
            {
              ok: false,
              error: new EpochConflictError({
                executionID: input.executionID,
                expectedGreaterThan: previous.input.epoch,
                received: input.epoch,
                reason: "a completed provider epoch cannot be replayed",
              }),
            },
            current,
          ] as const

        const entry: Entry = {
          input,
          phase: "running",
          active: true,
          nextSequence: input.continuation?.nextSequence ?? 0,
          startedAtMs: Date.now(),
          ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
          controlRequests: new Map(),
          done,
          cancelSignal,
        }
        return [
          { ok: true, entry },
          { disposed: false, entries: new Map(current.entries).set(key, entry) },
        ] as const
      })
      if (!result.ok) return yield* Effect.fail(result.error)
      yield* assertProviderInvariant(invariants, input.executionID, {
        kind: "entry",
        entry: snapshotOf(result.entry),
      })
      return result.entry
    })

    const finish = (input: ExecuteInput, exit: Exit.Exit<unknown, unknown>) =>
      Effect.gen(function* () {
        const transition = yield* SynchronizedRef.modify(
          state,
          (
            current,
          ): readonly [{ readonly done: Deferred.Deferred<void>; readonly entry: Entry } | undefined, State] => {
            const key = keyFor(input.executionID)
            const previous = current.entries.get(key)
            if (!previous || previous.input.epoch !== input.epoch || !previous.active)
              return [undefined, current] as const
            const phase: Phase =
              previous.phase === "outcome_unknown"
                ? "outcome_unknown"
                : Exit.isSuccess(exit)
                  ? "completed"
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "cancelled"
                    : "failed"
            const stopReason: StopReason =
              previous.stopReason ??
              (phase === "outcome_unknown"
                ? "unknown"
                : phase === "completed"
                  ? "completed"
                  : phase === "cancelled"
                    ? "cancelled"
                    : "provider_error")
            const reason =
              phase === "outcome_unknown"
                ? previous.reason
                : Exit.isFailure(exit)
                  ? Cause.pretty(exit.cause).slice(0, 1_000)
                  : undefined
            const updated: Entry = {
              ...previous,
              phase,
              active: false,
              finishedAtMs: Date.now(),
              stopReason,
              ...(reason === undefined ? {} : { reason }),
            }
            return [
              { done: updated.done, entry: updated },
              { disposed: current.disposed, entries: new Map(current.entries).set(key, updated) },
            ] as const
          },
        )
        if (transition) {
          // A terminal transition is already durable in this process.  Keep
          // the provider outcome authoritative, but leave a bounded warning
          // if its diagnostic registry detects a bad projection.
          yield* assertProviderInvariant(invariants, input.executionID, {
            kind: "entry",
            entry: snapshotOf(transition.entry),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("SubagentProvider terminal invariant failed", {
                executionID: input.executionID,
                reason: Cause.pretty(cause),
              }),
            ),
          )
          yield* Deferred.succeed(transition.done, undefined).pipe(Effect.ignore)
        }
      })

    const execute: Interface["execute"] = <A, E, R>(
      input: ExecuteInput,
      operation: Effect.Effect<A, E, R>,
      options?: ExecuteOptions,
    ) => {
      const adapter = adapters.get(input.provider)
      if (!adapter)
        return Effect.fail(new UnsupportedProviderError({ executionID: input.executionID, provider: input.provider }))
      const preflight: Effect.Effect<void, Error> = Effect.gen(function* () {
        yield* assertProviderInvariant(invariants, input.executionID, { kind: "input", input })
        const previous = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
        if (previous && previous.input.provider !== input.provider)
          return yield* Effect.fail(
            new ProviderConflictError({
              executionID: input.executionID,
              expected: previous.input.provider,
              received: input.provider,
            }),
          )
        if (previous?.phase === "outcome_unknown")
          return yield* Effect.fail(
            new ProviderDrainingError({
              executionID: input.executionID,
              epoch: previous.input.epoch,
              reason: "previous provider outcome is unknown; reconcile the durable child before continuing",
            }),
          )
        if (previous?.phase === "draining")
          return yield* Effect.fail(
            new ProviderBusyError({
              executionID: input.executionID,
              epoch: previous.input.epoch,
              reason: "provider execution is draining",
            }),
          )
      })
      return preflight.pipe(
        Effect.andThen(
          continuationLocks.withLock(input.executionID)(
            reserve(input).pipe(
              Effect.flatMap((entry) => {
                const events: ProviderEventSink = {
                  emit: (event) =>
                    emitEvent(input, event).pipe(
                      Effect.tap((accepted) =>
                        options?.onEvent
                          ? options
                              .onEvent(accepted.event, accepted.continuation)
                              .pipe(
                                Effect.mapError(() =>
                                  idError(input.executionID, "provider event checkpoint persistence failed"),
                                ),
                              )
                          : Effect.void,
                      ),
                      Effect.map((accepted) => accepted.event),
                    ),
                }
                const execution = adapter
                  .execute(input, operation, events)
                  .pipe(Effect.onExit((exit) => finish(input, exit)))
                // A direct-parent cancel races the adapter operation. The
                // losing branch is interrupted by Effect.raceFirst, so a
                // cooperative provider cannot continue producing side effects
                // after the durable owner has accepted cancellation.
                const cancelled = Deferred.await(entry.cancelSignal).pipe(Effect.andThen(Effect.interrupt))
                return Effect.raceFirst(execution, cancelled)
              }),
            ),
          ),
        ),
      )
    }

    const inspect: Interface["inspect"] = Effect.fn("SubagentProvider.inspect")(function* (input) {
      const entry = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      if (!entry) return undefined
      if (input.provider && input.provider !== entry.input.provider) return undefined
      return snapshotOf(entry)
    })

    const dispatchControl: Interface["control"] = Effect.fn("SubagentProvider.control.dispatch")(function* (input) {
      const invalid = validateParentMessageControl(input)
      if (invalid) return yield* Effect.fail(idError(input.executionID || "child", invalid))
      yield* assertProviderInvariant(invariants, input.executionID, { kind: "control", input })
      const fingerprint = controlRequestFingerprint(input)
      if (!fingerprint)
        return yield* Effect.fail(
          idError(input.executionID, "provider message control identity is not canonically hashable"),
        )
      const entry = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      if (!entry) return { executionID: input.executionID, status: "unavailable" as const }
      const bindingError = parentControlBindingError(input, entry)
      if (bindingError) return yield* Effect.fail(idError(input.executionID, bindingError))
      if (entry.input.epoch !== input.epoch)
        return yield* Effect.fail(
          idError(input.executionID, "provider message control epoch does not match the active execution"),
        )
      const requestKey = controlRequestKey(input)
      const previous = entry.controlRequests.get(requestKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return yield* Effect.fail(
            idError(
              input.executionID,
              "provider message control request identity is already bound to different digests",
            ),
          )
        return previous.result
      }
      if (!entry.active || entry.phase !== "running")
        return {
          executionID: input.executionID,
          provider: entry.input.provider,
          status: "unavailable" as const,
        }
      const adapter = adapters.get(entry.input.provider)
      if (!adapter || !adapterSupportsMessageControl(adapter.capabilities, input.operation))
        return {
          executionID: input.executionID,
          provider: entry.input.provider,
          status: "unsupported" as const,
        }
      if (typeof adapter.control !== "function")
        return {
          executionID: input.executionID,
          provider: entry.input.provider,
          status: "unsupported" as const,
        }
      const result = yield* adapter.control(input)
      const normalized = normalizeAdapterControlResult(input.executionID, entry.input.provider, result)
      if (normalized instanceof InvalidInputError) return yield* Effect.fail(normalized)
      if (normalized.status === "accepted")
        yield* SynchronizedRef.update(state, (current) => {
          const currentEntry = current.entries.get(keyFor(input.executionID))
          if (!currentEntry || currentEntry.input.epoch !== input.epoch) return current
          if (currentEntry.controlRequests.has(requestKey)) return current
          const controlRequests = new Map(currentEntry.controlRequests)
          controlRequests.set(requestKey, { fingerprint, result: normalized })
          return {
            disposed: current.disposed,
            entries: new Map(current.entries).set(keyFor(input.executionID), { ...currentEntry, controlRequests }),
          }
        })
      return normalized
    })

    const control: Interface["control"] = (input) =>
      controlLocks.withLock(`${input.executionID}\u0000${controlRequestKey(input)}`)(dispatchControl(input))

    const markUnknown = (input: { readonly executionID: string; readonly epoch: number; readonly reason: string }) =>
      SynchronizedRef.modify(state, (current) => {
        const key = keyFor(input.executionID)
        const previous = current.entries.get(key)
        if (!previous || previous.input.epoch !== input.epoch || !previous.active) return [false, current] as const
        const updated: Entry = {
          ...previous,
          phase: "outcome_unknown",
          active: false,
          finishedAtMs: Date.now(),
          stopReason: "unknown",
          reason: input.reason,
        }
        return [true, { disposed: current.disposed, entries: new Map(current.entries).set(key, updated) }] as const
      })

    const wait: Interface["wait"] = Effect.fn("SubagentProvider.wait")(function* (input) {
      const directParentError = validateDirectParentControl(input)
      if (directParentError) return yield* Effect.fail(idError(input.executionID, directParentError))
      const targetError = validIdentifier(input.executionID, "executionID")
      if (targetError) return yield* Effect.fail(idError(input.executionID, targetError))
      const entry = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      if (!entry) return { timedOut: false }
      const bindingError = parentControlBindingError(input, entry)
      if (bindingError) return yield* Effect.fail(idError(input.executionID, bindingError))
      if (!entry.active) return { snapshot: snapshotOf(entry), timedOut: false }
      if (input.timeoutMs === undefined) {
        yield* Deferred.await(entry.done)
        const completed = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
        return { snapshot: completed ? snapshotOf(completed) : undefined, timedOut: false }
      }
      if (input.timeoutMs === 0) return { snapshot: snapshotOf(entry), timedOut: true }
      const waited = yield* Deferred.await(entry.done).pipe(Effect.timeoutOption(input.timeoutMs))
      if (Option.isSome(waited)) {
        const completed = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
        return { snapshot: completed ? snapshotOf(completed) : undefined, timedOut: false }
      }
      const current = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      return { snapshot: current ? snapshotOf(current) : undefined, timedOut: true }
    })

    const cancelOne: Interface["cancel"] = Effect.fn("SubagentProvider.cancel")(function* (input) {
      const directParentError = validateDirectParentControl(input)
      if (directParentError) return yield* Effect.fail(idError(input.executionID, directParentError))
      const targetError = validIdentifier(input.executionID, "executionID")
      if (targetError) return yield* Effect.fail(idError(input.executionID, targetError))
      const entry = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      if (!entry) return { timedOut: false }
      const bindingError = parentControlBindingError(input, entry)
      if (bindingError) return yield* Effect.fail(idError(input.executionID, bindingError))
      if (!entry.active) return { snapshot: snapshotOf(entry), timedOut: false }

      const timeoutMs = input.timeoutMs ?? 5_000
      const adapter = adapters.get(entry.input.provider)
      const native =
        adapter && adapter.capabilities.supportsCancel === true
          ? yield* observeAdapterLifecycle(
              invokeAdapterLifecycle(adapter, "cancel", input, input.executionID, timeoutMs),
            )
          : ({ result: { status: "unsupported" as const } } as const)
      if ("error" in native) {
        // A native cancellation failure means the external provider outcome
        // cannot be trusted.  Publish unknown before signalling the local
        // operation so its finalizer cannot downgrade this to "cancelled".
        const unknown = yield* markUnknown({
          executionID: entry.input.executionID,
          epoch: entry.input.epoch,
          reason: "native provider cancellation was not confirmed; child result is unknown and must be reconciled",
        })
        yield* Deferred.succeed(entry.cancelSignal, undefined).pipe(Effect.ignore)
        if (unknown) yield* Deferred.succeed(entry.done, undefined).pipe(Effect.ignore)
        return yield* Effect.fail(native.error)
      }

      // Signal first, then wait for the adapter's onExit/finalizer to publish
      // the cancelled phase. An uncooperative adapter is downgraded to
      // outcome_unknown after the bounded grace period, never to success.
      yield* Deferred.succeed(entry.cancelSignal, undefined).pipe(Effect.ignore)
      if (timeoutMs > 0) {
        const waited = yield* Deferred.await(entry.done).pipe(Effect.timeoutOption(timeoutMs))
        if (Option.isSome(waited)) {
          const completed = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
          return { snapshot: completed ? snapshotOf(completed) : undefined, timedOut: false }
        }
      }
      const unknown = yield* markUnknown({
        executionID: input.executionID,
        epoch: entry.input.epoch,
        reason: "parent cancellation deadline exceeded; child result is unknown and must be reconciled",
      })
      if (unknown) yield* Deferred.succeed(entry.done, undefined).pipe(Effect.ignore)
      const current = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
      return { snapshot: current ? snapshotOf(current) : undefined, timedOut: true }
    })

    const cancel: Interface["cancel"] = (input) =>
      controlLocks.withLock(`${input.executionID}\u0000cancel`)(cancelOne(input))

    const drainOne = (input: {
      readonly executionID: string
      readonly provider?: Kind
      readonly epoch?: number
      readonly timeoutMs: number
    }) =>
      Effect.gen(function* () {
        const entry = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
        if (
          !entry ||
          (input.provider && entry.input.provider !== input.provider) ||
          (input.epoch && entry.input.epoch !== input.epoch)
        )
          return {
            provider: input.provider,
            executionID: input.executionID,
            epoch: input.epoch,
            status: "drained" as const,
            active: 0,
          }
        if (!entry.active)
          return {
            provider: entry.input.provider,
            executionID: entry.input.executionID,
            epoch: entry.input.epoch,
            status: "drained" as const,
            active: 0,
          }

        yield* SynchronizedRef.modify(state, (current) => {
          const currentEntry = current.entries.get(keyFor(input.executionID))
          if (!currentEntry || !currentEntry.active) return [undefined, current] as const
          const draining: Entry = { ...currentEntry, phase: "draining" }
          return [
            undefined,
            { disposed: current.disposed, entries: new Map(current.entries).set(keyFor(input.executionID), draining) },
          ] as const
        })
        const current = (yield* SynchronizedRef.get(state)).entries.get(keyFor(input.executionID))
        if (!current || !current.active)
          return {
            provider: entry.input.provider,
            executionID: entry.input.executionID,
            epoch: entry.input.epoch,
            status: "drained" as const,
            active: 0,
          }
        const deadlineMs = Date.now() + input.timeoutMs
        const adapter = adapters.get(entry.input.provider)
        const native =
          adapter && adapter.capabilities.supportsDrain === true
            ? yield* observeAdapterLifecycle(
                invokeAdapterLifecycle(
                  adapter,
                  "drain",
                  {
                    operation: "drain",
                    provider: entry.input.provider,
                    executionID: entry.input.executionID,
                    epoch: entry.input.epoch,
                    timeoutMs: input.timeoutMs,
                  },
                  entry.input.executionID,
                  input.timeoutMs,
                ),
              )
            : ({ result: { status: "unsupported" as const } } as const)
        if ("error" in native) {
          const unknown = yield* markUnknown({
            executionID: entry.input.executionID,
            epoch: entry.input.epoch,
            reason: "native provider drain was not confirmed; child result is unknown and must be reconciled",
          })
          yield* Deferred.succeed(entry.cancelSignal, undefined).pipe(Effect.ignore)
          if (unknown) yield* Deferred.succeed(entry.done, undefined).pipe(Effect.ignore)
          return yield* Effect.fail(native.error)
        }
        const remainingMs = Math.max(0, deadlineMs - Date.now())
        const waited = yield* Deferred.await(current.done).pipe(Effect.timeoutOption(remainingMs))
        if (Option.isSome(waited))
          return {
            provider: entry.input.provider,
            executionID: entry.input.executionID,
            epoch: entry.input.epoch,
            status: "drained" as const,
            active: 0,
          }
        const unknown = yield* markUnknown({
          executionID: entry.input.executionID,
          epoch: entry.input.epoch,
          reason: "provider drain deadline exceeded; child result is unknown and must be reconciled",
        })
        // Publish the unknown outcome before interrupting the adapter. This
        // closes the race in which its onExit lifecycle event could otherwise
        // settle the entry as failed/cancelled before the drain deadline is
        // recorded. The cancellation signal still prevents a cooperative
        // operation from continuing side effects after the durable result is
        // marked unknown.
        yield* Deferred.succeed(entry.cancelSignal, undefined).pipe(Effect.ignore)
        if (unknown) yield* Deferred.succeed(entry.done, undefined).pipe(Effect.ignore)
        return {
          provider: entry.input.provider,
          executionID: entry.input.executionID,
          epoch: entry.input.epoch,
          status: unknown ? ("timed_out" as const) : ("drained" as const),
          active: unknown ? 1 : 0,
        }
      })

    const drain: Interface["drain"] = Effect.fn("SubagentProvider.drain")(function* (input) {
      const timeoutMs = input.timeoutMs ?? 5_000
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
        return yield* Effect.fail(
          new InvalidInputError({
            executionID: input.executionID ?? "provider",
            reason: "timeoutMs must be between 0 and 60000",
          }),
        )
      if (!input.executionID && !input.provider)
        return yield* Effect.fail(
          new InvalidInputError({ executionID: "provider", reason: "drain requires executionID or provider" }),
        )
      if (!input.executionID && input.epoch !== undefined)
        return yield* Effect.fail(
          new InvalidInputError({ executionID: "provider", reason: "epoch-scoped drain requires executionID" }),
        )

      if (input.executionID) return yield* drainOne({ ...input, executionID: input.executionID, timeoutMs })

      const entries = [...(yield* SynchronizedRef.get(state)).entries.values()].filter(
        (entry) => entry.active && (!input.provider || entry.input.provider === input.provider),
      )
      const results = yield* Effect.forEach(entries, (entry) =>
        drainOne({ executionID: entry.input.executionID, provider: input.provider, epoch: input.epoch, timeoutMs }),
      )
      const timedOut = results.some((result) => result.status === "timed_out")
      return {
        provider: input.provider,
        status: timedOut ? ("timed_out" as const) : ("drained" as const),
        active: results.reduce((sum, result) => sum + result.active, 0),
      }
    })

    const dispose: Interface["dispose"] = Effect.gen(function* () {
      const disposal = yield* SynchronizedRef.modify(
        state,
        (current): readonly [
          { readonly alreadyDisposed: boolean; readonly entries: ReadonlyArray<Entry> },
          State,
        ] => {
        if (current.disposed) return [{ alreadyDisposed: true as const, entries: [] as ReadonlyArray<Entry> }, current] as const
        const active = [...current.entries.values()].filter((entry) => entry.active)
        const next = new Map(current.entries)
        for (const entry of active) {
          next.set(keyFor(entry.input.executionID), {
            ...entry,
            phase: "outcome_unknown",
            active: false,
            finishedAtMs: Date.now(),
            stopReason: "unknown",
            reason: "provider runtime disposed before child result was observed",
          })
        }
        return [{ alreadyDisposed: false as const, entries: active }, { disposed: true, entries: next }] as const
        },
      )
      if (disposal.alreadyDisposed) return
      yield* Effect.forEach(
        disposal.entries,
        (entry) =>
          Effect.all(
            [
              Deferred.succeed(entry.cancelSignal, undefined).pipe(Effect.ignore),
              Deferred.succeed(entry.done, undefined).pipe(Effect.ignore),
            ],
            { discard: true },
          ),
        { discard: true },
      )

      const failures: Array<ProviderLifecycleError | InvalidInputError> = []
      for (const adapter of adapters.values()) {
        if (adapter.capabilities.supportsDispose !== true) continue
        const outcome = yield* observeAdapterLifecycle(
          invokeAdapterLifecycle(
            adapter,
            "dispose",
            { operation: "dispose", provider: adapter.kind },
            "provider",
            5_000,
          ),
        )
        if ("error" in outcome) failures.push(outcome.error)
      }
      if (failures.length > 0) return yield* Effect.fail(failures[0])
    })

    return { execute, capabilities, inspect, control, wait, cancel, drain, dispose } satisfies Interface
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const invariants = yield* RuntimeInvariants.Service
    return yield* make({ invariants })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [RuntimeInvariants.node] })
