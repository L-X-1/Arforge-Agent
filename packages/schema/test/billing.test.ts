import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Billing } from "../src/billing"

const catalog = Billing.PriceCatalog.make({
  revision: "prices-v1",
  currency: "USD",
  minorUnit: 2,
  unit: "1m-tokens",
  effectiveFrom: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
  source: "fixture:billing-v1",
  rates: {
    unknownInput: { amountMinor: 100 },
    textOutput: { amountMinor: 200 },
  },
})

describe("Billing", () => {
  test("round-trips a versioned price catalog and omits absent rates", () => {
    const encoded = Schema.encodeSync(Billing.PriceCatalog)(catalog)
    const decoded = Schema.decodeUnknownSync(Billing.PriceCatalog)(encoded)

    expect(decoded).toEqual(catalog)
    expect(encoded.effectiveFrom).toBe(DateTime.toEpochMillis(catalog.effectiveFrom))
    expect(encoded.rates).toEqual({ unknownInput: { amountMinor: 100 }, textOutput: { amountMinor: 200 } })
  })

  test("rejects non-ISO currency codes and excessive minor-unit precision", () => {
    const encoded = Schema.encodeSync(Billing.PriceCatalog)(catalog)

    expect(() => Schema.decodeUnknownSync(Billing.PriceCatalog)({ ...encoded, currency: "dollars" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Billing.PriceCatalog)({ ...encoded, minorUnit: 7 })).toThrow()
  })
})
