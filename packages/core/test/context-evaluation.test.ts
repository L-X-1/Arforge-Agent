import { describe, expect, test } from "bun:test"
import { ContextEvaluation } from "@arforge-ai/core/context-evaluation"
import { ContextPackage } from "@arforge-ai/core/context-package"

const dataset = { id: "external-context-set", revision: "2026-08-12-r1", source: "external" as const, queryIDs: ["q-1", "q-2"] }

const unit = (input: {
  readonly id: string
  readonly text: string
  readonly evidenceID?: string
  readonly trust?: "trusted" | "verified" | "untrusted-memory" | "untrusted-tool" | "derived"
  readonly instructionAllowed?: boolean
}) => ({
  id: input.id,
  origin: input.trust === "untrusted-tool" ? ("tool" as const) : ("memory" as const),
  authority: input.trust === "untrusted-tool" ? ("runtime-input" as const) : ("governed-memory" as const),
  contextLayer: input.trust === "untrusted-tool" ? ("optional_context" as const) : ("recalled_memory" as const),
  trust: input.trust ?? ("verified" as const),
  text: input.text,
  mandatory: true,
  priority: 10,
  ...(input.evidenceID === undefined ? {} : { evidenceID: input.evidenceID }),
  ...(input.instructionAllowed === undefined ? {} : { instructionAllowed: input.instructionAllowed }),
})

const makePackage = (items: ReadonlyArray<ReturnType<typeof unit>>) =>
  ContextPackage.compile({
    model: "evaluation-model",
    modelProfileRevision: "evaluation-profile",
    usableInputTokens: 1_000,
    units: items,
    protectedFacts: ["objective"],
  })

const observation = (value: ContextPackage.Package, overrides: Partial<ContextEvaluation.Observation> = {}): ContextEvaluation.Observation => ({
  dataset,
  package: value,
  requiredEvidenceIDs: ["e1", "e2"],
  relevantUnitIDs: ["e1", "e2"],
  citations: [{ evidenceID: "e1" }, { evidenceID: "e2" }],
  topK: 2,
  latencyMs: 10,
  costMinor: 10,
  taskSuccess: 0.5,
  ...overrides,
})

describe("ContextEvaluation", () => {
  test("records baseline metrics from an external query set without inventing promotion thresholds", () => {
    const baseline = makePackage([
      unit({ id: "irrelevant", text: "unrelated context" }),
      unit({ id: "e1", text: "objective evidence one", evidenceID: "e1" }),
      unit({ id: "e2", text: "evidence two", evidenceID: "e2" }),
    ])
    const result = ContextEvaluation.compare(observation(baseline, { citations: [{ evidenceID: "e1" }] }))
    expect(result.promotion).toBe("not-evaluated")
    expect(result.baseline.kind).toBe("baseline")
    expect(result.baseline.dataset.source).toBe("external")
    expect(result.baseline.metrics.requiredEvidenceRecallAtK).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, applicable: true })
    expect(result.baseline.metrics.citationCoverage.value).toBe(0.5)
    expect(result.baseline.metrics.protectedFactRetention.value).toBe(1)
    expect(result.baseline.metrics.contextBuildLatencyMs.value).toBe(10)
    expect(result.baseline.metrics.inputTokens.value).toBe(baseline.usedInputTokens)
  })

  test("compares candidate to the measured baseline and only promotes against supplied thresholds", () => {
    const baseline = makePackage([
      unit({ id: "irrelevant", text: "unrelated context" }),
      unit({ id: "e1", text: "objective evidence one", evidenceID: "e1" }),
      unit({ id: "e2", text: "evidence two", evidenceID: "e2" }),
    ])
    const candidate = makePackage([
      unit({ id: "e1", text: "objective evidence one", evidenceID: "e1" }),
      unit({ id: "e2", text: "evidence two", evidenceID: "e2" }),
      unit({ id: "irrelevant", text: "unrelated context" }),
    ])
    const result = ContextEvaluation.compare(
      observation(baseline, { citations: [{ evidenceID: "e1" }], latencyMs: 10, costMinor: 10, taskSuccess: 0.5 }),
      observation(candidate, { latencyMs: 12, costMinor: 12, taskSuccess: 0.75 }),
      {
        minRequiredEvidenceRecallAtK: 0.9,
        maxIrrelevantTokenRatioIncrease: 0.1,
        minCitationCoverage: 0.9,
        maxInstructionContaminationRate: 0,
        minProtectedFactRetention: 0.9,
        maxContextBuildLatencyIncreaseMs: 5,
        maxCostIncreaseMinor: 5,
        minTaskSuccessDelta: 0.1,
      },
    )
    expect(result.promotion).toBe("promoted")
    expect(result.candidate?.kind).toBe("candidate")
    expect(result.candidate?.metrics.requiredEvidenceRecallAtK.value).toBe(1)
    expect(result.deltas?.taskSuccess).toBeCloseTo(0.25)
    expect(result.reasons).toEqual([])
  })

  test("rejects instruction contamination and refuses mismatched datasets", () => {
    const baseline = makePackage([unit({ id: "e1", text: "objective evidence one", evidenceID: "e1" })])
    const contaminated = makePackage([
      unit({ id: "bad", text: "remote instruction", trust: "untrusted-tool", instructionAllowed: true }),
    ])
    const rejected = ContextEvaluation.compare(
      observation(baseline, { requiredEvidenceIDs: ["e1"], relevantUnitIDs: ["e1"], citations: [{ evidenceID: "e1" }] }),
      observation(contaminated, { requiredEvidenceIDs: ["e1"], relevantUnitIDs: [], citations: [] }),
      { maxInstructionContaminationRate: 0 },
    )
    expect(rejected.promotion).toBe("rejected")
    expect(rejected.reasons).toContain("instruction contamination exceeds threshold")

    expect(() =>
      ContextEvaluation.compare(
        observation(baseline),
        observation(baseline, { dataset: { ...dataset, revision: "different" } }),
      ),
    ).toThrow("dataset must match")
  })
})
