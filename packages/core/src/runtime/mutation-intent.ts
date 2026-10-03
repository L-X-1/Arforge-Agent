import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime } from "effect"
import { canonicalHash } from "../util/canonical-hash"

export type MutationIntentPhase = AgentRuntime.MutationIntentPhase

export type MutationRecoveryDecision = "settled" | "inspect" | "manual_rollback" | "blocked"

export type MutationRecoveryProjection = Readonly<{
  readonly transactionID: AgentRuntime.MutationTransactionID
  readonly phase: MutationIntentPhase
  readonly decision: MutationRecoveryDecision
  readonly automaticRetryAllowed: false
  /** Append-only semantic checkpoints; a trailing started item is evidence of an in-flight stage. */
  readonly postProcessing: ReadonlyArray<AgentRuntime.MutationPostProcessingCheckpoint>
  /** Deterministic restart classification derived from the checkpoint chain. */
  readonly postProcessingRecovery: MutationPostProcessingRecovery
  readonly reason: string
}>

export type MutationObservedImage = Readonly<{
  /** The same relative resource recorded in MutationIntentEntry.target. */
  readonly target: string
  /** false represents a verified missing path; an omitted observation is different. */
  readonly present: boolean
  readonly digest?: string
  readonly byteLength?: number
}>

export type MutationImageState = "postimage_matches" | "preimage_matches" | "changed" | "unobserved"

export type MutationImageObservation = Readonly<{
  readonly target: string
  readonly operation: AgentRuntime.MutationIntentEntry["operation"]
  readonly state: MutationImageState
}>

export type MutationInspectionDecision = "postimage_matches" | "preimage_matches" | "manual_review"

/**
 * Restart classification for the post-processing side-effect seam.
 *
 * A checkpoint is evidence, not permission: even `completed_unsettled` and
 * `in_flight` remain inspect-only until a fresh workspace observation and an
 * explicit human decision are recorded.  Keeping this classification next to
 * the mutation-intent owner prevents each UI/adapter from inventing its own
 * interpretation of a trailing `started` checkpoint.
 */
export type MutationPostProcessingRecoveryStatus =
  | "not_started"
  | "in_flight"
  | "completed_unsettled"
  | "settled"
  | "rolled_back"

export type MutationPostProcessingRecovery = Readonly<{
  readonly status: MutationPostProcessingRecoveryStatus
  readonly stage?: AgentRuntime.MutationPostProcessingStage
  readonly target?: string
  readonly sequence?: number
  /** A stable, operator-safe explanation of why the status is inspect-only. */
  readonly reason: string
}>

/** Human review decisions are evidence-bound phase transitions, not retry commands. */
export type MutationReviewDecision = "settle_postimage" | "require_rollback" | "confirm_rolled_back" | "block_rollback"

export const reviewPhase = (decision: MutationReviewDecision): MutationIntentPhase => {
  switch (decision) {
    case "settle_postimage":
      return "settled"
    case "require_rollback":
      return "rollback_required"
    case "confirm_rolled_back":
      return "rolled_back"
    case "block_rollback":
      return "rollback_blocked"
  }
}

const reviewInspection = (decision: MutationReviewDecision): MutationInspectionDecision => {
  switch (decision) {
    case "settle_postimage":
    case "require_rollback":
      return "postimage_matches"
    case "confirm_rolled_back":
      return "preimage_matches"
    case "block_rollback":
      return "manual_review"
  }
}

/**
 * Validate a human mutation review against a fresh, digest-only inspection.
 * This helper only authorizes an explicit durable phase transition; it never
 * writes files, settles the Action aggregate, or enables automatic retry.
 */
export const validateReview = (
  input: {
    readonly transactionID: AgentRuntime.MutationTransactionID
    readonly expectedPhase: MutationIntentPhase
    readonly decision: MutationReviewDecision
    readonly inspectedDecision: MutationInspectionDecision
    readonly observationDigest: string
    readonly reviewedAt: DateTime.Utc
  },
  current: Pick<AgentRuntime.MutationIntent, "transactionID" | "phase" | "updatedAt">,
): string | undefined => {
  if (!isObservationDigest(input.observationDigest)) return "The mutation review observation digest is invalid."
  if (current.transactionID !== input.transactionID)
    return "The mutation review transaction does not match the durable intent."
  if (current.phase !== input.expectedPhase)
    return `The mutation review expected phase ${input.expectedPhase}, found ${current.phase}.`
  if (reviewInspection(input.decision) !== input.inspectedDecision)
    return "The mutation review decision does not match the fresh fingerprint inspection."
  const nextPhase = reviewPhase(input.decision)
  if (!canTransition(current.phase, nextPhase))
    return `The mutation review cannot transition ${current.phase} → ${nextPhase}.`
  if (DateTime.toEpochMillis(input.reviewedAt) < DateTime.toEpochMillis(current.updatedAt))
    return "The mutation review timestamp precedes the durable mutation phase."
  return undefined
}

