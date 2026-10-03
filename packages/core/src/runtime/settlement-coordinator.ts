/**
 * Transaction-bound child-settlement coordinator.
 *
 * This module is the only Core seam that may prove a same-transaction
 * settlement.  It deliberately accepts owner writers instead of reaching
 * into EventV2, ExperienceStore, or DurableRun itself: each owner remains the
 * authority for its aggregate, while this coordinator injects the exact
 * transaction handle and enforces one order, one transaction identity, and
 * one payload-free receipt shape.
 *
 * The coordinator is not a provider runner and does not promote the
 * production enable gate.  Until the real production owners are adapted to
 * these transaction-bound writers, callers must continue using the durable
 * recovery outbox path.
 */

import { Effect } from "effect"
import { Database } from "../database/database"
import * as ChildSettlement from "./child-settlement"
import { canonicalHash } from "../util/canonical-hash"

export const SETTLEMENT_COORDINATOR_SCHEMA_VERSION = 1 as const

const DIGEST = /^[a-f0-9]{64}$/i
const TRANSACTION_ID = /^tx_[A-Za-z0-9._:-]{1,255}$/
const OWNER_ORDER: ReadonlyArray<ChildSettlement.SettlementWrite> = Object.freeze([
  "admission-evidence",
  "child-result",
  "parent-budget",
])

type DatabaseTransaction = Parameters<Parameters<Database.Interface["db"]["transaction"]>[0]>[0]

/** The metadata a transaction-bound owner must return after its write. */
export type SettlementOwnerReceipt = Readonly<{
  readonly schemaVersion: typeof SETTLEMENT_COORDINATOR_SCHEMA_VERSION
  readonly owner: ChildSettlement.SettlementWrite
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerDigest: string
}>

/** The only context an owner writer receives; no prompt/result/provider payload crosses it. */
export type SettlementOwnerTransactionScope = Readonly<{
  readonly owner: ChildSettlement.SettlementWrite
  readonly transactionKey: string
  readonly transactionID: string
  readonly providerExecutionAllowed: false
}>

export type SettlementOwnerWriter = (
  transaction: DatabaseTransaction,
  scope: SettlementOwnerTransactionScope,
) => Effect.Effect<SettlementOwnerReceipt, Error>

export type SettlementOwnerWriters = Readonly<Record<ChildSettlement.SettlementWrite, SettlementOwnerWriter>>

/**
 * Optional transaction runner supplied by a trusted production binding.
 *
 * The default coordinator path calls `database.transaction` directly for
 * backwards-compatible isolated tests.  A production caller should pass a
 * runner that establishes the request principal and then invokes this
 * callback, so PostgreSQL `SET LOCAL` and the Drizzle transaction handle are
 * guaranteed to belong to the same physical connection.  The callback is the
 * only place owner writes receive the handle; it cannot open a second
 * transaction without violating the owner contract (and the owner receipts
 * will fail validation if the binding drifts).
 */
