import { describe, expect, test } from "bun:test"
import { ExperienceEvaluationV2 } from "@arforge-ai/core/experience-evaluation"

const dataset = {
  id: "release-replay",
  revision: "2026-08-12-r1",
  source: "recorded" as const,
  caseIDs: ["case-a", "case-b", "case-c"],
}

const replay = (
  variant: ExperienceEvaluationV2.ExperienceVariant,
  overrides: Partial<ExperienceEvaluationV2.ReplayCase> = {},
): ExperienceEvaluationV2.ReplayObservation => ({
  dataset,
  variant,
  ...(variant === "without_experience" ? {} : { experienceDigest: "a".repeat(64) }),
  cases: dataset.caseIDs.map((caseID, index) => ({
    caseID,
    success: index !== 2,
    steps: 4 + index,
    tokens: 100 + index * 10,
    costMinor: 10 + index,
    newFailures: index === 2 ? 1 : 0,
    ...overrides,
  })),
})

describe("ExperienceEvaluation", () => {
  test("compares without, candidate, and active experience replays", () => {
    const result = ExperienceEvaluationV2.compare([
      replay("without_experience"),
      replay("candidate_experience", { success: true, steps: 3, tokens: 80, costMinor: 8, newFailures: 0 }),
      replay("active_experience", { success: true, steps: 4, tokens: 90, costMinor: 9, newFailures: 0 }),
    ])

    expect(result.interpretation).toBe("observational_correlation_only")
    expect(result.candidateExperience.metrics.successRate.value).toBe(1)
    expect(result.candidateVsWithout.successRate).toBeCloseTo(1 / 3)
    expect(result.candidateVsWithout.averageSteps).toBe(-2)
    expect(result.activeVsWithout.newFailureRate).toBeCloseTo(-1 / 3)
    expect(result.note).toContain("not randomized causal proof")
  })

  test("requires complete matched datasets and immutable experience digests", () => {
    expect(() =>
      ExperienceEvaluationV2.compare([replay("without_experience"), replay("candidate_experience")]),
    ).toThrow("exactly three")
    expect(() =>
      ExperienceEvaluationV2.evaluate({ ...replay("candidate_experience"), experienceDigest: "not-a-digest" }),
    ).toThrow("64-character immutable digest")
    expect(() =>
      ExperienceEvaluationV2.compare([
        replay("without_experience"),
        replay("candidate_experience", { caseID: "unknown" }),
        replay("active_experience"),
      ]),
    ).toThrow("missing, unknown, or duplicated")
    expect(() =>
      ExperienceEvaluationV2.compare([
        replay("without_experience"),
        { ...replay("candidate_experience"), dataset: { ...dataset, revision: "other" } },
        replay("active_experience"),
      ]),
    ).toThrow("same dataset")
  })

  test("fails closed on negative replay measurements", () => {
    expect(() =>
      ExperienceEvaluationV2.evaluate({
        ...replay("without_experience"),
        cases: replay("without_experience").cases.map((item, index) => (index === 0 ? { ...item, tokens: -1 } : item)),
      }),
    ).toThrow("tokens must be finite and non-negative")
  })
})
