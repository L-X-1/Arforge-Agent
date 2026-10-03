import { describe, expect, test } from "bun:test"
import { Effect, Ref } from "effect"
import { Probe } from "@arforge-ai/llm"
import { ModelProbe, type Input } from "../src/model-probe"

const makeAdapter = (calls: Ref.Ref<number>): Input["adapter"] => ({
  id: "fixture-adapter-v1",
  execute: () =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (count) => count + 1)
      return new Probe.AdapterResult({ outcome: "supported", latencyMs: 2 })
    }),
})

describe("ModelProbe", () => {
  test("maps offline probe observations into the Model.Profile observation contract", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const result = await Effect.runPromise(
      ModelProbe.run({
        providerID: "openai",
        modelID: "fixture-model",
        adapter: makeAdapter(calls),
        policy: ModelProbe.Policy.offline("recorded"),
        cases: [Probe.ProbeCase.fixed("text-generation")],
      }),
    )

    expect(await Effect.runPromise(Ref.get(calls))).toBe(1)
    expect(result.source).toBe("recorded")
    expect(result.observations[0]).toMatchObject({
      kind: "capability",
      status: "pass",
      source: "recorded",
      value: { capability: "text-generation", outcome: "supported", latencyMs: 2 },
    })
  })

  test("denies live probes before invoking the adapter", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const error = await Effect.runPromise(
      ModelProbe.run({
        providerID: "openai",
        modelID: "live-model",
        adapter: makeAdapter(calls),
        policy: new ModelProbe.Policy({
          source: "live",
          liveAuthorized: false,
          providerAllowlist: ["openai"],
          modelAllowlist: ["live-model"],
        }),
      }).pipe(Effect.flip),
    )

    expect(error).toMatchObject({ _tag: "ModelProbe.PolicyDenied", code: "live-not-authorized" })
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0)
  })

  test("requires explicit live budget and provider/model allowlists", async () => {
    const calls = await Effect.runPromise(Ref.make(0))
    const base = {
      providerID: "openai",
      modelID: "live-model",
      adapter: makeAdapter(calls),
    }

    const missingBudget = await Effect.runPromise(
      ModelProbe.run({
        ...base,
        policy: new ModelProbe.Policy({
          source: "live",
          liveAuthorized: true,
          providerAllowlist: ["openai"],
          modelAllowlist: ["live-model"],
        }),
      }).pipe(Effect.flip),
    )
    expect(missingBudget).toMatchObject({ code: "live-budget-missing" })

    const missingCurrency = await Effect.runPromise(
      ModelProbe.run({
        ...base,
        policy: new ModelProbe.Policy({
          source: "live",
          liveAuthorized: true,
          providerAllowlist: ["openai"],
          modelAllowlist: ["live-model"],
          budgetMinor: 1,
        }),
      }).pipe(Effect.flip),
    )
    expect(missingCurrency).toMatchObject({ code: "live-budget-currency-missing" })

    const wrongProvider = await Effect.runPromise(
      ModelProbe.run({
        ...base,
        policy: new ModelProbe.Policy({
          source: "live",
          liveAuthorized: true,
          providerAllowlist: ["anthropic"],
          modelAllowlist: ["live-model"],
          budgetCents: 1,
        }),
      }).pipe(Effect.flip),
    )
    expect(wrongProvider).toMatchObject({ code: "provider-not-allowlisted" })
    expect(await Effect.runPromise(Ref.get(calls))).toBe(0)
  })
})