export type SettlementTransactionRunner = <A, E, R>(
  callback: (transaction: DatabaseTransaction) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>

/**
 * Optional metadata-only work that must run after all settlement owners have
 * written and before the shared transaction commits.  The callback receives
 * the same transaction handle and the payload-free execution receipt; it is
 * intentionally not given provider output, prompts, or business payloads.
 * Any failure aborts the outer transaction and is surfaced as a transaction
 * failure to the caller.
 */
export type SettlementBeforeCommit = (input: {
  readonly transaction: DatabaseTransaction
  readonly execution: SettlementTransactionExecution
}) => Effect.Effect<void, Error>

/**
 * Legacy child settlements do not carry admission Evidence.  They still
 * benefit from one transaction for the child-result and parent-budget
 * aggregates, but they deliberately use a smaller owner order and no
 * cross-owner Evidence card.  Keeping this contract next to the Evidence
 * path prevents a second coordinator implementation from appearing in
 * DurableRun callers.
 */
export type LegacySettlementOwner = "child-result" | "parent-budget"
export type LegacySettlementOwnerWriters = Readonly<Record<LegacySettlementOwner, SettlementOwnerWriter>>

export interface SettlementTransactionExecution {
  readonly schemaVersion: typeof SETTLEMENT_COORDINATOR_SCHEMA_VERSION
  readonly planDigest: string
  readonly evidenceDigest: string
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite>
  readonly ownerReceipts: ReadonlyArray<SettlementOwnerReceipt>
  /** Returned only after the database transaction callback has committed. */
  readonly outcome: "committed"
  readonly providerExecutionAllowed: false
  /** Digest excludes timestamps and all owner payloads. */
  readonly executionDigest: string
  readonly observedAtMs: number
}

export type SettlementCoordinatorErrorCode = "INVALID_INPUT" | "OWNER_FAILURE" | "TRANSACTION_FAILURE"

export class SettlementCoordinatorError extends Error {
  readonly _tag = "Runtime.SettlementCoordinatorError"

  constructor(
    readonly code: SettlementCoordinatorErrorCode,
    reason: string,
    readonly owner?: ChildSettlement.SettlementWrite,
  ) {
    super(reason)
    this.name = this._tag
  }
}

export interface SettlementTransactionInput {
  readonly database: Database.Interface["db"]
  /** Must be a same-transaction, Evidence-bearing immutable plan. */
  readonly plan: ChildSettlement.SettlementCommitPlan
  /** Must have been produced for exactly `plan.transactionKey` and owner order. */
  readonly sharedTransactionEvidence: ChildSettlement.SettlementSharedTransactionEvidence
  readonly writers: SettlementOwnerWriters
  /**
   * Optional trusted principal/connection binding.  When omitted, the
   * coordinator retains its historical direct `database.transaction` path;
   * when present, exactly this runner supplies the single transaction handle.
   */
  readonly transaction?: SettlementTransactionRunner
  /** Optional metadata-only journal work executed before the transaction commits. */
  readonly beforeCommit?: SettlementBeforeCommit
  readonly observedAtMs?: number
}

/**
 * Production-shaped input for the coordinator.
 *
 * The low-level `SettlementTransactionInput` intentionally keeps a raw
 * database handle so isolated tests can exercise rollback cheaply.  A real
 * owner must not repeat that pattern: it has to pass the Database service so
 * the transaction is opened through `transactionAsPrincipal`, which binds the
 * RLS principal and the Drizzle handle to the same physical transaction.
 * `principal` is optional only to support callers already running inside the
 * request context; in that case `CurrentPrincipal` is used and finally falls
 * back to the private local principal.
 */
export type PrincipalBoundSettlementTransactionInput = Omit<SettlementTransactionInput, "database" | "transaction"> & {
  readonly database: Database.Interface
  readonly principal?: Database.Principal
}

export interface LegacySettlementTransactionExecution {
  readonly schemaVersion: typeof SETTLEMENT_COORDINATOR_SCHEMA_VERSION
  readonly planDigest: string
  readonly transactionKey: string
  readonly transactionID: string
  readonly ownerOrder: ReadonlyArray<LegacySettlementOwner>
  readonly ownerReceipts: ReadonlyArray<SettlementOwnerReceipt>
  readonly outcome: "committed"
  readonly providerExecutionAllowed: false
  readonly executionDigest: string
  readonly observedAtMs: number
}

export interface LegacySettlementTransactionInput {
  readonly database: Database.Interface["db"]
  /** Must be a same-transaction plan without admission Evidence. */
  readonly plan: ChildSettlement.SettlementCommitPlan
  /** Concrete runtime transaction identity used for the payload-free receipt. */
  readonly transactionID: string
  readonly writers: LegacySettlementOwnerWriters
  /** See `SettlementTransactionInput.transaction`. */
  readonly transaction?: SettlementTransactionRunner
  readonly observedAtMs?: number
}

/** Canonical production-shaped input for legacy two-owner settlement. */
export type PrincipalBoundLegacySettlementTransactionInput = Omit<
  LegacySettlementTransactionInput,
  "database" | "transaction"
> & {
  readonly database: Database.Interface
  readonly principal?: Database.Principal
}

const exactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>): boolean => {
  const actual = Reflect.ownKeys(value)
    .filter((key): key is string => typeof key === "string")
    .sort()
  return JSON.stringify(actual) === JSON.stringify([...expected].sort())
}

const plainRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return undefined
  return value as Record<string, unknown>
}

const invalid = (reason: string): SettlementCoordinatorError => new SettlementCoordinatorError("INVALID_INPUT", reason)

const transactionFailure = (error: unknown): SettlementCoordinatorError =>
  new SettlementCoordinatorError(
    "TRANSACTION_FAILURE",
    `The shared settlement transaction failed: ${error instanceof Error ? error.message : String(error)}`,
  )

const validateObservedAt = (observedAtMs: number | undefined): number => {
  const value = observedAtMs ?? Date.now()
  if (!Number.isSafeInteger(value) || value < 0) throw invalid("Settlement coordinator observation time is invalid.")
  return value
}

const validateInput = (input: SettlementTransactionInput): number => {
  if (input === null || typeof input !== "object") throw invalid("Settlement coordinator input is required.")
  if (input.database === null || typeof input.database !== "object")
    throw invalid("Settlement coordinator database is required.")
  try {
    ChildSettlement.assertSettlementCommitPlan(input.plan)
  } catch (error) {
    throw invalid(`Settlement coordinator commit plan is invalid: ${String(error)}`)
  }
  if (input.plan.mode !== "same-transaction" || input.plan.outboxRequired !== false)
    throw invalid("Settlement coordinator accepts only same-transaction plans.")
  if (JSON.stringify(input.plan.ownerOrder) !== JSON.stringify(OWNER_ORDER))
    throw invalid("Settlement coordinator requires the complete Evidence → result → budget owner order.")
  try {
    ChildSettlement.assertSettlementSharedTransactionEvidence(input.sharedTransactionEvidence, {
      transactionKey: input.plan.transactionKey,
      ownerOrder: input.plan.ownerOrder,
    })
  } catch (error) {
    throw invalid(`Settlement coordinator transaction evidence is invalid: ${String(error)}`)
  }
  if (input.sharedTransactionEvidence.evidenceDigest !== input.plan.sharedTransactionEvidenceDigest)
    throw invalid("Settlement coordinator evidence digest does not match the immutable commit plan.")
  for (const owner of OWNER_ORDER) {
    if (typeof input.writers?.[owner] !== "function")
      throw invalid(`Settlement coordinator writer is missing for ${owner}.`)
  }
  if (input.transaction !== undefined && typeof input.transaction !== "function")
    throw invalid("Settlement coordinator transaction runner is invalid.")
  return validateObservedAt(input.observedAtMs)
}

const expectedOwnerDigest = (
  plan: ChildSettlement.SettlementCommitPlan,
  owner: ChildSettlement.SettlementWrite,
): string => {
  const digest =
    owner === "admission-evidence"
      ? plan.expectedDigests.evidence
      : owner === "child-result"
        ? plan.expectedDigests.childResult
        : plan.expectedDigests.parentBudget
  if (digest === undefined || !DIGEST.test(digest))
    throw invalid(`Settlement coordinator expected digest is unavailable for ${owner}.`)
  return digest
}