export type MutationInspectionProjection = Readonly<{
  readonly transactionID: AgentRuntime.MutationTransactionID
  readonly phase: MutationIntentPhase
  /** Digest of the ordered, content-free fingerprint observations used for this classification. */
  readonly observationDigest: string
  readonly decision: MutationInspectionDecision
  readonly automaticRetryAllowed: false
  /** True when every inverse operation has a durable artifact or is a create removal. */
  readonly rollbackAvailable: boolean
  readonly entries: ReadonlyArray<MutationImageObservation>
  readonly reason: string
}>

const transitions: Readonly<Record<MutationIntentPhase, ReadonlySet<MutationIntentPhase>>> = {
  prepared: new Set(["committed", "rollback_required", "outcome_unknown"]),
  committed: new Set(["postprocessing", "settled", "rollback_required", "outcome_unknown"]),
  postprocessing: new Set(["settled", "rollback_required", "outcome_unknown"]),
  settled: new Set(),
  rollback_required: new Set(["rolled_back", "rollback_blocked", "outcome_unknown"]),
  rolled_back: new Set(),
  rollback_blocked: new Set(),
  outcome_unknown: new Set(["rollback_required", "rollback_blocked", "rolled_back"]),
}

const digestPattern = /^[a-f0-9]{64}$/
const rollbackArtifactIDPattern = /^rollback-[a-f0-9]{64}$/
export const isObservationDigest = (value: string): boolean => digestPattern.test(value)
const cleanText = (value: string, maxBytes: number) =>
  value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\u0000-\u001f\u007f]/.test(value)

const sameEntries = (
  left: ReadonlyArray<AgentRuntime.MutationIntentEntry>,
  right: ReadonlyArray<AgentRuntime.MutationIntentEntry>,
) => JSON.stringify(left) === JSON.stringify(right)

const sameCheckpoint = (
  left: AgentRuntime.MutationPostProcessingCheckpoint,
  right: AgentRuntime.MutationPostProcessingCheckpoint,
) => JSON.stringify(left) === JSON.stringify(right)

/** Treat an omitted legacy checkpoint list as an empty list. */
export const postProcessingOf = (
  intent: Pick<AgentRuntime.MutationIntent, "postProcessing">,
): ReadonlyArray<AgentRuntime.MutationPostProcessingCheckpoint> => intent.postProcessing ?? []

/**
 * Classify the post-processing boundary after a restart without inspecting or
 * mutating the workspace.  The last checkpoint is the only completion source:
 * a trailing `started` item means the adapter may have performed a side effect
 * before the completion fact was durably appended.
 */
export const postProcessingRecoveryOf = (
  intent: Pick<AgentRuntime.MutationIntent, "phase" | "postProcessing">,
): MutationPostProcessingRecovery => {
  const checkpoints = postProcessingOf(intent)
  const last = checkpoints.at(-1)
  const active = last?.status === "started" ? last : undefined

  if (intent.phase === "settled")
    return {
      status: "settled",
      reason: "The mutation action and every recorded post-processing stage are durably settled.",
    }
  if (intent.phase === "rolled_back")
    return {
      status: "rolled_back",
      reason: "The mutation action was durably rolled back; no post-processing retry is permitted.",
    }
  if (active)
    return {
      status: "in_flight",
      stage: active.stage,
      ...(active.target === undefined ? {} : { target: active.target }),
      sequence: active.sequence,
      reason:
        "A post-processing stage was started without a matching completion fact; its side effect may have completed before the process stopped. Fresh inspection is required.",
    }
  if (checkpoints.length > 0)
    return {
      status: "completed_unsettled",
      reason:
        "All recorded post-processing stages have completion facts, but the mutation action is not durably settled. Fresh inspection is required before retrying.",
    }
  return {
    status: "not_started",
    reason: "No post-processing stage has a durable start fact; the post-processing side-effect seam was not entered.",
  }
}

