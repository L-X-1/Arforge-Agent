import { describe, expect, test } from "bun:test"
import * as Evaluation from "@arforge-ai/core/memory-evaluation"
import { MemoryEvaluation } from "@arforge-ai/schema"

const observation = (overrides: Partial<Evaluation.Observation> = {}): Evaluation.Observation => ({
  dataset: { id: "beir-scifact", revision: "test-md5-5f7d1de6", source: "external", queryIDs: ["q1", "q2"] },
  topK: 3,
  queries: [
    { queryID: "q1", relevantIDs: ["a", "b"], retrievedIDs: ["x", "a", "z"], latencyMs: 10 },
    { queryID: "q2", relevantIDs: ["c"], retrievedIDs: ["c", "y"], latencyMs: 20 },
  ],
  ...overrides,
})

describe("Memory Step 5.10 evaluation", () => {
  test("measures recall, MRR, false recall, and latency from external query cases", () => {
    const snapshot = Evaluation.evaluate(observation())
    expect(snapshot.metrics.recallAtK.value).toBeCloseTo(2 / 3)
    expect(snapshot.metrics.meanReciprocalRank.value).toBeCloseTo((0.5 + 1) / 2)
    expect(snapshot.metrics.falseRecallRate.value).toBeCloseTo(3 / 5)
    expect(snapshot.metrics.latencyMs.value).toBe(15)
    expect(snapshot.metrics.crossScopeLeakRate.status).toBe("not_measured")
  })

  test("measures lifecycle, contamination, deletion, forget, token, cost, and task annotations when supplied", () => {
    const snapshot = Evaluation.evaluate(
      observation({
        topK: 10,
        queries: [
          {
            queryID: "q1",
            relevantIDs: ["a"],
            retrievedIDs: ["a", "stale", "deleted", "forgotten", "scope", "inject"],
            scopeLeakIDs: ["scope"],
            staleIDs: ["stale"],
            conflictingIDs: [],
            deletedIDs: ["deleted"],
            forgottenIDs: ["forgotten"],
            contaminatedIDs: ["inject"],
            inputTokens: 100,
            costMinor: 2,
            downstreamTaskDelta: 0.1,
          },
        ],
      }),
    )
    expect(snapshot.metrics.crossScopeLeakRate.value).toBeCloseTo(1 / 6)
    expect(snapshot.metrics.staleRecallRate.value).toBeCloseTo(1 / 6)
    expect(snapshot.metrics.deletionPropagationRate.value).toBe(0)
    expect(snapshot.metrics.forgetPropagationRate.value).toBe(0)
    expect(snapshot.metrics.promptInjectionContaminationRate.value).toBeCloseTo(1 / 6)
    expect(snapshot.metrics.inputTokens.value).toBe(100)
    expect(snapshot.metrics.costMinor.value).toBe(2)
    expect(snapshot.metrics.downstreamTaskDelta.value).toBe(0.1)
  })

  test("does not invent thresholds or promote when explicit thresholds reject", () => {
    const baseline = observation()
    expect(Evaluation.compare(baseline).promotion).toBe("not-evaluated")
    expect(Evaluation.compare(baseline, baseline, { minRecallAtK: 1 }).promotion).toBe("rejected")
    expect(Evaluation.compare(baseline, baseline, { minRecallAtK: 0.5 }).promotion).toBe("promoted")
    expect(Evaluation.compare(baseline, baseline, { maxCostIncreaseMinor: 0 }).promotion).toBe("rejected")
  })

  test("keeps dataset provenance explicit", () => {
    const snapshot = Evaluation.evaluate(observation())
    expect(snapshot.dataset).toMatchObject({ id: "beir-scifact", source: "external" })
    expect(MemoryEvaluation.MetricStatus.literals).toEqual(["measured", "not_measured"])
  })
})