const validateReceipt = (
  value: unknown,
  expected: Readonly<{
    readonly owner: ChildSettlement.SettlementWrite
    readonly transactionKey: string
    readonly transactionID: string
    readonly ownerDigest: string
  }>,
): SettlementOwnerReceipt => {
  const record = plainRecord(value)
  if (!record || !exactKeys(record, ["schemaVersion", "owner", "transactionKey", "transactionID", "ownerDigest"]))
    throw invalid(`Settlement coordinator ${expected.owner} receipt fields drifted.`)
  if (
    record.schemaVersion !== SETTLEMENT_COORDINATOR_SCHEMA_VERSION ||
    record.owner !== expected.owner ||
    record.transactionKey !== expected.transactionKey ||
    record.transactionID !== expected.transactionID ||
    record.ownerDigest !== expected.ownerDigest
  )
    throw invalid(`Settlement coordinator ${expected.owner} receipt does not match the immutable transaction binding.`)
  if (typeof record.transactionID !== "string" || !TRANSACTION_ID.test(record.transactionID))
    throw invalid(`Settlement coordinator ${expected.owner} transaction identity is invalid.`)
  if (typeof record.ownerDigest !== "string" || !DIGEST.test(record.ownerDigest))
    throw invalid(`Settlement coordinator ${expected.owner} digest is invalid.`)
  return Object.freeze({
    schemaVersion: SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
    owner: expected.owner,
    transactionKey: expected.transactionKey,
    transactionID: expected.transactionID,
    ownerDigest: expected.ownerDigest,
  })
}

const executionSemantic = (
  value: Pick<
    SettlementTransactionExecution,
    | "schemaVersion"
    | "planDigest"
    | "evidenceDigest"
    | "transactionKey"
    | "transactionID"
    | "ownerOrder"
    | "ownerReceipts"
    | "outcome"
    | "providerExecutionAllowed"
  >,
) => ({
  domain: "arforge/settlement-transaction-execution/v1",
  schemaVersion: value.schemaVersion,
  planDigest: value.planDigest,
  evidenceDigest: value.evidenceDigest,
  transactionKey: value.transactionKey,
  transactionID: value.transactionID,
  ownerOrder: [...value.ownerOrder],
  ownerReceipts: value.ownerReceipts.map((receipt) => ({ ...receipt })),
  outcome: value.outcome,
  providerExecutionAllowed: value.providerExecutionAllowed,
})

const LEGACY_OWNER_ORDER: ReadonlyArray<LegacySettlementOwner> = Object.freeze(["child-result", "parent-budget"])

const legacyExecutionSemantic = (
  value: Pick<
    LegacySettlementTransactionExecution,
    | "schemaVersion"
    | "planDigest"
    | "transactionKey"
    | "transactionID"
    | "ownerOrder"
    | "ownerReceipts"
    | "outcome"
    | "providerExecutionAllowed"
  >,
) => ({
  domain: "arforge/legacy-settlement-transaction-execution/v1",
  schemaVersion: value.schemaVersion,
  planDigest: value.planDigest,
  transactionKey: value.transactionKey,
  transactionID: value.transactionID,
  ownerOrder: [...value.ownerOrder],
  ownerReceipts: value.ownerReceipts.map((receipt) => ({ ...receipt })),
  outcome: value.outcome,
  providerExecutionAllowed: value.providerExecutionAllowed,
})