/**
 * Checkpoint records are append-only. This is used by both validation and the
 * DurableAction same-phase CAS gate so a writer cannot rewrite a completed
 * side-effect fact in place.
 */
export const isPostProcessingPrefix = (
  previous: Pick<AgentRuntime.MutationIntent, "postProcessing">,
  next: Pick<AgentRuntime.MutationIntent, "postProcessing">,
): boolean => {
  const left = postProcessingOf(previous)
  const right = postProcessingOf(next)
  return left.length <= right.length && left.every((checkpoint, index) => sameCheckpoint(checkpoint, right[index]!))
}

/** True only for a new checkpoint appended while the transaction is in postprocessing. */
export const canAppendPostProcessing = (
  previous: AgentRuntime.MutationIntent,
  next: AgentRuntime.MutationIntent,
): boolean =>
  previous.phase === "postprocessing" &&
  next.phase === "postprocessing" &&
  postProcessingOf(next).length === postProcessingOf(previous).length + 1 &&
  isPostProcessingPrefix(previous, next)

/** Digest the metadata manifest only; file contents never enter this value. */
export const manifestDigest = (entries: ReadonlyArray<AgentRuntime.MutationIntentEntry>): string | undefined =>
  canonicalHash(entries)

export const canTransition = (from: MutationIntentPhase, to: MutationIntentPhase) => transitions[from].has(to)

const imageMatches = (
  entry: AgentRuntime.MutationIntentEntry,
  observed: MutationObservedImage | undefined,
  expected: "before" | "after",
) => {
  if (observed === undefined) return false
  if (entry.operation === "create") {
    return expected === "before"
      ? observed.present === false
      : observed.present &&
          observed.digest === entry.afterDigest &&
          (entry.afterByteLength === undefined || observed.byteLength === entry.afterByteLength)
  }
  if (entry.operation === "remove") {
    return expected === "after"
      ? observed.present === false
      : observed.present && observed.digest === entry.beforeDigest
  }
  if (!observed.present) return false
  const digest = expected === "before" ? entry.beforeDigest : entry.afterDigest
  const byteLength = expected === "after" ? entry.afterByteLength : undefined
  return (
    digest !== undefined &&
    observed.digest === digest &&
    (byteLength === undefined || observed.byteLength === byteLength)
  )
}

const imageState = (
  entry: AgentRuntime.MutationIntentEntry,
  observed: MutationObservedImage | undefined,
): MutationImageState => {
  if (observed === undefined) return "unobserved"
  if (imageMatches(entry, observed, "after")) return "postimage_matches"
  if (imageMatches(entry, observed, "before")) return "preimage_matches"
  return "changed"
}

/**
 * Compare a durable, content-free intent with a fresh post-restart filesystem
 * observation. This never reads or stores file bytes and never authorizes a
 * retry; it only gives the caller a safe human/operator classification.
 */
export const inspect = (
  intent: Pick<AgentRuntime.MutationIntent, "transactionID" | "phase" | "entries">,
  observations: ReadonlyArray<MutationObservedImage>,
): MutationInspectionProjection => {
  const byTarget = new Map(observations.map((observation) => [observation.target, observation]))
  const observationDigest = canonicalHash(observations)
  if (observationDigest === undefined) throw new Error("Mutation fingerprint observations were not canonicalizable.")
  const entries = intent.entries.map((entry) => ({
    target: entry.target,
    operation: entry.operation,
    state: imageState(entry, byTarget.get(entry.target)),
  }))
  const rollbackAvailable = intent.entries.every(
    (entry) => entry.operation === "create" || entry.rollbackArtifact !== undefined,
  )
  const states = entries.map((entry) => entry.state)
  const allPostimage = states.length > 0 && states.every((state) => state === "postimage_matches")
  const allPreimage = states.length > 0 && states.every((state) => state === "preimage_matches")
  if (allPostimage)
    return {
      transactionID: intent.transactionID,
      phase: intent.phase,
      observationDigest,
      decision: "postimage_matches",
      automaticRetryAllowed: false,
      rollbackAvailable,
      entries,
      reason: "Every recorded target matches its durable postimage digest; settlement still requires the Action log.",
    }
  if (allPreimage)
    return {
      transactionID: intent.transactionID,
      phase: intent.phase,
      observationDigest,
      decision: "preimage_matches",
      automaticRetryAllowed: false,
      rollbackAvailable,
      entries,
      reason: "Every recorded target matches its preimage; inspect the action before considering a new attempt.",
    }
  return {
    transactionID: intent.transactionID,
    phase: intent.phase,
    observationDigest,
    decision: "manual_review",
    automaticRetryAllowed: false,
    rollbackAvailable,
    entries,
    reason: "The observed images are mixed, changed, or incomplete; operator review is required before retrying.",
  }
}

