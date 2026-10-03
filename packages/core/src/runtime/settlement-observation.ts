/**
 * Payload-free settlement observation window.
 *
 * The coordinator already returns a durable, digest-bound receipt for one
 * transaction.  This module is a read-only projection over several such
 * receipts so a controlled soak can be reviewed without inventing a second
 * settlement state machine or silently promoting the production gate.
 */

import * as ChildSettlement from "./child-settlement"
import * as SettlementCoordinator from "./settlement-coordinator"
import { canonicalHash } from "../util/canonical-hash"

export const SETTLEMENT_OBSERVATION_SCHEMA_VERSION = 1 as const
export const SETTLEMENT_OBSERVATION_KIND = "settlement-observation-window" as const
export const SETTLEMENT_OBSERVATION_CHECKPOINT_KIND = "settlement-observation-checkpoint" as const
export const SETTLEMENT_OBSERVATION_REVIEW_KIND = "settlement-observation-review" as const

const DIGEST = /^[a-f0-9]{64}$/i
const TRANSACTION_ID = /^tx_[A-Za-z0-9._:-]{1,255}$/
const OBSERVER_ID = /^[A-Za-z0-9._:-]{1,255}$/
const MAX_SAMPLES = 1_024
const OWNER_ORDER: ReadonlyArray<ChildSettlement.SettlementWrite> = Object.freeze([
  "admission-evidence",
  "child-result",
  "parent-budget",
])

export type SettlementObservationSample = Readonly<{
  readonly schemaVersion: typeof SETTLEMENT_OBSERVATION_SCHEMA_VERSION
  readonly planDigest: string
  readonly evidenceDigest: string
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly ownerCount: 3
  readonly outcome: "committed"
  readonly providerExecutionAllowed: false
  readonly executionDigest: string
  readonly observedAtMs: number
}>

export type SettlementObservationWindowStatus = "insufficient-observations" | "ready-for-review"

export type SettlementObservationWindow = Readonly<{
  readonly schemaVersion: typeof SETTLEMENT_OBSERVATION_SCHEMA_VERSION
  readonly kind: typeof SETTLEMENT_OBSERVATION_KIND
  readonly sampleCount: number
  readonly minimumSamples: number
  readonly startAtMs: number
  readonly endAtMs: number
  readonly samples: ReadonlyArray<SettlementObservationSample>
  readonly ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly allOwnerOrderStable: true
  readonly allProviderFenced: true
  readonly duplicateExecutionDigests: 0
  readonly outcome: "committed"
  readonly providerExecutionAllowed: false
  /** Observation is evidence for review only; it never enables a gate. */
  readonly reviewOnly: true
  readonly promotionAuthorized: false
  readonly status: SettlementObservationWindowStatus
  readonly windowDigest: string
}>

/**
 * Restart-safe, payload-free checkpoint for a long-running observation.
 *
 * The checkpoint is an append-only review projection. It carries the
 * canonical window and a second digest binding the observer identity to that
 * window, but it never grants a settlement gate or persists business data.
 */
export type SettlementObservationCheckpoint = Readonly<{
  readonly schemaVersion: typeof SETTLEMENT_OBSERVATION_SCHEMA_VERSION
  readonly kind: typeof SETTLEMENT_OBSERVATION_CHECKPOINT_KIND
  readonly observerID: string
  readonly window: SettlementObservationWindow
  readonly checkpointDigest: string
}>

export type SettlementObservationReviewBlocker =
  | "insufficient-samples"
  | "insufficient-duration"
  | "sample-gap-too-large"

export type SettlementObservationReviewPolicy = Readonly<{
  readonly minimumSamples: number
  readonly minimumWindowDurationMs: number
  readonly maximumSampleGapMs: number
}>

/**
 * A review-only decision for a long-running observation window.  This is an
 * evidence card, not a settlement gate: even a ready card keeps provider
 * execution fenced and requires a separate human/production decision.
 */