const validateLegacyInput = (input: LegacySettlementTransactionInput): number => {
  if (input === null || typeof input !== "object") throw invalid("Legacy settlement coordinator input is required.")
  if (input.database === null || typeof input.database !== "object")
    throw invalid("Legacy settlement coordinator database is required.")
  try {
    ChildSettlement.assertSettlementCommitPlan(input.plan)
  } catch (error) {
    throw invalid(`Legacy settlement coordinator commit plan is invalid: ${String(error)}`)
  }
  if (input.plan.mode !== "same-transaction" || input.plan.outboxRequired !== false)
    throw invalid("Legacy settlement coordinator accepts only same-transaction plans.")
  if (input.plan.owners.evidence !== "not-required")
    throw invalid("Legacy settlement coordinator cannot accept an Evidence-bearing plan.")
  if (JSON.stringify(input.plan.ownerOrder) !== JSON.stringify(LEGACY_OWNER_ORDER))
    throw invalid("Legacy settlement coordinator requires the child-result → parent-budget owner order.")
  if (typeof input.transactionID !== "string" || !TRANSACTION_ID.test(input.transactionID))
    throw invalid("Legacy settlement coordinator transaction identity is invalid.")
  for (const owner of LEGACY_OWNER_ORDER) {
    if (typeof input.writers?.[owner] !== "function")
      throw invalid(`Legacy settlement coordinator writer is missing for ${owner}.`)
  }
  if (input.transaction !== undefined && typeof input.transaction !== "function")
    throw invalid("Legacy settlement coordinator transaction runner is invalid.")
  return validateObservedAt(input.observedAtMs)
}

/**
 * Validate a committed execution receipt against the immutable plan/card.
 * This is intentionally exported for the package-owned runtime invariant and
 * operator diagnostics; it does not read the database or perform a write.
 */