/**
 * Validates a mutation intent at the DurableAction boundary. The returned
 * string is intentionally operator-safe and never includes file bytes.
 */
export const validate = (
  intent: AgentRuntime.MutationIntent,
  expected: Readonly<{
    readonly actionID: AgentRuntime.ActionID
    readonly intentDigest?: string
    readonly idempotencyKey: string
  }>,
  previous?: AgentRuntime.MutationIntent,
): string | undefined => {
  if (intent.version !== 1) return "The mutation intent version is unsupported."
  if (intent.actionID !== expected.actionID) return "The mutation intent actionID does not match the durable action."
  if (expected.intentDigest === undefined || expected.intentDigest.length === 0)
    return "A mutation intent requires an immutable durable action intent digest."
  if (intent.intentDigest !== expected.intentDigest)
    return "The mutation intent digest does not match the durable action."
  if (intent.idempotencyKey !== expected.idempotencyKey)
    return "The mutation intent idempotency key does not match the durable action."
  if (!cleanText(intent.idempotencyKey, 160)) return "The mutation intent idempotency key is invalid."
  if (!digestPattern.test(intent.manifestDigest)) return "The mutation intent manifest digest is invalid."
  if (manifestDigest(intent.entries) !== intent.manifestDigest)
    return "The mutation intent manifest digest does not match its metadata entries."
  if (intent.entries.length === 0 || intent.entries.length > 1_024)
    return "The mutation intent entry count is outside the supported range."
  for (const entry of intent.entries) {
    if (!cleanText(entry.target, 4_096)) return "The mutation intent target is invalid."
    if (entry.beforeDigest !== undefined && !digestPattern.test(entry.beforeDigest))
      return "The mutation intent before digest is invalid."
    if (entry.afterDigest !== undefined && !digestPattern.test(entry.afterDigest))
      return "The mutation intent after digest is invalid."
    if (entry.rollbackArtifact !== undefined) {
      if (
        entry.rollbackArtifact.version !== 1 ||
        !rollbackArtifactIDPattern.test(entry.rollbackArtifact.artifactID) ||
        !digestPattern.test(entry.rollbackArtifact.digest) ||
        !Number.isSafeInteger(entry.rollbackArtifact.byteLength) ||
        entry.rollbackArtifact.byteLength < 0
      )
        return "The mutation intent rollback artifact reference is invalid."
      if (entry.rollbackArtifact.artifactID !== `rollback-${entry.rollbackArtifact.digest}`)
        return "The mutation intent rollback artifact ID does not match its digest."
      if (entry.beforeDigest === undefined || entry.rollbackArtifact.digest !== entry.beforeDigest)
        return "The rollback artifact must bind to the mutation preimage digest."
    }
    if (entry.operation === "create") {
      if (entry.beforeDigest !== undefined || entry.afterDigest === undefined || entry.afterByteLength === undefined)
        return "A create mutation intent must describe its postimage and cannot claim a before image."
      if (entry.rollbackArtifact !== undefined) return "A create mutation intent cannot claim a rollback artifact."
      if (entry.recovery !== "remove-if-matching" && entry.recovery !== "manual-review")
        return "A create mutation intent has an invalid recovery classification."
    }
    if (entry.operation === "write") {
      if (entry.afterDigest === undefined || entry.afterByteLength === undefined)
        return "A write mutation intent must describe its postimage."
      if (
        entry.recovery !== "restore-from-volatile-journal" &&
        entry.recovery !== "restore-from-artifact" &&
        entry.recovery !== "manual-review"
      )
        return "A write mutation intent has an invalid recovery classification."
      if (entry.recovery === "restore-from-artifact" && entry.rollbackArtifact === undefined)
        return "A write mutation intent using artifact recovery must bind a rollback artifact."
      if (entry.rollbackArtifact !== undefined && entry.recovery !== "restore-from-artifact")
        return "A write mutation intent with a rollback artifact must use artifact recovery."
    }
    if (entry.operation === "remove") {
      if (entry.beforeDigest === undefined || entry.afterDigest !== undefined || entry.afterByteLength !== undefined)
        return "A remove mutation intent must describe its preimage and cannot claim a postimage."
      if (entry.recovery !== "manual-review") return "A remove mutation intent must require manual recovery."
    }
  }
  if (intent.automaticRetryAllowed !== false) return "Mutation intent recovery cannot authorize automatic retry."
  if (DateTime.toEpochMillis(intent.createdAt) > DateTime.toEpochMillis(intent.updatedAt))
    return "The mutation intent updatedAt precedes createdAt."
  const checkpoints = postProcessingOf(intent)
  let active: AgentRuntime.MutationPostProcessingCheckpoint | undefined
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (checkpoint.sequence !== index)
      return "Mutation post-processing checkpoints must use contiguous sequence numbers."
    if (checkpoint.target !== undefined && !cleanText(checkpoint.target, 4_096))
      return "The mutation post-processing checkpoint target is invalid."
    if (checkpoint.status === "started") {
      if (active !== undefined)
        return "A mutation post-processing checkpoint cannot start before the prior stage completes."
      active = checkpoint
      continue
    }
    if (active === undefined || active.stage !== checkpoint.stage || active.target !== checkpoint.target)
      return "A completed mutation post-processing checkpoint must close its matching started stage."
    active = undefined
  }
  if (previous !== undefined) {
    if (previous.transactionID !== intent.transactionID)
      return "A durable action cannot switch mutation transaction identity."
    if (DateTime.toEpochMillis(previous.createdAt) !== DateTime.toEpochMillis(intent.createdAt))
      return "A durable mutation transaction cannot change its creation time."
    if (previous.manifestDigest !== intent.manifestDigest || !sameEntries(previous.entries, intent.entries))
      return "A durable mutation transaction cannot change its metadata manifest."
    if (!isPostProcessingPrefix(previous, intent))
      return "A durable mutation transaction cannot rewrite or remove post-processing checkpoints."
    if (previous.phase === intent.phase) {
      if (DateTime.toEpochMillis(intent.updatedAt) < DateTime.toEpochMillis(previous.updatedAt))
        return "A duplicate mutation intent record cannot move updatedAt backwards."
    } else if (!canTransition(previous.phase, intent.phase)) {
      return `The mutation intent phase cannot transition ${previous.phase} → ${intent.phase}.`
    }
  } else if (intent.phase !== "prepared") {
    return "The first durable mutation intent record must be prepared."
  }
  return undefined
}