export type SettlementObservationReview = Readonly<{
  readonly schemaVersion: typeof SETTLEMENT_OBSERVATION_SCHEMA_VERSION
  readonly kind: typeof SETTLEMENT_OBSERVATION_REVIEW_KIND
  readonly windowDigest: string
  readonly sampleCount: number
  readonly durationMs: number
  readonly minimumSamples: number
  readonly minimumWindowDurationMs: number
  readonly maximumSampleGapMs: number
  readonly observedMaximumGapMs: number
  readonly blockers: ReadonlyArray<SettlementObservationReviewBlocker>
  readonly status: "hold" | "ready-for-review"
  readonly reviewOnly: true
  readonly promotionAuthorized: false
  readonly providerExecutionAllowed: false
  readonly reviewDigest: string
}>

export class SettlementObservationError extends Error {
  readonly _tag = "Runtime.SettlementObservationError"

  constructor(readonly reason: string) {
    super(reason)
    this.name = this._tag
  }
}

const invalid = (reason: string): SettlementObservationError => new SettlementObservationError(reason)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(value).sort()
  return JSON.stringify(actual) === JSON.stringify([...expected].sort())
}

const isOwnerOrder = (value: unknown): value is ReadonlyArray<ChildSettlement.SettlementWrite> =>
  Array.isArray(value) && JSON.stringify(value) === JSON.stringify(OWNER_ORDER)

const windowSemantic = (
  window: Pick<
    SettlementObservationWindow,
    | "schemaVersion"
    | "kind"
    | "sampleCount"
    | "minimumSamples"
    | "startAtMs"
    | "endAtMs"
    | "samples"
    | "ownerOrder"
    | "allOwnerOrderStable"
    | "allProviderFenced"
    | "duplicateExecutionDigests"
    | "outcome"
    | "providerExecutionAllowed"
    | "reviewOnly"
    | "promotionAuthorized"
    | "status"
  >,
) => ({
  domain: "arforge/settlement-observation-window/v1",
  schemaVersion: window.schemaVersion,
  kind: window.kind,
  sampleCount: window.sampleCount,
  minimumSamples: window.minimumSamples,
  startAtMs: window.startAtMs,
  endAtMs: window.endAtMs,
  samples: window.samples.map((sample) => ({ ...sample, ownerOrder: [...sample.ownerOrder] })),
  ownerOrder: [...window.ownerOrder],
  allOwnerOrderStable: window.allOwnerOrderStable,
  allProviderFenced: window.allProviderFenced,
  duplicateExecutionDigests: window.duplicateExecutionDigests,
  outcome: window.outcome,
  providerExecutionAllowed: window.providerExecutionAllowed,
  reviewOnly: window.reviewOnly,
  promotionAuthorized: window.promotionAuthorized,
  status: window.status,
})

const checkpointSemantic = (
  checkpoint: Pick<SettlementObservationCheckpoint, "schemaVersion" | "kind" | "observerID" | "window">,
) => ({
  domain: "arforge/settlement-observation-checkpoint/v1",
  schemaVersion: checkpoint.schemaVersion,
  kind: checkpoint.kind,
  observerID: checkpoint.observerID,
  windowDigest: checkpoint.window.windowDigest,
  sampleCount: checkpoint.window.sampleCount,
  endAtMs: checkpoint.window.endAtMs,
})

const reviewSemantic = (
  review: Pick<
    SettlementObservationReview,
    | "schemaVersion"
    | "kind"
    | "windowDigest"
    | "sampleCount"
    | "durationMs"
    | "minimumSamples"
    | "minimumWindowDurationMs"
    | "maximumSampleGapMs"
    | "observedMaximumGapMs"
    | "blockers"
    | "status"
    | "reviewOnly"
    | "promotionAuthorized"
    | "providerExecutionAllowed"
  >,
) => ({
  domain: "arforge/settlement-observation-review/v1",
  schemaVersion: review.schemaVersion,
  kind: review.kind,
  windowDigest: review.windowDigest,
  sampleCount: review.sampleCount,
  durationMs: review.durationMs,
  minimumSamples: review.minimumSamples,
  minimumWindowDurationMs: review.minimumWindowDurationMs,
  maximumSampleGapMs: review.maximumSampleGapMs,
  observedMaximumGapMs: review.observedMaximumGapMs,
  blockers: [...review.blockers],
  status: review.status,
  reviewOnly: review.reviewOnly,
  promotionAuthorized: review.promotionAuthorized,
  providerExecutionAllowed: review.providerExecutionAllowed,
})

