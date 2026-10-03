import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Memory } from "@arforge-ai/schema/memory"
import * as MemoryCandidate from "@arforge-ai/schema/memory-candidate"

const candidate = (overrides: Partial<MemoryCandidate.Candidate> = {}): MemoryCandidate.Candidate =>
  MemoryCandidate.Candidate.make({
    candidateID: MemoryCandidate.CandidateID.make("mcan_test"),
    proposedClass: "semantic",
    content: Memory.Content.make("Migration tests are required."),
    sourceEvidenceIDs: [AgentRuntime.EvidenceID.make("evd_test")],
    scope: "workspace",
    sensitivity: "internal",
    confidence: 0.9,
    dedup: { status: "novel", comparedMemoryIDs: [] },
    retention: { mode: "long", reason: "Stable project rule." },
    proposer: { kind: "agent", runID: AgentRuntime.RunID.make("run_test") },
    policy: { status: "allow", policyVersion: "memory-policy-v1", reason: "Evidence-backed proposal." },
    status: "approved",
    reason: "Proposed from verified evidence.",
    time: {
      created: DateTime.makeUnsafe(0),
      updated: DateTime.makeUnsafe(0),
    },
    ...overrides,
  })

describe("Memory Candidate contract", () => {
  test("contains every Step 5.3 field and can be activation-eligible", () => {
    const value = candidate()
    expect(String(value.candidateID)).toBe("mcan_test")
    expect(value.sourceEvidenceIDs.map(String)).toEqual(["evd_test"])
    expect(String(value.proposer.runID)).toBe("run_test")
    expect(MemoryCandidate.isActivationEligible(value)).toBe(true)
  })

  test("rejects secret and working candidates at the activation boundary", () => {
    expect(MemoryCandidate.isActivationEligible(candidate({ sensitivity: "secret" }))).toBe(false)
    expect(MemoryCandidate.isActivationEligible(candidate({ proposedClass: "working" }))).toBe(false)
  })

  test("rejects pending, duplicate, conflict, and unapproved candidates", () => {
    expect(MemoryCandidate.isActivationEligible(candidate({ status: "proposed" }))).toBe(false)
    expect(MemoryCandidate.isActivationEligible(candidate({ policy: { status: "review", policyVersion: "v1", reason: "review" } }))).toBe(false)
    expect(MemoryCandidate.isActivationEligible(candidate({ dedup: { status: "duplicate", comparedMemoryIDs: [] } }))).toBe(false)
    expect(MemoryCandidate.isActivationEligible(candidate({ dedup: { status: "conflict", comparedMemoryIDs: [] } }))).toBe(false)
  })

  test("does not accept Experience or Skill as proposed Memory classes", () => {
    expect(() =>
      Schema.decodeUnknownSync(MemoryCandidate.Candidate)({
        ...candidate(),
        proposedClass: "experience",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(MemoryCandidate.Candidate)({
        ...candidate(),
        proposedClass: "skill",
      }),
    ).toThrow()
  })
})
