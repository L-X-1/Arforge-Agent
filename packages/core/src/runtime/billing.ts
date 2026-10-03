import type { Usage as LLMUsage } from "@arforge-ai/llm"
import { Billing } from "@arforge-ai/schema/billing"
import { DateTime, Schema } from "effect"
import { estimate as estimateTokens } from "../util/token"

export type TextEstimateInput = {
  readonly inputText: string
  readonly outputText: string
}

export type TokenEstimator = {
  readonly id: string
  readonly estimate: (input: TextEstimateInput) => Billing.TokenBreakdown
}

export type CatalogResolver = (input: {
  readonly providerID: string
  readonly modelID: string
}) => Billing.PriceCatalog | undefined

/** Optional provider-side lookup used when a failed request may still be billable. */
export type UsageReconciler = (input: {
  readonly runID: string
  readonly reservationID: string
  readonly providerID: string
  readonly modelID: string
  readonly requestDigest: string
  readonly failureCategory: string
}) => Billing.TokenUsage | undefined | Promise<Billing.TokenUsage | undefined>

export type SettlementObserver = (input: {
  readonly runID: string
  readonly providerID: string
  readonly modelID: string
  readonly usage: Billing.TokenUsage
  readonly charge: Billing.Charge
  readonly settlement: Billing.Settlement
  /** Charge normalized to the Personal Job micro-unit convention. */
  readonly costMicros: number
}) => void

export type RunConfig = {
  /** The currency-bound budget for this durable run. */
  readonly budget: Billing.Budget
  /** Resolve only a verified, versioned catalog; legacy model costs are not accepted here. */
  readonly resolveCatalog: CatalogResolver
  readonly estimator?: TokenEstimator
  /** Reconcile usage for a failed request before falling back to an estimate. */
  readonly reconcileUsage?: UsageReconciler
  /** Optional local observer used to attach settled usage to a durable owner. */
  readonly onSettlement?: SettlementObserver
}

export type RunScope = {
  readonly runID: string
  readonly config: RunConfig
  state: Billing.BudgetState
}

export type PreparedCall = {
  readonly runID: string
  readonly reservation: Billing.Reservation
  readonly catalog: Billing.PriceCatalog
  readonly estimatedUsage: Billing.TokenUsage
  readonly estimatedCharge: Billing.Charge
}

export type SettledCall = {
  readonly usage: Billing.TokenUsage
  readonly charge: Billing.Charge
  readonly settlement: Billing.Settlement
}

export class PriceCatalogUnavailable extends Error {
  readonly _tag = "PriceCatalogUnavailable"

  constructor(
    readonly providerID: string,
    readonly modelID: string,
  ) {
    super(`No verified price catalog is configured for ${providerID}/${modelID}`)
    this.name = "PriceCatalogUnavailable"
  }
}

/** An incomplete price is diagnostic information, not permission to spend or settle. */
export class UnpricedUsageError extends Error {
  readonly _tag = "UnpricedUsageError"

  constructor(
    readonly priceCatalogRevision: string,
    readonly categories: ReadonlyArray<Billing.TokenCategory>,
  ) {
    super(`Unpriced token categories: ${categories.join(", ")}`)
    this.name = "UnpricedUsageError"
  }
}

const requireCompletePrice = (charge: Billing.Charge) => {
  if (charge.unpricedCategories.length > 0)
    throw new UnpricedUsageError(charge.priceCatalogRevision, [...charge.unpricedCategories])
}

const count = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/** Normalize provider-inclusive usage into non-overlapping billing dimensions. */
export const fromProviderUsage = (value: LLMUsage): Billing.TokenUsage => {
  const input = count(value.inputTokens)
  const output = count(value.outputTokens)
  const cacheReadInput = count(value.cacheReadInputTokens)
  const cacheWriteInput = count(value.cacheWriteInputTokens)
  const reasoningOutput = count(value.reasoningTokens)
  return Billing.TokenUsage.make({
    source: "provider",
    estimatorID: undefined,
    tokens: {
      unknownInput: Math.max(0, input - cacheReadInput - cacheWriteInput),
      imageInput: 0,
      audioInput: 0,
      cacheReadInput,
      cacheWriteInput,
      textOutput: Math.max(0, output - reasoningOutput),
      reasoningOutput,
      audioOutput: 0,
    },
  })
}