const normalizeObserverID = (value: unknown): string => {
  if (typeof value !== "string" || !OBSERVER_ID.test(value))
    throw invalid("settlement observation observerID is invalid")
  return value
}

const validateSample = (value: unknown): SettlementObservationSample => {
  if (!isRecord(value)) throw invalid("settlement observation sample is not an object")
  if (
    !exactKeys(value, [
      "schemaVersion",
      "planDigest",
      "evidenceDigest",
      "transactionKey",
      "transactionID",
      "ownerOrder",
      "ownerCount",
      "outcome",
      "providerExecutionAllowed",
      "executionDigest",
      "observedAtMs",
    ])
  )
    throw invalid("settlement observation sample fields drifted")
  if (
    value.schemaVersion !== SETTLEMENT_OBSERVATION_SCHEMA_VERSION ||
    typeof value.planDigest !== "string" ||
    !DIGEST.test(value.planDigest) ||
    typeof value.evidenceDigest !== "string" ||
    !DIGEST.test(value.evidenceDigest) ||
    typeof value.transactionKey !== "string" ||
    value.transactionKey.trim().length === 0 ||
    value.transactionKey.length > 512 ||
    typeof value.transactionID !== "string" ||
    !TRANSACTION_ID.test(value.transactionID) ||
    !isOwnerOrder(value.ownerOrder) ||
    value.ownerCount !== OWNER_ORDER.length ||
    value.outcome !== "committed" ||
    value.providerExecutionAllowed !== false ||
    typeof value.executionDigest !== "string" ||
    !DIGEST.test(value.executionDigest) ||
    !Number.isSafeInteger(value.observedAtMs) ||
    (value.observedAtMs as number) < 0
  )
    throw invalid("settlement observation sample is invalid")
  const planDigest = value.planDigest as string
  const evidenceDigest = value.evidenceDigest as string
  const transactionKey = value.transactionKey as string
  const transactionID = value.transactionID as string
  const ownerOrder = value.ownerOrder as ReadonlyArray<ChildSettlement.SettlementWrite>
  const executionDigest = value.executionDigest as string
  const observedAtMs = value.observedAtMs as number
  return Object.freeze({
    schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
    planDigest,
    evidenceDigest,
    transactionKey,
    transactionID,
    ownerOrder: Object.freeze([...ownerOrder]),
    ownerCount: 3,
    outcome: "committed" as const,
    providerExecutionAllowed: false as const,
    executionDigest,
    observedAtMs,
  })
}

/** Project one already-validated coordinator receipt into redacted evidence. */
export const observationFromExecution = (input: {
  readonly execution: unknown
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly sharedTransactionEvidence: ChildSettlement.SettlementSharedTransactionEvidence
}): SettlementObservationSample => {
  try {
    SettlementCoordinator.assertSettlementTransactionExecution(input.execution, {
      plan: input.plan,
      sharedTransactionEvidence: input.sharedTransactionEvidence,
    })
  } catch {
    throw invalid("settlement coordinator execution is not valid observation evidence")
  }
  const execution = input.execution as SettlementCoordinator.SettlementTransactionExecution
  const sample: SettlementObservationSample = {
    schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
    planDigest: execution.planDigest,
    evidenceDigest: execution.evidenceDigest,
    transactionKey: execution.transactionKey,
    transactionID: execution.transactionID,
    ownerOrder: Object.freeze([...execution.ownerOrder]),
    ownerCount: 3,
    outcome: "committed",
    providerExecutionAllowed: false,
    executionDigest: execution.executionDigest,
    observedAtMs: execution.observedAtMs,
  }
  return validateSample(sample)
}

/**
 * Build a bounded, monotonic observation window. Duplicate receipts and time
 * reversal are rejected instead of being silently folded into a passing card.
 */
