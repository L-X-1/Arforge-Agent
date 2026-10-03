import { describe, expect, test } from "bun:test"
import { buildSkillCandidatePayload, defaultSkillCandidateDraft, splitSkillCandidateList } from "./skill-candidate-form"

describe("Skill candidate creation form", () => {
  test("normalizes readable lists and builds a bounded candidate request", () => {
    const result = buildSkillCandidatePayload(
      {
        ...defaultSkillCandidateDraft(),
        skillID: "review.evidence",
        purpose: "Review bounded development evidence",
        triggers: "evidence review\nverification, evidence review",
        instructions: "Check the supplied evidence and report a bounded result.",
        allowedTools: "read\nsearch, read",
      },
      ["exp_b", "exp_a", "exp_b"],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.triggers).toEqual(["evidence review", "verification"])
    expect(result.value.allowedTools).toEqual(["read", "search"])
    expect(result.value.sourceExperienceIDs).toEqual(["exp_a", "exp_b"])
    expect(result.value.testCases).toEqual([{ id: "case-1", input: {}, expected: {} }])
  })

  test("rejects invalid identity, missing provenance, and non-object JSON", () => {
    const result = buildSkillCandidatePayload(
      {
        ...defaultSkillCandidateDraft(),
        skillID: "invalid skill id",
        version: "latest",
        purpose: "",
        triggers: "",
        instructions: "",
        inputSchema: "[]",
        testInput: "not-json",
      },
      [],
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(Object.keys(result.errors).toSorted()).toEqual(
      [
        "inputSchema",
        "instructions",
        "purpose",
        "skillID",
        "sourceExperienceIDs",
        "testInput",
        "triggers",
        "version",
      ].toSorted(),
    )
  })

  test("splits comma and newline input without keeping duplicates or empty values", () => {
    expect(splitSkillCandidateList(" read,search\nread\n  \nwrite ")).toEqual(["read", "search", "write"])
  })
})