/** Normalize the safe token projection emitted by the Session runner. */
export const fromStepTokens = (value: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}): Billing.TokenUsage =>
  Billing.TokenUsage.make({
    source: "provider",
    estimatorID: undefined,
    tokens: {
      unknownInput: count(value.input),
      imageInput: 0,
      audioInput: 0,
      cacheReadInput: count(value.cache.read),
      cacheWriteInput: count(value.cache.write),
      textOutput: count(value.output),
      reasoningOutput: count(value.reasoning),
      audioOutput: 0,
    },
  })

/** Named deterministic fallback estimator used when a provider omits usage. */
export const CharacterEstimator: TokenEstimator = {
  id: "arforge:chars-per-token-v1",
  estimate: ({ inputText, outputText }) =>
    Billing.TokenBreakdown.make({
      unknownInput: estimateTokens(inputText),
      imageInput: 0,
      audioInput: 0,
      cacheReadInput: 0,
      cacheWriteInput: 0,
      textOutput: estimateTokens(outputText),
      reasoningOutput: 0,
      audioOutput: 0,
    }),
}

export const measureUsage = (input: {
  readonly providerUsage?: LLMUsage
  readonly estimator?: TokenEstimator
  readonly estimateInput?: TextEstimateInput
}): Billing.TokenUsage => {
  if (input.providerUsage !== undefined) return fromProviderUsage(input.providerUsage)
  if (input.estimator === undefined || input.estimateInput === undefined)
    throw new Error("A named estimator and estimate input are required when provider usage is absent")
  return Billing.TokenUsage.make({
    source: "estimated",
    estimatorID: input.estimator.id,
    tokens: input.estimator.estimate(input.estimateInput),
  })
}

/** Estimate input plus a conservative configured output allowance before a provider call. */
export const estimateCallUsage = (input: {
  readonly inputText: string
  readonly outputTokens: number
  readonly estimator?: TokenEstimator
}): Billing.TokenUsage => {
  const estimator = input.estimator ?? CharacterEstimator
  const estimated = estimator.estimate({ inputText: input.inputText, outputText: "" })
  return Billing.TokenUsage.make({
    source: "estimated",
    estimatorID: estimator.id,
    tokens: Billing.TokenBreakdown.make({
      ...estimated,
      textOutput: Math.max(count(estimated.textOutput), count(input.outputTokens)),
    }),
  })
}

const pricedDimensions = [
  ["unknownInput", "unknown-input"],
  ["imageInput", "image-input"],
  ["audioInput", "audio-input"],
  ["cacheReadInput", "cache-read-input"],
  ["cacheWriteInput", "cache-write-input"],
  ["textOutput", "text-output"],
  ["reasoningOutput", "reasoning-output"],
  ["audioOutput", "audio-output"],
] as const

const unitDivisor = (unit: Billing.RateUnit) => {
  switch (unit) {
    case "token":
      return 1
    case "1k-tokens":
      return 1_000
    case "1m-tokens":
      return 1_000_000
  }
}

/** Price an immutable usage snapshot; missing non-zero rates remain explicit. */
export const charge = (usage: Billing.TokenUsage, catalog: Billing.PriceCatalog): Billing.Charge => {
  let amountMinor = 0n
  const unpricedCategories: Billing.TokenCategory[] = []
  const divisor = BigInt(unitDivisor(catalog.unit))
  for (const [field, category] of pricedDimensions) {
    const tokens = usage.tokens[field]
    if (tokens === 0) continue
    const rate = catalog.rates[field]
    if (rate === undefined) {
      unpricedCategories.push(category)
      continue
    }
    // Valid safe-integer inputs can still overflow Number precision during
    // multiplication. Round each dimension exactly before converting back to
    // the existing safe-integer money contract; no bigint enters stored data.
    amountMinor += (BigInt(tokens) * BigInt(rate.amountMinor) + divisor - 1n) / divisor
  }
  return Billing.Charge.make({
    currency: catalog.currency,
    priceCatalogRevision: catalog.revision,
    amountMinor: Number(amountMinor),
    tokens: usage.tokens,
    unpricedCategories,
  })
}

