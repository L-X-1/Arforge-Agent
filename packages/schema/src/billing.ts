export * as Billing from "./billing"

import { Schema } from "effect"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"

/** Provider-neutral token and price contracts used by runtime metering. */
export const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)).annotate({
  identifier: "Billing.Currency",
})
export type Currency = typeof Currency.Type

export const TokenCategory = Schema.Literals([
  "unknown-input",
  "image-input",
  "audio-input",
  "cache-read-input",
  "cache-write-input",
  "text-output",
  "reasoning-output",
  "audio-output",
])
export type TokenCategory = typeof TokenCategory.Type

/** Non-overlapping billing dimensions; aggregate provider usage is normalized into these fields. */
export const TokenBreakdown = Schema.Struct({
  unknownInput: NonNegativeInt,
  imageInput: NonNegativeInt,
  audioInput: NonNegativeInt,
  cacheReadInput: NonNegativeInt,
  cacheWriteInput: NonNegativeInt,
  textOutput: NonNegativeInt,
  reasoningOutput: NonNegativeInt,
  audioOutput: NonNegativeInt,
}).annotate({ identifier: "Billing.TokenBreakdown" })
export interface TokenBreakdown extends Schema.Schema.Type<typeof TokenBreakdown> {}

export const UsageSource = Schema.Literals(["provider", "estimated"])
export type UsageSource = typeof UsageSource.Type

export const TokenUsage = Schema.Struct({
  source: UsageSource,
  estimatorID: optional(Schema.NonEmptyString),
  tokens: TokenBreakdown,
}).annotate({ identifier: "Billing.TokenUsage" })
export interface TokenUsage extends Schema.Schema.Type<typeof TokenUsage> {}

export const RateUnit = Schema.Literals(["token", "1k-tokens", "1m-tokens"])
export type RateUnit = typeof RateUnit.Type

export const PriceRate = Schema.Struct({
  amountMinor: NonNegativeInt,
}).annotate({ identifier: "Billing.PriceRate" })
export interface PriceRate extends Schema.Schema.Type<typeof PriceRate> {}

export const PriceRates = Schema.Struct({
  unknownInput: optional(PriceRate),
  imageInput: optional(PriceRate),
  audioInput: optional(PriceRate),
  cacheReadInput: optional(PriceRate),
  cacheWriteInput: optional(PriceRate),
  textOutput: optional(PriceRate),
  reasoningOutput: optional(PriceRate),
  audioOutput: optional(PriceRate),
}).annotate({ identifier: "Billing.PriceRates" })
export interface PriceRates extends Schema.Schema.Type<typeof PriceRates> {}

export const PriceCatalog = Schema.Struct({
  revision: Schema.NonEmptyString,
  currency: Currency,
  minorUnit: NonNegativeInt.check(Schema.isLessThanOrEqualTo(6)),
  unit: RateUnit,
  effectiveFrom: DateTimeUtcFromMillis,
  source: Schema.NonEmptyString,
  rates: PriceRates,
}).annotate({ identifier: "Billing.PriceCatalog" })
export interface PriceCatalog extends Schema.Schema.Type<typeof PriceCatalog> {}

export const Charge = Schema.Struct({
  currency: Currency,
  priceCatalogRevision: Schema.NonEmptyString,
  amountMinor: NonNegativeInt,
  tokens: TokenBreakdown,
  unpricedCategories: Schema.Array(TokenCategory),
}).annotate({ identifier: "Billing.Charge" })
export interface Charge extends Schema.Schema.Type<typeof Charge> {}

export const Budget = Schema.Struct({
  currency: Currency,
  limitMinor: optional(NonNegativeInt),
}).annotate({ identifier: "Billing.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const BudgetState = Schema.Struct({
  currency: Currency,
  limitMinor: optional(NonNegativeInt),
  reservedMinor: NonNegativeInt,
  settledMinor: NonNegativeInt,
  activeReservationIDs: Schema.Array(Schema.NonEmptyString),
}).annotate({ identifier: "Billing.BudgetState" })
export interface BudgetState extends Schema.Schema.Type<typeof BudgetState> {}

export const Reservation = Schema.Struct({
  id: Schema.NonEmptyString,
  currency: Currency,
  estimatedMinor: NonNegativeInt,
}).annotate({ identifier: "Billing.Reservation" })
export interface Reservation extends Schema.Schema.Type<typeof Reservation> {}

export const Settlement = Schema.Struct({
  reservationID: Schema.NonEmptyString,
  actualMinor: NonNegativeInt,
  overBudget: Schema.Boolean,
  state: BudgetState,
}).annotate({ identifier: "Billing.Settlement" })
export interface Settlement extends Schema.Schema.Type<typeof Settlement> {}