/** Deterministic restart classification; it never executes or authorizes a write. */
export const projectRecovery = (intent: AgentRuntime.MutationIntent): MutationRecoveryProjection => {
  const postProcessing = postProcessingOf(intent)
  const postProcessingRecovery = postProcessingRecoveryOf(intent)
  switch (intent.phase) {
    case "settled":
    case "rolled_back":
      return {
        transactionID: intent.transactionID,
        phase: intent.phase,
        decision: "settled",
        automaticRetryAllowed: false,
        postProcessing,
        postProcessingRecovery,
        reason:
          intent.phase === "settled"
            ? "The mutation transaction is durably settled."
            : "The mutation transaction was rolled back.",
      }
    case "rollback_required":
      return {
        transactionID: intent.transactionID,
        phase: intent.phase,
        decision: "manual_rollback",
        automaticRetryAllowed: false,
        postProcessing,
        postProcessingRecovery,
        reason: "The transaction requires compensation; original file bytes are not in the durable intent.",
      }
    case "rollback_blocked":
      return {
        transactionID: intent.transactionID,
        phase: intent.phase,
        decision: "blocked",
        automaticRetryAllowed: false,
        postProcessing,
        postProcessingRecovery,
        reason: "Compensation was blocked by a stale or changed postimage and needs operator review.",
      }
    case "prepared":
      return {
        transactionID: intent.transactionID,
        phase: intent.phase,
        decision: "inspect",
        automaticRetryAllowed: false,
        postProcessing,
        postProcessingRecovery,
        reason: "A mutation intent was prepared but no durable commit exists.",
      }
    case "committed":
    case "postprocessing":
    case "outcome_unknown":
      return {
        transactionID: intent.transactionID,
        phase: intent.phase,
        decision: "inspect",
        automaticRetryAllowed: false,
        postProcessing,
        postProcessingRecovery,
        reason: "The mutation transaction may have changed external files; inspect the postimage before any retry.",
      }
  }
}