export class BudgetExceeded extends Error {
  readonly _tag = "BudgetExceeded"

  constructor(
    readonly currency: Billing.Currency,
    readonly limitMinor: number,
    readonly projectedMinor: number,
  ) {
    super(`Budget exceeded: ${projectedMinor} ${currency} minor units exceeds ${limitMinor}`)
    this.name = "BudgetExceeded"
  }
}

export class BudgetStateError extends Error {
  readonly _tag = "BudgetStateError"
}

export class ReconciliationPendingError extends Error {
  readonly _tag = "ReconciliationPendingError"
}

export const openBudget = (budget: Billing.Budget): Billing.BudgetState =>
  Billing.BudgetState.make({
    currency: budget.currency,
    limitMinor: budget.limitMinor,
    reservedMinor: 0,
    settledMinor: 0,
    activeReservationIDs: [],
  })

const requireCurrency = (state: Billing.BudgetState, reservation: Billing.Reservation) => {
  if (state.currency !== reservation.currency)
    throw new BudgetStateError(`Currency mismatch: state=${state.currency}, reservation=${reservation.currency}`)
}

/** Reserve a pre-call estimate before any provider request is allowed. */
export const reserve = (state: Billing.BudgetState, reservation: Billing.Reservation): Billing.BudgetState => {
  requireCurrency(state, reservation)
  if (state.activeReservationIDs.includes(reservation.id))
    throw new BudgetStateError(`Reservation already active: ${reservation.id}`)
  const projectedMinor = state.settledMinor + state.reservedMinor + reservation.estimatedMinor
  if (state.limitMinor !== undefined && projectedMinor > state.limitMinor)
    throw new BudgetExceeded(state.currency, state.limitMinor, projectedMinor)
  return Billing.BudgetState.make({
    ...state,
    reservedMinor: state.reservedMinor + reservation.estimatedMinor,
    activeReservationIDs: [...state.activeReservationIDs, reservation.id],
  })
}

/** Settle one reservation and retain an explicit over-budget outcome. */
export const settle = (
  state: Billing.BudgetState,
  reservation: Billing.Reservation,
  actualMinor: number,
): Billing.Settlement => {
  requireCurrency(state, reservation)
  if (!Number.isInteger(actualMinor) || actualMinor < 0) throw new BudgetStateError("actualMinor must be non-negative")
  if (!state.activeReservationIDs.includes(reservation.id))
    throw new BudgetStateError(`Reservation is not active: ${reservation.id}`)
  const nextReservedMinor = state.reservedMinor - reservation.estimatedMinor
  if (nextReservedMinor < 0) throw new BudgetStateError("Reservation exceeds reserved budget")
  const nextSettledMinor = state.settledMinor + actualMinor
  const overBudget = state.limitMinor !== undefined && nextSettledMinor + nextReservedMinor > state.limitMinor
  const nextState = Billing.BudgetState.make({
    ...state,
    reservedMinor: nextReservedMinor,
    settledMinor: nextSettledMinor,
    activeReservationIDs: state.activeReservationIDs.filter((id) => id !== reservation.id),
  })
  return Billing.Settlement.make({
    reservationID: reservation.id,
    actualMinor,
    overBudget,
    state: nextState,
  })
}

type StoredBillingReceipt = {
  readonly id: string
  readonly run_id: string
  readonly provider_id: string
  readonly model_id: string
  readonly settlement_reservation_id: string | null
  readonly billing_receipt: unknown
}