export const assertSettlementTransactionExecution = (
  value: unknown,
  input: Readonly<{
    readonly plan: ChildSettlement.SettlementCommitPlan
    readonly sharedTransactionEvidence: ChildSettlement.SettlementSharedTransactionEvidence
  }>,
): void => {
  const record = plainRecord(value)
  if (
    !record ||
    !exactKeys(record, [
      "schemaVersion",
      "planDigest",
      "evidenceDigest",
      "transactionKey",
      "transactionID",
      "ownerOrder",
      "ownerReceipts",
      "outcome",
      "providerExecutionAllowed",
      "executionDigest",
      "observedAtMs",
    ])
  )
    throw invalid("Settlement coordinator execution receipt fields drifted.")
  try {
    ChildSettlement.assertSettlementCommitPlan(input.plan)
    ChildSettlement.assertSettlementSharedTransactionEvidence(input.sharedTransactionEvidence, {
      transactionKey: input.plan.transactionKey,
      ownerOrder: input.plan.ownerOrder,
    })
  } catch (error) {
    throw invalid(`Settlement coordinator execution contract is invalid: ${String(error)}`)
  }
  if (
    record.schemaVersion !== SETTLEMENT_COORDINATOR_SCHEMA_VERSION ||
    record.planDigest !== input.plan.commitDigest ||
    record.evidenceDigest !== input.sharedTransactionEvidence.evidenceDigest ||
    record.transactionKey !== input.plan.transactionKey ||
    record.transactionID !== input.sharedTransactionEvidence.transactionID ||
    JSON.stringify(record.ownerOrder) !== JSON.stringify(OWNER_ORDER) ||
    record.outcome !== "committed" ||
    record.providerExecutionAllowed !== false ||
    !Array.isArray(record.ownerReceipts) ||
    record.ownerReceipts.length !== OWNER_ORDER.length ||
    typeof record.executionDigest !== "string" ||
    !DIGEST.test(record.executionDigest) ||
    !Number.isSafeInteger(record.observedAtMs) ||
    (record.observedAtMs as number) < 0
  )
    throw invalid("Settlement coordinator execution receipt does not match its immutable contract.")
  const rawReceipts = record.ownerReceipts as ReadonlyArray<unknown>
  const receipts = OWNER_ORDER.map((owner, index) => {
    const expectedOwner = expectedOwnerDigest(input.plan, owner)
    return validateReceipt(rawReceipts[index], {
      owner,
      transactionKey: input.plan.transactionKey,
      transactionID: input.sharedTransactionEvidence.transactionID,
      ownerDigest: expectedOwner,
    })
  })
  const expectedDigest = canonicalHash(
    executionSemantic({
      schemaVersion: SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
      planDigest: input.plan.commitDigest,
      evidenceDigest: input.sharedTransactionEvidence.evidenceDigest,
      transactionKey: input.plan.transactionKey,
      transactionID: input.sharedTransactionEvidence.transactionID,
      ownerOrder: OWNER_ORDER,
      ownerReceipts: receipts,
      outcome: "committed",
      providerExecutionAllowed: false,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== record.executionDigest)
    throw invalid("Settlement coordinator execution digest drifted.")
}

/** Validate a committed two-owner legacy execution receipt. */
export const assertLegacySettlementTransactionExecution = (
  value: unknown,
  input: Readonly<{
    readonly plan: ChildSettlement.SettlementCommitPlan
    readonly transactionID: string
  }>,
): void => {
  const record = plainRecord(value)
  if (
    !record ||
    !exactKeys(record, [
      "schemaVersion",
      "planDigest",
      "transactionKey",
      "transactionID",
      "ownerOrder",
      "ownerReceipts",
      "outcome",
      "providerExecutionAllowed",
      "executionDigest",
      "observedAtMs",
    ])
  )
    throw invalid("Legacy settlement coordinator execution receipt fields drifted.")
  try {
    ChildSettlement.assertSettlementCommitPlan(input.plan)
  } catch (error) {
    throw invalid(`Legacy settlement coordinator execution contract is invalid: ${String(error)}`)
  }
  if (
    input.plan.mode !== "same-transaction" ||
    input.plan.outboxRequired !== false ||
    input.plan.owners.evidence !== "not-required" ||
    JSON.stringify(input.plan.ownerOrder) !== JSON.stringify(LEGACY_OWNER_ORDER)
  )
    throw invalid("Legacy settlement coordinator execution requires a two-owner same-transaction plan.")
  if (
    record.schemaVersion !== SETTLEMENT_COORDINATOR_SCHEMA_VERSION ||
    record.planDigest !== input.plan.commitDigest ||
    record.transactionKey !== input.plan.transactionKey ||
    record.transactionID !== input.transactionID ||
    JSON.stringify(record.ownerOrder) !== JSON.stringify(LEGACY_OWNER_ORDER) ||
    record.outcome !== "committed" ||
    record.providerExecutionAllowed !== false ||
    !Array.isArray(record.ownerReceipts) ||
    record.ownerReceipts.length !== LEGACY_OWNER_ORDER.length ||
    typeof record.executionDigest !== "string" ||
    !DIGEST.test(record.executionDigest) ||
    !Number.isSafeInteger(record.observedAtMs) ||
    (record.observedAtMs as number) < 0
  )
    throw invalid("Legacy settlement coordinator execution receipt does not match its immutable contract.")
  const rawReceipts = record.ownerReceipts as ReadonlyArray<unknown>
  const receipts = LEGACY_OWNER_ORDER.map((owner, index) =>
    validateReceipt(rawReceipts[index], {
      owner,
      transactionKey: input.plan.transactionKey,
      transactionID: input.transactionID,
      ownerDigest: expectedOwnerDigest(input.plan, owner),
    }),
  )
  const expectedDigest = canonicalHash(
    legacyExecutionSemantic({
      schemaVersion: SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
      planDigest: input.plan.commitDigest,
      transactionKey: input.plan.transactionKey,
      transactionID: input.transactionID,
      ownerOrder: LEGACY_OWNER_ORDER,
      ownerReceipts: receipts,
      outcome: "committed",
      providerExecutionAllowed: false,
    }),
  )
  if (expectedDigest === undefined || expectedDigest !== record.executionDigest)
    throw invalid("Legacy settlement coordinator execution digest drifted.")
}

/**
 * Execute all three settlement owners on one database transaction handle.
 * Any owner failure aborts the callback and therefore rolls back every owner
 * write. A successful return is the only point at which a committed evidence
 * card may be handed to a future production gate evaluator.
 */
export const executeSettlementTransaction = Effect.fn("SettlementCoordinator.execute")(function* (
  input: SettlementTransactionInput,
) {
  const observedAtMs = yield* Effect.try({
    try: () => validateInput(input),
    catch: (error) => (error instanceof SettlementCoordinatorError ? error : invalid(String(error))),
  })
  const runTransaction = input.transaction ?? ((callback) => input.database.transaction(callback))
  const execution = yield* runTransaction((transaction) =>
    Effect.gen(function* () {
      const completed: SettlementOwnerReceipt[] = []
      for (const owner of OWNER_ORDER) {
        const scope: SettlementOwnerTransactionScope = Object.freeze({
          owner,
          transactionKey: input.plan.transactionKey,
          transactionID: input.sharedTransactionEvidence.transactionID,
          providerExecutionAllowed: false,
        })
        const writer = input.writers[owner]
        const raw = yield* writer(transaction, scope).pipe(
          Effect.mapError(
            (error) =>
              new SettlementCoordinatorError(
                "OWNER_FAILURE",
                `Settlement owner ${owner} failed: ${error instanceof Error ? error.message : String(error)}`,
                owner,
              ),
          ),
        )
        const receipt = yield* Effect.try({
          try: () =>
            validateReceipt(raw, {
              owner,
              transactionKey: input.plan.transactionKey,
              transactionID: input.sharedTransactionEvidence.transactionID,
              ownerDigest: expectedOwnerDigest(input.plan, owner),
            }),
          catch: (error) => (error instanceof SettlementCoordinatorError ? error : invalid(String(error))),
        })
        completed.push(receipt)
      }
      const semantic = {
        schemaVersion: SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
        planDigest: input.plan.commitDigest,
        evidenceDigest: input.sharedTransactionEvidence.evidenceDigest,
        transactionKey: input.plan.transactionKey,
        transactionID: input.sharedTransactionEvidence.transactionID,
        ownerOrder: OWNER_ORDER,
        ownerReceipts: completed as ReadonlyArray<SettlementOwnerReceipt>,
        outcome: "committed" as const,
        providerExecutionAllowed: false as const,
      }
      const executionDigest = canonicalHash(executionSemantic(semantic))
      if (executionDigest === undefined)
        return yield* Effect.fail(invalid("Settlement coordinator execution is not canonically hashable."))
      const execution = Object.freeze({ ...semantic, executionDigest, observedAtMs })
      if (input.beforeCommit) {
        yield* input
          .beforeCommit({ transaction, execution })
          .pipe(
            Effect.mapError(
              (error) =>
                new SettlementCoordinatorError(
                  "TRANSACTION_FAILURE",
                  `Settlement before-commit work failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            ),
          )
      }
      return execution
    }),
  ).pipe(Effect.mapError((error) => (error instanceof SettlementCoordinatorError ? error : transactionFailure(error))))
  return execution
})

/**
 * Execute the Evidence-bearing coordinator through the canonical database
 * service boundary.
 *
 * This is the only production-shaped entrypoint.  It deliberately does not
 * infer readiness and cannot promote `settlementCommitEnableGate`; callers
 * still have to pass the gate before reaching this function.  Its purpose is
 * narrower and important: every owner write is forced through one
 * `Database.transactionAsPrincipal` callback, so a future PostgreSQL binding
 * cannot accidentally open an unbound transaction or lose the request RLS
 * principal between owners.
 */
export const executeSettlementTransactionAsPrincipal = Effect.fn("SettlementCoordinator.executeAsPrincipal")(function* (
  input: PrincipalBoundSettlementTransactionInput,
) {
  const principal = input.principal ?? (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
  return yield* executeSettlementTransaction({
    database: input.database.db,
    plan: input.plan,
    sharedTransactionEvidence: input.sharedTransactionEvidence,
    writers: input.writers,
    transaction: (callback) => input.database.transactionAsPrincipal(principal, callback),
    beforeCommit: input.beforeCommit,
    observedAtMs: input.observedAtMs,
  })
})

/**
 * Execute the two-owner legacy settlement on one transaction handle.
 *
 * This is intentionally separate from the Evidence-bearing function only at
 * the type boundary: it reuses the same receipt validation, transaction
 * failure mapping and digest discipline.  It is useful for legacy children
 * while the three-owner production gate remains blocked on live shared
 * EventV2/ExperienceStore evidence.
 */
export const executeLegacySettlementTransaction = Effect.fn("SettlementCoordinator.executeLegacy")(function* (
  input: LegacySettlementTransactionInput,
) {
  const observedAtMs = yield* Effect.try({
    try: () => validateLegacyInput(input),
    catch: (error) => (error instanceof SettlementCoordinatorError ? error : invalid(String(error))),
  })
  const runTransaction = input.transaction ?? ((callback) => input.database.transaction(callback))
  const receipts = yield* runTransaction((transaction) =>
    Effect.gen(function* () {
      const completed: SettlementOwnerReceipt[] = []
      for (const owner of LEGACY_OWNER_ORDER) {
        const scope: SettlementOwnerTransactionScope = Object.freeze({
          owner,
          transactionKey: input.plan.transactionKey,
          transactionID: input.transactionID,
          providerExecutionAllowed: false,
        })
        const raw = yield* input.writers[owner](transaction, scope).pipe(
          Effect.mapError(
            (error) =>
              new SettlementCoordinatorError(
                "OWNER_FAILURE",
                `Legacy settlement owner ${owner} failed: ${error instanceof Error ? error.message : String(error)}`,
                owner,
              ),
          ),
        )
        const receiptValue = yield* Effect.try({
          try: () =>
            validateReceipt(raw, {
              owner,
              transactionKey: input.plan.transactionKey,
              transactionID: input.transactionID,
              ownerDigest: expectedOwnerDigest(input.plan, owner),
            }),
          catch: (error) => (error instanceof SettlementCoordinatorError ? error : invalid(String(error))),
        })
        completed.push(receiptValue)
      }
      return completed as ReadonlyArray<SettlementOwnerReceipt>
    }),
  ).pipe(Effect.mapError((error) => (error instanceof SettlementCoordinatorError ? error : transactionFailure(error))))

  const semantic = {
    schemaVersion: SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
    planDigest: input.plan.commitDigest,
    transactionKey: input.plan.transactionKey,
    transactionID: input.transactionID,
    ownerOrder: LEGACY_OWNER_ORDER,
    ownerReceipts: receipts,
    outcome: "committed" as const,
    providerExecutionAllowed: false as const,
  }
  const executionDigest = canonicalHash(legacyExecutionSemantic(semantic))
  if (executionDigest === undefined)
    return yield* Effect.fail(invalid("Legacy settlement coordinator execution is not canonically hashable."))
  return Object.freeze({ ...semantic, executionDigest, observedAtMs })
})

/**
 * Canonical Database-service boundary for legacy two-owner settlement.
 *
 * Legacy children remain behind the same production gate as the
 * Evidence-bearing path.  This helper only centralizes principal/connection
 * binding once that gate is intentionally enabled; it does not change the
 * default recovery-outbox decision.
 */
export const executeLegacySettlementTransactionAsPrincipal = Effect.fn(
  "SettlementCoordinator.executeLegacyAsPrincipal",
)(function* (input: PrincipalBoundLegacySettlementTransactionInput) {
  const principal = input.principal ?? (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
  return yield* executeLegacySettlementTransaction({
    database: input.database.db,
    plan: input.plan,
    transactionID: input.transactionID,
    writers: input.writers,
    transaction: (callback) => input.database.transactionAsPrincipal(principal, callback),
    observedAtMs: input.observedAtMs,
  })
})

/** Keep the transaction type private to the adapter surface while exposing a compile-time helper for owners. */
export type SettlementTransactionHandle = DatabaseTransaction