export const buildSettlementObservationWindow = (input: {
  readonly samples: ReadonlyArray<SettlementObservationSample>
  readonly minimumSamples?: number
}): SettlementObservationWindow => {
  if (!Array.isArray(input?.samples) || input.samples.length > MAX_SAMPLES)
    throw invalid(`settlement observation sample count must be between 0 and ${MAX_SAMPLES}`)
  const minimumSamples = input.minimumSamples ?? 8
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > MAX_SAMPLES)
    throw invalid("settlement observation minimumSamples is invalid")

  const samples = input.samples.map(validateSample)
  const executionDigests = new Set<string>()
  const transactionIDs = new Set<string>()
  const transactionKeys = new Set<string>()
  for (const [index, sample] of samples.entries()) {
    if (executionDigests.has(sample.executionDigest)) throw invalid("settlement observation execution is duplicated")
    if (transactionIDs.has(sample.transactionID)) throw invalid("settlement observation transaction is duplicated")
    if (transactionKeys.has(sample.transactionKey))
      throw invalid("settlement observation transaction key is duplicated")
    executionDigests.add(sample.executionDigest)
    transactionIDs.add(sample.transactionID)
    transactionKeys.add(sample.transactionKey)
    const previous = samples[index - 1]
    if (previous !== undefined && sample.observedAtMs < previous.observedAtMs)
      throw invalid("settlement observation timestamps are not monotonic")
  }

  const startAtMs = samples[0]?.observedAtMs ?? 0
  const endAtMs = samples.at(-1)?.observedAtMs ?? 0
  const status: SettlementObservationWindowStatus =
    samples.length >= minimumSamples ? "ready-for-review" : "insufficient-observations"
  const candidate = {
    schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
    kind: SETTLEMENT_OBSERVATION_KIND,
    sampleCount: samples.length,
    minimumSamples,
    startAtMs,
    endAtMs,
    samples: Object.freeze(samples),
    ownerOrder: Object.freeze([...OWNER_ORDER]),
    allOwnerOrderStable: true as const,
    allProviderFenced: true as const,
    duplicateExecutionDigests: 0 as const,
    outcome: "committed" as const,
    providerExecutionAllowed: false as const,
    reviewOnly: true as const,
    promotionAuthorized: false as const,
    status,
  }
  const windowDigest = canonicalHash(windowSemantic(candidate))
  if (windowDigest === undefined) throw invalid("settlement observation window is not canonically hashable")
  return Object.freeze({ ...candidate, windowDigest })
}

/**
 * Merge independently captured, already-validated windows without sorting or
 * silently dropping samples.  This gives a future long-running observer a
 * deterministic append-only projection while retaining the same review-only
 * and fail-closed semantics as a single bounded window.
 */
export const mergeSettlementObservationWindows = (input: {
  readonly windows: ReadonlyArray<SettlementObservationWindow>
  readonly minimumSamples?: number
}): SettlementObservationWindow => {
  if (!Array.isArray(input?.windows) || input.windows.length > MAX_SAMPLES)
    throw invalid(`settlement observation window count must be between 0 and ${MAX_SAMPLES}`)
  const windows = input.windows.map((window) => {
    assertSettlementObservationWindow(window)
    return window
  })
  if (
    input.minimumSamples !== undefined &&
    (!Number.isSafeInteger(input.minimumSamples) || input.minimumSamples < 1 || input.minimumSamples > MAX_SAMPLES)
  )
    throw invalid("settlement observation minimumSamples is invalid")
  const sourceMinimumSamples = windows.reduce((minimum, window) => Math.max(minimum, window.minimumSamples), 1)
  if (input.minimumSamples !== undefined && input.minimumSamples < sourceMinimumSamples)
    throw invalid("settlement observation minimumSamples cannot be lowered")
  const minimumSamples = input.minimumSamples ?? Math.max(8, sourceMinimumSamples)
  const samples: SettlementObservationSample[] = []
  let previousEndAtMs: number | undefined
  for (const window of windows) {
    if (previousEndAtMs !== undefined && window.startAtMs < previousEndAtMs)
      throw invalid("settlement observation windows are not monotonic")
    samples.push(...window.samples)
    previousEndAtMs = window.endAtMs
  }
  return buildSettlementObservationWindow({
    samples,
    minimumSamples,
  })
}