export const makeRunScope = (input: {
  readonly runID: string
  readonly config: RunConfig
  readonly receipts?: ReadonlyArray<StoredBillingReceipt>
}): RunScope => ({
  runID: input.runID,
  config: input.config,
  state: restoreSettledBudget(input.runID, input.config.budget, input.receipts ?? []),
})

/** Reserve a price-catalog-backed estimate before the provider stream is constructed. */
export const prepareCall = (
  scope: RunScope,
  input: {
    readonly reservationID: string
    readonly providerID: string
    readonly modelID: string
    readonly inputText: string
    readonly outputTokens: number
  },
): PreparedCall => {
  const resolved = scope.config.resolveCatalog({ providerID: input.providerID, modelID: input.modelID })
  if (resolved === undefined) throw new PriceCatalogUnavailable(input.providerID, input.modelID)
  // Own the admitted price snapshot; never freeze or later reread the caller's
  // configuration object, which may legitimately reload during the request.
  const catalog = Billing.PriceCatalog.make({
    ...resolved,
    effectiveFrom: DateTime.makeUnsafe(DateTime.toEpochMillis(resolved.effectiveFrom)),
    rates: Object.fromEntries(
      Object.entries(resolved.rates).map(([key, rate]) => [key, rate === undefined ? undefined : { ...rate }]),
    ),
  })
  // Schema construction may clone nested structs. Freeze the constructed
  // snapshot, not only the intermediate inputs supplied to the schema.
  for (const rate of Object.values(catalog.rates)) if (rate !== undefined) Object.freeze(rate)
  Object.freeze(catalog.rates)
  // DateTime is a copied value object with a mutable internal parts cache.
  // Freezing that object breaks its public date-reading functions.
  Object.freeze(catalog)
  if (catalog.currency !== scope.state.currency)
    throw new BudgetStateError(`Currency mismatch: budget=${scope.state.currency}, catalog=${catalog.currency}`)
  const estimatedUsage = estimateCallUsage({
    inputText: input.inputText,
    outputTokens: input.outputTokens,
    estimator: scope.config.estimator,
  })
  const estimatedCharge = charge(estimatedUsage, catalog)
  requireCompletePrice(estimatedCharge)
  const reservation = Billing.Reservation.make({
    id: input.reservationID,
    currency: catalog.currency,
    estimatedMinor: estimatedCharge.amountMinor,
  })
  scope.state = reserve(scope.state, reservation)
  return Object.freeze({
    runID: scope.runID,
    reservation: Object.freeze(reservation),
    catalog,
    estimatedUsage,
    estimatedCharge,
  })
}

/** Settle the matching reservation with provider usage after the stream has ended. */
export const settleCall = (scope: RunScope, prepared: PreparedCall, usage: Billing.TokenUsage): SettledCall => {
  if (prepared.runID !== scope.runID) throw new BudgetStateError("Prepared call belongs to another run")
  const chargeResult = charge(usage, prepared.catalog)
  requireCompletePrice(chargeResult)
  const settlement = settle(scope.state, prepared.reservation, chargeResult.amountMinor)
  scope.state = settlement.state
  return { usage, charge: chargeResult, settlement }
}

/** Versioned recovery material for the existing usage row, without request bodies or credentials. */
export const ReservationReceipt = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literal("reserved"),
  runID: Schema.NonEmptyString,
  providerID: Schema.NonEmptyString,
  modelID: Schema.NonEmptyString,
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  catalog: Billing.PriceCatalog,
  reservation: Billing.Reservation,
  estimatedUsage: Billing.TokenUsage,
  state: Billing.BudgetState,
})

