import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SkillV1 as SkillContract } from "@arforge-ai/schema/skill-v1"
import { SkillContractError, createCandidate, ensureNoPermissionExpansion, transition } from "@arforge-ai/core/skill-v1"
import { fromManagedSkill } from "@arforge-ai/core/skill/managed"

const digest = (letter: string) => letter.repeat(64)
const base = {
  skillID: "release-checks",
  version: "1.0.0",
  purpose: "Run the verified release checks",
  triggers: ["release", "publish"],
  allowedTools: ["read"],
  allowedCapabilities: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  instructionRefs: [{ path: "SKILL.md", digest: digest("a") }],
  sourceExperienceIDs: ["exp_release"],
  testIDs: ["skill-test-release"],
  evaluationID: "eva_release",
  policyVersion: "skill-policy-v1",
  now: 1_725_000_000_000,
}

describe("SkillV1", () => {
  test("creates a bounded candidate with provenance, refs, digest, and lifecycle state", () => {
    const candidate = createCandidate({
      ...base,
      purpose: "token=sk-abcdefghijklmnopqrstuvwxyz123456 Run release checks",
    })

    expect(candidate.status).toBe("candidate")
    expect(String(candidate.skillID)).toBe("release-checks")
    expect(candidate.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(candidate.sourceExperienceIDs.map(String)).toEqual(["exp_release"])
    expect(candidate.securityReview).toMatchObject({
      status: "pending",
      policyVersion: "skill-policy-v1",
      evidenceIDs: [],
    })
    expect(candidate.purpose).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
  })

  test("requires security review before canary/active and supports rollback lifecycle", () => {
    const candidate = createCandidate(base)
    expect(() => transition(candidate, "canary")).toThrow("passed security review")
    const reviewed = SkillContract.Skill.make({
      ...candidate,
      securityReview: {
        status: "passed",
        evidenceIDs: [AgentRuntime.EvidenceID.make("evd_skill_security")],
        policyVersion: "skill-policy-v1",
        reviewedAt: DateTime.makeUnsafe(1_725_000_000_100),
      },
    })
    const canary = transition(reviewed, "canary", { now: 1_725_000_001_000, rollbackVersion: "0.9.0" })
    const active = transition(canary, "active", { now: 1_725_000_002_000 })
    expect(canary.status).toBe("canary")
    expect(canary.rollbackVersion).toBe("0.9.0")
    expect(active.status).toBe("active")
    expect(() => transition(active, "candidate")).toThrow("invalid skill transition")
  })

  test("rejects permission expansion and unsafe artifacts", () => {
    const candidate = createCandidate(base)
    const expanded = SkillContract.Skill.make({ ...candidate, allowedTools: ["read", "shell"] })
    expect(() => ensureNoPermissionExpansion(candidate, expanded)).toThrow("expands tools or capabilities")
    expect(() => createCandidate({ ...base, instructionRefs: [{ path: "../escape", digest: digest("a") }] })).toThrow(
      "artifact path is unsafe",
    )
    expect(() => createCandidate({ ...base, sourceExperienceIDs: ["memory_legacy"] })).toThrow(
      "sourceExperienceIDs must reference Experience records",
    )
  })

  test("adapts an existing managed filesystem skill only with explicit provenance", () => {
    const managed = {
      id: "legacy-release",
      name: "legacy-release",
      description: "Legacy release guidance",
      version: "1.0.0",
      source: "profile",
      path: "C:/skills/legacy-release",
      entrypoint: "SKILL.md",
      license: "LicenseRef-Proprietary",
      tags: ["release"],
      enabled: true,
      problems: [],
    }
    const candidate = fromManagedSkill(managed, "# Release\nRun checks", {
      sourceExperienceIDs: ["exp_release"],
      testIDs: ["skill-test-release"],
      policyVersion: "skill-policy-v1",
    })
    expect(candidate.status).toBe("candidate")
    expect(candidate.instructionRefs[0]?.path).toBe("SKILL.md")
    expect(candidate.sourceExperienceIDs.map(String)).toEqual(["exp_release"])
  })

  test("fails closed on invalid versions", () => {
    expect(() => createCandidate({ ...base, version: "latest" })).toThrow(SkillContractError)
  })
})
