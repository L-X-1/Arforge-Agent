import { describe, expect, test } from "bun:test"
import {
  buildSkillEvaluationPayload,
  createSkillEvaluationDrafts,
  skillEvaluationField,
  type SkillEvaluationObservationDraft,
} from "./skill-evaluation-form"

const complete = (caseID: string, evidenceIDs = ["evd_verified"]): SkillEvaluationObservationDraft => ({
  caseID,
  baseline: { result: "failed", steps: "3", tokens: "30", costMinor: "2" },
  candidate: { result: "passed", steps: "2", tokens: "20", costMinor: "1" },
  newFailures: "0",
  newSecretFindings: "0",
  newEgressAttempts: "0",
  evidenceIDs,
  safetyConfirmed: true,
})

describe("Skill evaluation form", () => {
  test("starts empty so a user cannot accidentally attest that tests passed", () => {
    const drafts = createSkillEvaluationDrafts(["case-a"])
    const result = buildSkillEvaluationPayload({
      drafts,
      expectedTestIDs: ["case-a"],
      allowedEvidenceIDs: ["evd_verified"],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("empty evaluation unexpectedly passed")
    expect(result.errors[skillEvaluationField(0, "baseline-result")]).toBe("result-required")
    expect(result.errors[skillEvaluationField(0, "candidate-result")]).toBe("result-required")
    expect(result.errors[skillEvaluationField(0, "evidence")]).toBe("evidence-required")
    expect(result.errors[skillEvaluationField(0, "safety-confirmed")]).toBe("safety-confirmation-required")
  })

  test("builds bounded observations for every deterministic test", () => {
    const result = buildSkillEvaluationPayload({
      drafts: [complete("case-b", ["evd_b", "evd_b"]), complete("case-a", ["evd_a"])],
      expectedTestIDs: ["case-a", "case-b"],
      allowedEvidenceIDs: ["evd_a", "evd_b"],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("complete evaluation did not pass")
    expect(result.observations).toHaveLength(2)
    expect(result.observations[0]?.baseline.success).toBe(false)
    expect(result.observations[0]?.candidate.success).toBe(true)
    expect(result.observations[0]?.evidenceIDs).toEqual(["evd_b"])
    expect(result.observations[1]?.candidate.newSecretFindings).toBe(0)
  })

  test("rejects case drift, untrusted evidence, negative metrics, and an unconfirmed safety review", () => {
    const draft = {
      ...complete("case-other", ["evd_untrusted"]),
      candidate: { ...complete("case-other").candidate, tokens: "-1" },
      safetyConfirmed: false,
    }
    const result = buildSkillEvaluationPayload({
      drafts: [draft],
      expectedTestIDs: ["case-a"],
      allowedEvidenceIDs: ["evd_verified"],
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("invalid evaluation unexpectedly passed")
    expect(result.errors.form).toBe("case-set-mismatch")
    expect(result.errors[skillEvaluationField(0, "candidate-tokens")]).toBe("number-required")
    expect(result.errors[skillEvaluationField(0, "evidence")]).toBe("evidence-invalid")
    expect(result.errors[skillEvaluationField(0, "safety-confirmed")]).toBe("safety-confirmation-required")
  })
})