/** Validate a copied observation card before it is used in a gate review. */
export const assertSettlementObservationWindow = (value: unknown): void => {
  if (!isRecord(value)) throw invalid("settlement observation window is not an object")
  if (
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "sampleCount",
      "minimumSamples",
      "startAtMs",
      "endAtMs",
      "samples",
      "ownerOrder",
      "allOwnerOrderStable",
      "allProviderFenced",
      "duplicateExecutionDigests",
      "outcome",
      "providerExecutionAllowed",
      "reviewOnly",
      "promotionAuthorized",
      "status",
      "windowDigest",
    ])
  )
    throw invalid("settlement observation window fields drifted")
  if (
    value.schemaVersion !== SETTLEMENT_OBSERVATION_SCHEMA_VERSION ||
    value.kind !== SETTLEMENT_OBSERVATION_KIND ||
    !Number.isSafeInteger(value.sampleCount) ||
    (value.sampleCount as number) < 0 ||
    (value.sampleCount as number) > MAX_SAMPLES ||
    !Number.isSafeInteger(value.minimumSamples) ||
    (value.minimumSamples as number) < 1 ||
    (value.minimumSamples as number) > MAX_SAMPLES ||
    !Number.isSafeInteger(value.startAtMs) ||
    (value.startAtMs as number) < 0 ||
    !Number.isSafeInteger(value.endAtMs) ||
    (value.endAtMs as number) < 0 ||
    !Array.isArray(value.samples) ||
    value.samples.length !== value.sampleCount ||
    !isOwnerOrder(value.ownerOrder) ||
    value.allOwnerOrderStable !== true ||
    value.allProviderFenced !== true ||
    value.duplicateExecutionDigests !== 0 ||
    value.outcome !== "committed" ||
    value.providerExecutionAllowed !== false ||
    value.reviewOnly !== true ||
    value.promotionAuthorized !== false ||
    (value.status !== "insufficient-observations" && value.status !== "ready-for-review") ||
    typeof value.windowDigest !== "string" ||
    !DIGEST.test(value.windowDigest)
  )
    throw invalid("settlement observation window is invalid")

  const sampleCount = value.sampleCount as number
  const minimumSamples = value.minimumSamples as number
  const startAtMs = value.startAtMs as number
  const endAtMs = value.endAtMs as number
  const status = value.status as SettlementObservationWindowStatus
  const samples = value.samples.map(validateSample)
  const digests = new Set<string>()
  const transactions = new Set<string>()
  const transactionKeys = new Set<string>()
  for (const [index, sample] of samples.entries()) {
    if (digests.has(sample.executionDigest)) throw invalid("settlement observation execution is duplicated")
    if (transactions.has(sample.transactionID)) throw invalid("settlement observation transaction is duplicated")
    if (transactionKeys.has(sample.transactionKey))
      throw invalid("settlement observation transaction key is duplicated")
    digests.add(sample.executionDigest)
    transactions.add(sample.transactionID)
    transactionKeys.add(sample.transactionKey)
    const previous = samples[index - 1]
    if (previous !== undefined && sample.observedAtMs < previous.observedAtMs)
      throw invalid("settlement observation timestamps are not monotonic")
  }
  const expectedStatus = samples.length >= minimumSamples ? "ready-for-review" : "insufficient-observations"
  if (status !== expectedStatus) throw invalid("settlement observation status drifted")
  if (samples.length > 0 && (startAtMs !== samples[0]!.observedAtMs || endAtMs !== samples.at(-1)!.observedAtMs))
    throw invalid("settlement observation time window drifted")
  if (samples.length === 0 && (startAtMs !== 0 || endAtMs !== 0))
    throw invalid("empty settlement observation window has a non-empty time range")
  const expectedDigest = canonicalHash(
    windowSemantic({
      schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
      kind: SETTLEMENT_OBSERVATION_KIND,
      sampleCount,
      minimumSamples,
      startAtMs,
      endAtMs,
      samples,
      ownerOrder: OWNER_ORDER,
      allOwnerOrderStable: true,
      allProviderFenced: true,
      duplicateExecutionDigests: 0,
      outcome: "committed",
      providerExecutionAllowed: false,
      reviewOnly: true,
      promotionAuthorized: false,
      status,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== value.windowDigest)
    throw invalid("settlement observation window digest drifted")
}

const canonicalWindowFrom = (value: unknown): SettlementObservationWindow => {
  assertSettlementObservationWindow(value)
  const record = value as Record<string, unknown>
  return buildSettlementObservationWindow({
    samples: (record.samples as ReadonlyArray<unknown>).map(validateSample),
    minimumSamples: record.minimumSamples as number,
  })
}

/** Build a restart-safe checkpoint without storing settlement payloads. */
export const buildSettlementObservationCheckpoint = (input: {
  readonly observerID: string
  readonly window: SettlementObservationWindow
}): SettlementObservationCheckpoint => {
  const observerID = normalizeObserverID(input.observerID)
  const window = canonicalWindowFrom(input.window)
  const candidate = {
    schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
    kind: SETTLEMENT_OBSERVATION_CHECKPOINT_KIND,
    observerID,
    window,
  }
  const checkpointDigest = canonicalHash(checkpointSemantic(candidate))
  if (checkpointDigest === undefined) throw invalid("settlement observation checkpoint is not canonically hashable")
  return Object.freeze({ ...candidate, checkpointDigest })
}

const reviewPolicyValue = (value: unknown): SettlementObservationReviewPolicy => {
  if (!isRecord(value) || !exactKeys(value, ["minimumSamples", "minimumWindowDurationMs", "maximumSampleGapMs"]))
    throw invalid("settlement observation review policy fields drifted")
  if (
    !Number.isSafeInteger(value.minimumSamples) ||
    (value.minimumSamples as number) < 1 ||
    (value.minimumSamples as number) > MAX_SAMPLES ||
    !Number.isSafeInteger(value.minimumWindowDurationMs) ||
    (value.minimumWindowDurationMs as number) < 0 ||
    (value.minimumWindowDurationMs as number) > 31_536_000_000 ||
    !Number.isSafeInteger(value.maximumSampleGapMs) ||
    (value.maximumSampleGapMs as number) < 0 ||
    (value.maximumSampleGapMs as number) > 31_536_000_000
  )
    throw invalid("settlement observation review policy is invalid")
  return Object.freeze({
    minimumSamples: value.minimumSamples as number,
    minimumWindowDurationMs: value.minimumWindowDurationMs as number,
    maximumSampleGapMs: value.maximumSampleGapMs as number,
  })
}

const reviewBlockers = (input: {
  readonly sampleCount: number
  readonly durationMs: number
  readonly minimumSamples: number
  readonly minimumWindowDurationMs: number
  readonly observedMaximumGapMs: number
  readonly maximumSampleGapMs: number
}): ReadonlyArray<SettlementObservationReviewBlocker> => {
  const blockers: SettlementObservationReviewBlocker[] = []
  if (input.sampleCount < input.minimumSamples) blockers.push("insufficient-samples")
  if (input.durationMs < input.minimumWindowDurationMs) blockers.push("insufficient-duration")
  if (input.observedMaximumGapMs > input.maximumSampleGapMs) blockers.push("sample-gap-too-large")
  return Object.freeze(blockers)
}

/**
 * Evaluate a validated observation window against an explicit long-running
 * review policy.  The policy is caller-supplied so production can choose a
 * documented window without hiding a new threshold in the runtime.  No
 * result from this function changes `settlementCommitEnableGate()`.
 */
export const reviewSettlementObservationWindow = (input: {
  readonly window: SettlementObservationWindow
  readonly policy: SettlementObservationReviewPolicy
}): SettlementObservationReview => {
  assertSettlementObservationWindow(input.window)
  const policy = reviewPolicyValue(input.policy)
  const window = input.window
  let observedMaximumGapMs = 0
  for (let index = 1; index < window.samples.length; index += 1) {
    const previous = window.samples[index - 1]!
    const current = window.samples[index]!
    observedMaximumGapMs = Math.max(observedMaximumGapMs, current.observedAtMs - previous.observedAtMs)
  }
  const durationMs = window.endAtMs - window.startAtMs
  const blockers = reviewBlockers({
    sampleCount: window.sampleCount,
    durationMs,
    minimumSamples: policy.minimumSamples,
    minimumWindowDurationMs: policy.minimumWindowDurationMs,
    observedMaximumGapMs,
    maximumSampleGapMs: policy.maximumSampleGapMs,
  })
  const candidate = {
    schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
    kind: SETTLEMENT_OBSERVATION_REVIEW_KIND,
    windowDigest: window.windowDigest,
    sampleCount: window.sampleCount,
    durationMs,
    minimumSamples: policy.minimumSamples,
    minimumWindowDurationMs: policy.minimumWindowDurationMs,
    maximumSampleGapMs: policy.maximumSampleGapMs,
    observedMaximumGapMs,
    blockers,
    status: blockers.length === 0 ? ("ready-for-review" as const) : ("hold" as const),
    reviewOnly: true as const,
    promotionAuthorized: false as const,
    providerExecutionAllowed: false as const,
  }
  const reviewDigest = canonicalHash(reviewSemantic(candidate))
  if (reviewDigest === undefined) throw invalid("settlement observation review is not canonically hashable")
  return Object.freeze({ ...candidate, reviewDigest })
}

/** Validate a serialized review card before it is used in production review. */
export const assertSettlementObservationReview = (value: unknown): void => {
  if (!isRecord(value)) throw invalid("settlement observation review is not an object")
  if (
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "windowDigest",
      "sampleCount",
      "durationMs",
      "minimumSamples",
      "minimumWindowDurationMs",
      "maximumSampleGapMs",
      "observedMaximumGapMs",
      "blockers",
      "status",
      "reviewOnly",
      "promotionAuthorized",
      "providerExecutionAllowed",
      "reviewDigest",
    ])
  )
    throw invalid("settlement observation review fields drifted")
  if (
    value.schemaVersion !== SETTLEMENT_OBSERVATION_SCHEMA_VERSION ||
    value.kind !== SETTLEMENT_OBSERVATION_REVIEW_KIND ||
    typeof value.windowDigest !== "string" ||
    !DIGEST.test(value.windowDigest) ||
    !Number.isSafeInteger(value.sampleCount) ||
    (value.sampleCount as number) < 0 ||
    (value.sampleCount as number) > MAX_SAMPLES ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs as number) < 0 ||
    !Number.isSafeInteger(value.minimumSamples) ||
    (value.minimumSamples as number) < 1 ||
    (value.minimumSamples as number) > MAX_SAMPLES ||
    !Number.isSafeInteger(value.minimumWindowDurationMs) ||
    (value.minimumWindowDurationMs as number) < 0 ||
    (value.minimumWindowDurationMs as number) > 31_536_000_000 ||
    !Number.isSafeInteger(value.maximumSampleGapMs) ||
    (value.maximumSampleGapMs as number) < 0 ||
    (value.maximumSampleGapMs as number) > 31_536_000_000 ||
    !Number.isSafeInteger(value.observedMaximumGapMs) ||
    (value.observedMaximumGapMs as number) < 0 ||
    (value.observedMaximumGapMs as number) > 31_536_000_000 ||
    !Array.isArray(value.blockers) ||
    (value.status !== "hold" && value.status !== "ready-for-review") ||
    value.reviewOnly !== true ||
    value.promotionAuthorized !== false ||
    value.providerExecutionAllowed !== false ||
    typeof value.reviewDigest !== "string" ||
    !DIGEST.test(value.reviewDigest)
  )
    throw invalid("settlement observation review is invalid")

  const blockers = value.blockers as unknown[]
  const allowed: ReadonlyArray<SettlementObservationReviewBlocker> = [
    "insufficient-samples",
    "insufficient-duration",
    "sample-gap-too-large",
  ]
  if (
    blockers.some(
      (item) => typeof item !== "string" || !allowed.includes(item as SettlementObservationReviewBlocker),
    ) ||
    new Set(blockers).size !== blockers.length
  )
    throw invalid("settlement observation review blockers are invalid")
  const expectedBlockers = reviewBlockers({
    sampleCount: value.sampleCount as number,
    durationMs: value.durationMs as number,
    minimumSamples: value.minimumSamples as number,
    minimumWindowDurationMs: value.minimumWindowDurationMs as number,
    observedMaximumGapMs: value.observedMaximumGapMs as number,
    maximumSampleGapMs: value.maximumSampleGapMs as number,
  })
  if (JSON.stringify(blockers) !== JSON.stringify(expectedBlockers))
    throw invalid("settlement observation review blockers drifted")
  const expectedStatus = blockers.length === 0 ? "ready-for-review" : "hold"
  if (value.status !== expectedStatus) throw invalid("settlement observation review status drifted")
  const expectedDigest = canonicalHash(
    reviewSemantic({
      schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
      kind: SETTLEMENT_OBSERVATION_REVIEW_KIND,
      windowDigest: value.windowDigest as string,
      sampleCount: value.sampleCount as number,
      durationMs: value.durationMs as number,
      minimumSamples: value.minimumSamples as number,
      minimumWindowDurationMs: value.minimumWindowDurationMs as number,
      maximumSampleGapMs: value.maximumSampleGapMs as number,
      observedMaximumGapMs: value.observedMaximumGapMs as number,
      blockers: expectedBlockers,
      status: value.status as "hold" | "ready-for-review",
      reviewOnly: true,
      promotionAuthorized: false,
      providerExecutionAllowed: false,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== value.reviewDigest)
    throw invalid("settlement observation review digest drifted")
}

/** Validate a serialized checkpoint before a long-running observer resumes. */
export const assertSettlementObservationCheckpoint = (value: unknown): void => {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "kind", "observerID", "window", "checkpointDigest"]))
    throw invalid("settlement observation checkpoint fields drifted")
  if (
    value.schemaVersion !== SETTLEMENT_OBSERVATION_SCHEMA_VERSION ||
    value.kind !== SETTLEMENT_OBSERVATION_CHECKPOINT_KIND ||
    typeof value.observerID !== "string" ||
    !OBSERVER_ID.test(value.observerID) ||
    !isRecord(value.window) ||
    typeof value.checkpointDigest !== "string" ||
    !DIGEST.test(value.checkpointDigest)
  )
    throw invalid("settlement observation checkpoint is invalid")
  const observerID = value.observerID as string
  const window = canonicalWindowFrom(value.window)
  const expectedDigest = canonicalHash(
    checkpointSemantic({
      schemaVersion: SETTLEMENT_OBSERVATION_SCHEMA_VERSION,
      kind: SETTLEMENT_OBSERVATION_CHECKPOINT_KIND,
      observerID,
      window,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== value.checkpointDigest)
    throw invalid("settlement observation checkpoint digest drifted")
}

/**
 * Append one validated sample to a checkpoint.  The previous checkpoint is
 * treated as an immutable prefix; any observer or ordering drift fails closed.
 */
export const appendSettlementObservationCheckpoint = (input: {
  readonly observerID: string
  readonly sample: SettlementObservationSample
  readonly checkpoint?: unknown
  readonly minimumSamples?: number
}): SettlementObservationCheckpoint => {
  const observerID = normalizeObserverID(input.observerID)
  const sample = validateSample(input.sample)
  if (input.checkpoint === undefined) {
    return buildSettlementObservationCheckpoint({
      observerID,
      window: buildSettlementObservationWindow({
        samples: [sample],
        ...(input.minimumSamples === undefined ? {} : { minimumSamples: input.minimumSamples }),
      }),
    })
  }
  assertSettlementObservationCheckpoint(input.checkpoint)
  const checkpoint = input.checkpoint as SettlementObservationCheckpoint
  if (checkpoint.observerID !== observerID) throw invalid("settlement observation observerID drifted")
  const currentWindow = canonicalWindowFrom(checkpoint.window)
  if (sample.observedAtMs < currentWindow.endAtMs) throw invalid("settlement observation timestamps are not monotonic")
  const minimumSamples = input.minimumSamples ?? currentWindow.minimumSamples
  const nextWindow = mergeSettlementObservationWindows({
    windows: [
      currentWindow,
      buildSettlementObservationWindow({
        samples: [sample],
        minimumSamples,
      }),
    ],
    minimumSamples,
  })
  return buildSettlementObservationCheckpoint({ observerID, window: nextWindow })
}

/** Resume a checkpoint as a fresh immutable observation window projection. */
export const resumeSettlementObservationCheckpoint = (value: unknown): SettlementObservationWindow => {
  assertSettlementObservationCheckpoint(value)
  return canonicalWindowFrom((value as SettlementObservationCheckpoint).window)
}