/** Storage ownership is checked by the caller; receipt identity must also match that row. */
export const decodeReservationReceipt = (
  input: unknown,
  binding: {
    readonly runID: string
    readonly reservationID: string
    readonly providerID: string
    readonly modelID: string
  },
) => {
  const receipt = Schema.decodeUnknownSync(ReservationReceipt)(input)
  if (
    receipt.runID !== binding.runID ||
    receipt.reservation.id !== binding.reservationID ||
    receipt.providerID !== binding.providerID ||
    receipt.modelID !== binding.modelID
  )
    throw new BudgetStateError("Pending reservation does not match its storage identity")
  const estimated = charge(receipt.estimatedUsage, receipt.catalog)
  requireCompletePrice(estimated)
  const { state, reservation } = receipt
  if (
    state.currency !== receipt.catalog.currency ||
    reservation.currency !== state.currency ||
    reservation.estimatedMinor !== estimated.amountMinor ||
    state.reservedMinor < estimated.amountMinor ||
    !state.activeReservationIDs.includes(reservation.id) ||
    new Set(state.activeReservationIDs).size !== state.activeReservationIDs.length
  )
    throw new BudgetStateError("Pending reservation does not match its price and budget")
  return receipt
}

export const encodeReservationReceipt = (input: {
  readonly prepared: PreparedCall
  readonly state: Billing.BudgetState
  readonly providerID: string
  readonly modelID: string
  readonly requestDigest: string
}) => {
  const { prepared, state } = input
  const encoded = Schema.encodeSync(ReservationReceipt)({
    version: 1,
    phase: "reserved",
    runID: prepared.runID,
    providerID: input.providerID,
    modelID: input.modelID,
    requestDigest: input.requestDigest,
    catalog: prepared.catalog,
    reservation: prepared.reservation,
    estimatedUsage: prepared.estimatedUsage,
    state,
  })
  decodeReservationReceipt(encoded, {
    runID: prepared.runID,
    reservationID: prepared.reservation.id,
    providerID: input.providerID,
    modelID: input.modelID,
  })
  return encoded
}

/** Reattach one saved reservation after validating the preceding settled history. */
export const resumeReservation = (
  scope: RunScope,
  input: unknown,
  binding: {
    readonly runID: string
    readonly reservationID: string
    readonly providerID: string
    readonly modelID: string
  },
): PreparedCall => {
  const receipt = decodeReservationReceipt(input, binding)
  if (scope.runID !== receipt.runID) throw new BudgetStateError("Pending reservation belongs to another run")
  const expected = reserve(scope.state, receipt.reservation)
  if (
    JSON.stringify(Schema.encodeSync(Billing.BudgetState)(expected)) !==
    JSON.stringify(Schema.encodeSync(Billing.BudgetState)(receipt.state))
  )
    throw new BudgetStateError("Pending reservation is discontinuous with settled billing history")
  scope.state = expected
  return {
    runID: receipt.runID,
    reservation: receipt.reservation,
    catalog: receipt.catalog,
    estimatedUsage: receipt.estimatedUsage,
    estimatedCharge: charge(receipt.estimatedUsage, receipt.catalog),
  }
}

export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  runID: Schema.NonEmptyString,
  providerID: Schema.NonEmptyString,
  modelID: Schema.NonEmptyString,
  requestDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  catalog: Billing.PriceCatalog,
  reservation: Billing.Reservation,
  estimatedUsage: Billing.TokenUsage,
  before: Billing.BudgetState,
  usage: Billing.TokenUsage,
  charge: Billing.Charge,
  settlement: Billing.Settlement,
})

export const decodeReceipt = (input: unknown) => {
  const receipt = Schema.decodeUnknownSync(Receipt)(input)
  const estimated = charge(receipt.estimatedUsage, receipt.catalog)
  const actual = charge(receipt.usage, receipt.catalog)
  requireCompletePrice(estimated)
  requireCompletePrice(actual)
  if (
    receipt.reservation.currency !== receipt.catalog.currency ||
    receipt.reservation.estimatedMinor !== estimated.amountMinor
  )
    throw new BudgetStateError("Receipt reservation does not match its frozen price")
  if (new Set(receipt.before.activeReservationIDs).size !== receipt.before.activeReservationIDs.length)
    throw new BudgetStateError("Receipt has duplicate active reservations")
  if (
    JSON.stringify(Schema.encodeSync(Billing.Charge)(actual)) !==
    JSON.stringify(Schema.encodeSync(Billing.Charge)(receipt.charge))
  )
    throw new BudgetStateError("Receipt charge does not match its frozen price")
  const expected = settle(receipt.before, receipt.reservation, actual.amountMinor)
  if (
    JSON.stringify(Schema.encodeSync(Billing.Settlement)(expected)) !==
    JSON.stringify(Schema.encodeSync(Billing.Settlement)(receipt.settlement))
  )
    throw new BudgetStateError("Receipt budget transition is inconsistent")
  return receipt
}

