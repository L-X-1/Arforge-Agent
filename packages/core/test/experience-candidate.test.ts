import { describe, expect, it } from "bun:test"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  ExperienceCandidateError,
  addSupport,
  createExperienceCandidate,
  isPromotionEligible,
} from "@arforge-ai/core/experience-candidate"

const experience = (suffix: string, reusable = true): AgentRuntime.ExperienceRecord =>
  AgentRuntime.ExperienceRecord.make({
    id: AgentRuntime.ExperienceID.make(`exp_${suffix}`),
    runID: AgentRuntime.RunID.make(`run_${suffix}`),
    outcome: "success",
    summary: `Verified release ${suffix}`,
    evidenceIDs: [AgentRuntime.EvidenceID.make(`evd_${suffix}`)],
    reusable,
    createdAt: DateTime.makeUnsafe(1_725_000_000_000),
  })

const candidateInput = {
  problemSignature: "release verification",
  applicableScope: "workspace release workflow",
  conditions: ["all checks are green"],
  attemptedStrategy: "run the verified release checklist",
  evidenceIDs: [AgentRuntime.EvidenceID.make("evd_initial")],
  policyVersion: "experience-policy-v1",
  verifiedOutcome: experience("initial"),
}

describe("ExperienceCandidate", () => {
  it("keeps a single verified success below the promotion threshold", () => {
    const candidate = createExperienceCandidate(candidateInput)

    expect(candidate.status).toBe("candidate")
    expect(candidate.reviewStatus).toBe("pending")
    expect(candidate.supportCount).toBe(1)
    expect(candidate.confidence).toBe(0.2)
    expect(isPromotionEligible(candidate)).toBe(false)
  })

  it("promotes only after independent run support and keeps a stable digest", () => {
    const first = createExperienceCandidate(candidateInput)
    const second = addSupport(first, {
      experience: experience("second"),
      evidenceIDs: [AgentRuntime.EvidenceID.make("evd_second")],
    })
    const third = addSupport(second, {
      experience: experience("third"),
      evidenceIDs: [AgentRuntime.EvidenceID.make("evd_third")],
    })

    expect(third.supportCount).toBe(3)
    expect(third.confidence).toBe(0.6)
    expect(third.sourceRunIDs.map(String)).toEqual(["run_initial", "run_second", "run_third"])
    expect(third.evidenceIDs.map(String)).toEqual(["evd_initial", "evd_second", "evd_third"])
    expect(third.digest).not.toBe(first.digest)
    expect(isPromotionEligible(third)).toBe(true)
  })

  it("keeps counterexamples below the threshold even with three supports", () => {
    const first = createExperienceCandidate({ ...candidateInput, counterexamples: ["verified failure"] })
    const second = addSupport(first, { experience: experience("counter-second"), evidenceIDs: [] })
    const third = addSupport(second, { experience: experience("counter-third"), evidenceIDs: [] })

    expect(third.supportCount).toBe(3)
    expect(third.confidence).toBe(0.45)
    expect(isPromotionEligible(third)).toBe(false)
  })

  it("rejects duplicate source runs and non-reusable experiences", () => {
    const first = createExperienceCandidate(candidateInput)
    expect(() => addSupport(first, { experience: experience("initial"), evidenceIDs: [] })).toThrow(
      ExperienceCandidateError,
    )
    expect(() =>
      createExperienceCandidate({ ...candidateInput, verifiedOutcome: experience("failed", false) }),
    ).toThrow(/reusable verified experiences/)
  })

  it("redacts bounded candidate fields before hashing and storage", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const candidate = createExperienceCandidate({
      ...candidateInput,
      problemSignature: `token=${secret}`,
      attemptedStrategy: `authorization: Bearer ${secret}`,
      conditions: [`password=${secret}`],
      counterexamples: [`api_key=${secret}`],
    })

    expect(candidate.problemSignature).not.toContain(secret)
    expect(candidate.attemptedStrategy).not.toContain(secret)
    expect(candidate.conditions[0]).toContain("[REDACTED_SECRET]")
    expect(candidate.counterexamples[0]).toContain("[REDACTED_SECRET]")
  })
})
