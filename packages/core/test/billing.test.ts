import { describe, expect, test } from "bun:test"
import { Usage } from "@arforge-ai/llm"
import { Billing } from "@arforge-ai/schema/billing"
import { DateTime } from "effect"
import {
  BudgetExceeded,
  BudgetStateError,
  CharacterEstimator,
  RuntimeBilling,
  fromProviderUsage,
  measureUsage,
  openBudget,
  reserve,
  settle,
  encodeReceipt,
  decodeReceipt,
  encodeReservationReceipt,
  decodeReservationReceipt,
  resumeReservation,
} from "../src/runtime/billing"

const catalog = Billing.PriceCatalog.make({
  revision: "prices-v1",
  currency: "USD",
  minorUnit: 2,
  unit: "1k-tokens",
  effectiveFrom: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
  source: "fixture:billing-v1",
  rates: {
    unknownInput: { amountMinor: 1000 },
    cacheReadInput: { amountMinor: 500 },
    cacheWriteInput: { amountMinor: 700 },
    textOutput: { amountMinor: 1500 },
    reasoningOutput: { amountMinor: 2000 },
  },
})

describe("RuntimeBilling", () => {
  test("run scope rebuilds a continuous settled budget without resetting spending", () => {
    const config = { budget: { currency: "USD" as const, limitMinor: 1000 }, resolveCatalog: () => catalog }
    const scope = RuntimeBilling.makeRunScope({ runID: "restore-run", config })
    const receipts = [0, 4, 6].map((output, index) => {
      const prepared = RuntimeBilling.prepareCall(scope, {
        reservationID: `restore-${index}`,
        providerID: "fixture",
        modelID: "model",
        inputText: "",
        outputTokens: 8,
      })
      const before = scope.state
      const settled = RuntimeBilling.settleCall(
        scope,
        prepared,
        RuntimeBilling.fromStepTokens({ input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } }),
      )
      return {
        id: prepared.reservation.id,
        run_id: scope.runID,
        provider_id: "fixture",
        model_id: "model",
        settlement_reservation_id: prepared.reservation.id,
        billing_receipt: encodeReceipt({
          prepared,
          before,
          settled,
          providerID: "fixture",
          modelID: "model",
          requestDigest: "b".repeat(64),
        }),
      }
    })
    const restored = RuntimeBilling.makeRunScope({ runID: scope.runID, config, receipts: [...receipts].reverse() })
    expect(restored.state).toEqual(scope.state)
    expect(restored.state.settledMinor).toBe(15)
    const pending = RuntimeBilling.prepareCall(scope, {
      reservationID: "restore-pending",
      providerID: "fixture",
      modelID: "model",
      inputText: "pending request",
      outputTokens: 8,
    })
    const binding = {
      runID: scope.runID,
      reservationID: pending.reservation.id,
      providerID: "fixture",
      modelID: "model",
    }
    const pendingReceipt = encodeReservationReceipt({
      prepared: pending,
      state: scope.state,
      providerID: binding.providerID,
      modelID: binding.modelID,
      requestDigest: "c".repeat(64),
    })
    const empty = RuntimeBilling.makeRunScope({ runID: scope.runID, config })
    const emptyBefore = empty.state
    expect(() => resumeReservation(empty, pendingReceipt, binding)).toThrow("discontinuous")
    expect(empty.state).toBe(emptyBefore)
    const restoredBefore = restored.state
    expect(() => resumeReservation(restored, pendingReceipt, { ...binding, modelID: "wrong-model" })).toThrow()
    expect(restored.state).toBe(restoredBefore)
    const resumed = resumeReservation(restored, pendingReceipt, binding)
    expect(restored.state).toEqual(scope.state)
    expect(resumed.catalog.revision).toBe("prices-v1")
    const reservedBefore = restored.state
    expect(() => resumeReservation(restored, pendingReceipt, binding)).toThrow()
    expect(restored.state).toBe(reservedBefore)
    const recoveredSettlement = RuntimeBilling.settleCall(restored, resumed, resumed.estimatedUsage)
    expect(restored.state.settledMinor).toBe(15 + recoveredSettlement.charge.amountMinor)
    expect(restored.state.activeReservationIDs).toEqual([])
    expect(() => RuntimeBilling.makeRunScope({ runID: scope.runID, config, receipts: [receipts[2]] })).toThrow()
    expect(() =>
      RuntimeBilling.makeRunScope({ runID: scope.runID, config, receipts: [...receipts, receipts[0]] }),
    ).toThrow()
    expect(() => RuntimeBilling.makeRunScope({ runID: "wrong-run", config, receipts })).toThrow()
    expect(() =>
      RuntimeBilling.makeRunScope({
        runID: scope.runID,
        config: { ...config, budget: { currency: "USD", limitMinor: 2000 } },
        receipts,
      }),
    ).toThrow()
    expect(() =>
      RuntimeBilling.makeRunScope({
        runID: scope.runID,
        config,
        receipts: [{ ...receipts[0], billing_receipt: null }],
      }),
    ).toThrow()
    expect(() =>
      RuntimeBilling.makeRunScope({
        runID: scope.runID,
        config,
        receipts: [{ ...receipts[0], settlement_reservation_id: "wrong" }],
      }),
    ).toThrow()
  })

  test("pending receipt validates frozen pricing, budget and storage identity before recovery", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "pending-run",
      config: {
        budget: { currency: "USD", limitMinor: 1000 },
        resolveCatalog: () => catalog,
      },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "pending-call",
      providerID: "fixture",
      modelID: "model",
      inputText: "Original request",
      outputTokens: 8,
    })
    const encoded = encodeReservationReceipt({
      prepared,
      state: scope.state,
      providerID: "fixture",
      modelID: "model",
      requestDigest: "a".repeat(64),
    })
    const binding = { runID: "pending-run", reservationID: "pending-call", providerID: "fixture", modelID: "model" }
    const restored = decodeReservationReceipt(JSON.parse(JSON.stringify(encoded)), binding)
    expect(restored.state).toEqual(scope.state)
    expect(DateTime.toEpochMillis(restored.catalog.effectiveFrom)).toBe(DateTime.toEpochMillis(catalog.effectiveFrom))
    for (const key of ["runID", "reservationID", "providerID", "modelID"] as const) {
      expect(() => decodeReservationReceipt(encoded, { ...binding, [key]: "other" })).toThrow(BudgetStateError)
    }
    for (const state of [
      { ...encoded.state, activeReservationIDs: [] },
      { ...encoded.state, activeReservationIDs: ["pending-call", "other", "other"] },
      { ...encoded.state, reservedMinor: 0 },
      { ...encoded.state, currency: "EUR" },
    ])
      expect(() => decodeReservationReceipt({ ...encoded, state }, binding)).toThrow()
    expect(() =>
      decodeReservationReceipt({ ...encoded, catalog: { ...encoded.catalog, rates: {} } }, binding),
    ).toThrow()
    expect(() =>
      decodeReservationReceipt({ ...encoded, reservation: { ...encoded.reservation, estimatedMinor: 999 } }, binding),
    ).toThrow()
    expect(() => decodeReservationReceipt({ ...encoded, version: 2 }, binding)).toThrow()
    expect(() => decodeReservationReceipt({ ...encoded, requestDigest: "invalid" }, binding)).toThrow()
  })

  test("stored receipt preserves original price and validates its budget transition", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "receipt-run",
      config: { budget: { currency: "USD", limitMinor: 1000 }, resolveCatalog: () => catalog },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "receipt-call",
      providerID: "fixture",
      modelID: "model",
      inputText: "Original request",
      outputTokens: 8,
    })
    const before = scope.state
    const settled = RuntimeBilling.settleCall(
      scope,
      prepared,
      RuntimeBilling.fromStepTokens({ input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
    )
    const encoded = encodeReceipt({
      prepared,
      before,
      settled,
      providerID: "fixture",
      modelID: "model",
      requestDigest: "a".repeat(64),
    })
    const restored = decodeReceipt(JSON.parse(JSON.stringify(encoded)))
    expect(restored.catalog.revision).toBe("prices-v1")
    expect(DateTime.toEpochMillis(restored.catalog.effectiveFrom)).toBe(DateTime.toEpochMillis(catalog.effectiveFrom))
    expect(restored.settlement).toEqual(settled.settlement)
    expect(restored.before).toEqual(before)
    expect(() => decodeReceipt({ ...encoded, settlement: { ...encoded.settlement, actualMinor: 999 } })).toThrow()
    expect(() =>
      decodeReceipt({
        ...encoded,
        catalog: { ...encoded.catalog, rates: { ...encoded.catalog.rates, textOutput: { amountMinor: 1 } } },
      }),
    ).toThrow()
    expect(() => decodeReceipt({ ...encoded, version: 2 })).toThrow()
  })

  test("prices safe inputs exactly even when the intermediate product is not a safe number", () => {
    const usage = RuntimeBilling.estimateCallUsage({ inputText: "", outputTokens: Number.MAX_SAFE_INTEGER })
    const priced = RuntimeBilling.charge(
      usage,
      Billing.PriceCatalog.make({
        ...catalog,
        unit: "1m-tokens",
        rates: { textOutput: { amountMinor: 999999 } },
      }),
    )
    expect(priced.amountMinor).toBe(9007190247541737)
  })

  test("exact pricing rejects a budget one minor unit short before reserving", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-exact-price",
      config: {
        budget: Billing.Budget.make({ currency: "USD", limitMinor: 9007190247541736 }),
        resolveCatalog: () =>
          Billing.PriceCatalog.make({
            ...catalog,
            unit: "1m-tokens",
            rates: { textOutput: { amountMinor: 999999 } },
          }),
      },
    })
    const before = scope.state
    expect(() =>
      RuntimeBilling.prepareCall(scope, {
        reservationID: "call-exact-price",
        providerID: "fixture",
        modelID: "model",
        inputText: "",
        outputTokens: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(BudgetExceeded)
    expect(scope.state).toBe(before)
    expect(scope.state.activeReservationIDs).toEqual([])
  })

  test("exact intermediates do not allow charges outside the stored safe-integer range", () => {
    const usage = RuntimeBilling.estimateCallUsage({ inputText: "", outputTokens: Number.MAX_SAFE_INTEGER })
    expect(() =>
      RuntimeBilling.charge(
        usage,
        Billing.PriceCatalog.make({
          ...catalog,
          unit: "token",
          rates: { textOutput: { amountMinor: 2 } },
        }),
      ),
    ).toThrow()
  })

  test("prepared pricing is isolated from later catalog changes", () => {
    const mutable = { ...catalog, rates: { unknownInput: { amountMinor: 1000 }, textOutput: { amountMinor: 1500 } } }
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-price-snapshot",
      config: {
        budget: Billing.Budget.make({ currency: "USD", limitMinor: 100 }),
        resolveCatalog: () => mutable,
      },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "call-price-snapshot",
      providerID: "fixture",
      modelID: "model",
      inputText: "12345678",
      outputTokens: 4,
    })
    mutable.revision = "changed-after-admission"
    mutable.rates.unknownInput.amountMinor = 0
    mutable.rates.textOutput.amountMinor = 0
    const settled = RuntimeBilling.settleCall(scope, prepared, prepared.estimatedUsage)
    expect(settled.charge.amountMinor).toBe(8)
    expect(settled.charge.priceCatalogRevision).toBe("prices-v1")
    expect(prepared.catalog).not.toBe(mutable)
    expect(Object.isFrozen(prepared.catalog)).toBe(true)
    expect(Object.isFrozen(prepared.catalog.rates.unknownInput)).toBe(true)
    expect(Object.isFrozen(mutable)).toBe(false)
    expect(DateTime.toPartsUtc(prepared.catalog.effectiveFrom).year).toBe(2026)
    expect(RuntimeBilling.settleCall.bind(undefined, scope, prepared, prepared.estimatedUsage)).toThrow(
      BudgetStateError,
    )
  })

  test("a prepared call cannot settle another run with the same reservation name", () => {
    const config = { budget: Billing.Budget.make({ currency: "USD", limitMinor: 100 }), resolveCatalog: () => catalog }
    const first = RuntimeBilling.makeRunScope({ runID: "run-first", config })
    const second = RuntimeBilling.makeRunScope({ runID: "run-second", config })
    const input = {
      reservationID: "same-call-name",
      providerID: "fixture",
      modelID: "model",
      inputText: "12345678",
      outputTokens: 4,
    }
    const preparedFirst = RuntimeBilling.prepareCall(first, input)
    const preparedSecond = RuntimeBilling.prepareCall(second, input)
    const before = second.state
    expect(() => RuntimeBilling.settleCall(second, preparedFirst, preparedFirst.estimatedUsage)).toThrow(
      BudgetStateError,
    )
    expect(second.state).toBe(before)
    expect(first.state.activeReservationIDs).toEqual([input.reservationID])
    expect(
      RuntimeBilling.settleCall(second, preparedSecond, preparedSecond.estimatedUsage).settlement.state
        .activeReservationIDs,
    ).toEqual([])
  })

  test("does not reserve an incomplete estimate as if missing rates were free", () => {
    const incomplete = Billing.PriceCatalog.make({ ...catalog, rates: { textOutput: { amountMinor: 0 } } })
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-incomplete",
      config: { budget: Billing.Budget.make({ currency: "USD", limitMinor: 0 }), resolveCatalog: () => incomplete },
    })
    const before = scope.state
    expect(() =>
      RuntimeBilling.prepareCall(scope, {
        reservationID: "reservation-incomplete",
        providerID: "fixture",
        modelID: "model",
        inputText: "12345678",
        outputTokens: 4,
      }),
    ).toThrow("Unpriced token categories")
    expect(scope.state).toBe(before)
    expect(scope.state.activeReservationIDs).toEqual([])
  })

  test("unpriced provider usage keeps its reservation outstanding for reconciliation", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-reconcile",
      config: { budget: Billing.Budget.make({ currency: "USD", limitMinor: 100 }), resolveCatalog: () => catalog },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "reservation-reconcile",
      providerID: "fixture",
      modelID: "model",
      inputText: "12345678",
      outputTokens: 4,
    })
    const before = scope.state
    const usage = Billing.TokenUsage.make({
      source: "provider",
      tokens: { ...prepared.estimatedUsage.tokens, imageInput: 1 },
    })
    expect(() => RuntimeBilling.settleCall(scope, prepared, usage)).toThrow("Unpriced token categories")
    expect(scope.state).toBe(before)
    expect(scope.state.activeReservationIDs).toEqual(["reservation-reconcile"])
    expect(scope.state.settledMinor).toBe(0)
  })

  test("explicit zero rates remain valid while unused missing dimensions need no price", () => {
    const free = Billing.PriceCatalog.make({
      ...catalog,
      rates: { unknownInput: { amountMinor: 0 }, textOutput: { amountMinor: 0 } },
    })
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-free",
      config: { budget: Billing.Budget.make({ currency: "USD", limitMinor: 0 }), resolveCatalog: () => free },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "reservation-free",
      providerID: "fixture",
      modelID: "model",
      inputText: "12345678",
      outputTokens: 4,
    })
    const result = RuntimeBilling.settleCall(scope, prepared, prepared.estimatedUsage)
    expect(result.charge.amountMinor).toBe(0)
    expect(result.charge.unpricedCategories).toEqual([])
    expect(scope.state.activeReservationIDs).toEqual([])
  })

  test("prefers provider usage and normalizes inclusive counts", () => {
    const usage = fromProviderUsage(
      new Usage({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 2,
        reasoningTokens: 5,
      }),
    )

    expect(usage).toEqual({
      source: "provider",
      tokens: {
        unknownInput: 88,
        imageInput: 0,
        audioInput: 0,
        cacheReadInput: 10,
        cacheWriteInput: 2,
        textOutput: 15,
        reasoningOutput: 5,
        audioOutput: 0,
      },
    })
    expect(
      measureUsage({
        providerUsage: new Usage({ inputTokens: 1 }),
        estimator: CharacterEstimator,
        estimateInput: { inputText: "ignored", outputText: "ignored" },
      }).source,
    ).toBe("provider")
  })

  test("uses a named estimator when provider usage is absent and prices missing dimensions explicitly", () => {
    const usage = measureUsage({
      estimator: CharacterEstimator,
      estimateInput: { inputText: "12345678", outputText: "1234" },
    })
    const charge = RuntimeBilling.charge(usage, catalog)

    expect(usage).toMatchObject({ source: "estimated", estimatorID: "arforge:chars-per-token-v1" })
    expect(charge.amountMinor).toBe(4)
    expect(charge.unpricedCategories).toEqual([])

    const unpriced = RuntimeBilling.charge(
      Billing.TokenUsage.make({
        source: "estimated",
        estimatorID: "fixture:with-image",
        tokens: {
          unknownInput: 0,
          imageInput: 1,
          audioInput: 0,
          cacheReadInput: 0,
          cacheWriteInput: 0,
          textOutput: 0,
          reasoningOutput: 0,
          audioOutput: 0,
        },
      }),
      catalog,
    )
    expect(unpriced.unpricedCategories).toEqual(["image-input"])
  })

  test("reserves before a call, settles after it, and flags post-call overrun", () => {
    const state = openBudget(Billing.Budget.make({ currency: "USD", limitMinor: 100 }))
    const reservation = Billing.Reservation.make({ id: "run-1", currency: "USD", estimatedMinor: 60 })
    const reserved = reserve(state, reservation)
    expect(reserved.reservedMinor).toBe(60)

    const settled = settle(reserved, reservation, 110)
    expect(settled.overBudget).toBe(true)
    expect(settled.state).toMatchObject({ reservedMinor: 0, settledMinor: 110, activeReservationIDs: [] })
    expect(() => settle(settled.state, reservation, 1)).toThrow(BudgetStateError)
  })

  test("rejects a reservation that would exceed the pre-call budget", () => {
    const state = openBudget(Billing.Budget.make({ currency: "USD", limitMinor: 10 }))
    const reservation = Billing.Reservation.make({ id: "run-1", currency: "USD", estimatedMinor: 11 })

    expect(() => reserve(state, reservation)).toThrow(BudgetExceeded)
  })

  test("binds a verified catalog and currency budget to a run scope", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-1",
      config: {
        budget: Billing.Budget.make({ currency: "USD", limitMinor: 100 }),
        resolveCatalog: ({ providerID, modelID }) =>
          providerID === "fixture" && modelID === "model" ? catalog : undefined,
      },
    })
    const prepared = RuntimeBilling.prepareCall(scope, {
      reservationID: "reservation-1",
      providerID: "fixture",
      modelID: "model",
      inputText: "12345678",
      outputTokens: 4,
    })

    expect(prepared.reservation.currency).toBe("USD")
    expect(scope.state.activeReservationIDs).toEqual(["reservation-1"])

    const settled = RuntimeBilling.settleCall(
      scope,
      prepared,
      RuntimeBilling.fromStepTokens({ input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }),
    )
    expect(settled.charge.priceCatalogRevision).toBe("prices-v1")
    expect(settled.settlement.state.activeReservationIDs).toEqual([])
    expect(scope.state.settledMinor).toBe(settled.charge.amountMinor)
  })

  test("does not allow a configured run to call without a verified catalog", () => {
    const scope = RuntimeBilling.makeRunScope({
      runID: "run-2",
      config: {
        budget: Billing.Budget.make({ currency: "USD", limitMinor: 100 }),
        resolveCatalog: () => undefined,
      },
    })

    expect(() =>
      RuntimeBilling.prepareCall(scope, {
        reservationID: "reservation-2",
        providerID: "missing",
        modelID: "model",
        inputText: "request",
        outputTokens: 1,
      }),
    ).toThrow("No verified price catalog")
    expect(scope.state.activeReservationIDs).toEqual([])
  })
})