/** Admission and receipt recovery enforce the same immutable spending policy. */
export const assertRecoveryBudget = (original: Billing.Budget | undefined, current: Billing.Budget | undefined) => {
  if (original && !current) throw new BudgetStateError("Recovered billed run requires its billing policy")
  if (original?.currency !== current?.currency || original?.limitMinor !== current?.limitMinor)
    throw new BudgetStateError("Recovered run budget policy changed; resume with its original billing budget")
}

/** Replay the sequential Runner's persisted transitions, not wall-clock ordering or a summed statistic. */
const restoreSettledBudget = (runID: string, budget: Billing.Budget, rows: ReadonlyArray<StoredBillingReceipt>) => {
  const seen = new Set<string>()
  const receipts = rows
    .map((row) => {
      if (row.run_id !== runID || seen.has(row.id))
        throw new BudgetStateError("Billing history has a foreign run or duplicate reservation")
      seen.add(row.id)
      if (row.settlement_reservation_id === null)
        throw new BudgetStateError("Unsettled billing reservation requires reconciliation before budget recovery")
      const receipt = decodeReceipt(row.billing_receipt)
      if (
        receipt.runID !== runID ||
        receipt.reservation.id !== row.id ||
        row.settlement_reservation_id !== row.id ||
        receipt.providerID !== row.provider_id ||
        receipt.modelID !== row.model_id
      )
        throw new BudgetStateError("Billing history does not match its storage identity")
      return receipt
    })
    .sort((a, b) => a.before.settledMinor - b.before.settledMinor || a.charge.amountMinor - b.charge.amountMinor)
  let state = openBudget(budget)
  let minorUnit: number | undefined
  for (const receipt of receipts) {
    assertRecoveryBudget(receipt.before, budget)
    if (minorUnit !== undefined && minorUnit !== receipt.catalog.minorUnit)
      throw new BudgetStateError("Billing history changes currency precision")
    minorUnit = receipt.catalog.minorUnit
    const expected = reserve(state, receipt.reservation)
    if (
      JSON.stringify(Schema.encodeSync(Billing.BudgetState)(expected)) !==
      JSON.stringify(Schema.encodeSync(Billing.BudgetState)(receipt.before))
    )
      throw new BudgetStateError("Billing history is discontinuous or its budget policy changed")
    state = receipt.settlement.state
  }
  return state
}

export const encodeReceipt = (input: {
  readonly prepared: PreparedCall
  readonly before: Billing.BudgetState
  readonly settled: SettledCall
  readonly providerID: string
  readonly modelID: string
  readonly requestDigest: string
}) => {
  const encoded = Schema.encodeSync(Receipt)({
    version: 1,
    runID: input.prepared.runID,
    providerID: input.providerID,
    modelID: input.modelID,
    requestDigest: input.requestDigest,
    catalog: input.prepared.catalog,
    reservation: input.prepared.reservation,
    estimatedUsage: input.prepared.estimatedUsage,
    before: input.before,
    ...input.settled,
  })
  decodeReceipt(encoded)
  return encoded
}

export const RuntimeBilling = {
  CharacterEstimator,
  charge,
  estimateCallUsage,
  fromStepTokens,
  fromProviderUsage,
  makeRunScope,
  measureUsage,
  openBudget,
  prepareCall,
  reserve,
  settle,
  settleCall,
} as const
