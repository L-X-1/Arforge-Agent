import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import {
  SourceProvenanceError,
  createSourceProvenance,
  sourceProvenanceBinding,
  verifySourceProvenance,
} from "@arforge-ai/core/evolution/source-provenance"
import { DateTime } from "effect"

const now = DateTime.makeUnsafe(1_786_579_200_000)
const baseline = "a".repeat(64)
const candidate = "b".repeat(64)

const fixture = () => {
  const runID = AgentRuntime.RunID.make("run_source_provenance")
  const evidenceID = AgentRuntime.EvidenceID.make("evd_source_provenance")
  const experience = AgentRuntime.ExperienceRecord.make({
    id: AgentRuntime.ExperienceID.make("exp_source_provenance"),
    runID,
    outcome: "success",
    summary: "Verifier-backed source outcome",
    evidenceIDs: [evidenceID],
    reusable: true,
    createdAt: now,
  })
  const evidence = AgentRuntime.Evidence.make({
    id: evidenceID,
    source: "verifier:shell:1",
    sourceDigest: "c".repeat(64),
    contentDigest: "c".repeat(64),
    trust: "verified",
    instructionAllowed: false,
    summary: "Independent verifier passed",
    capturedAt: now,
    extractionMethod: "verifier-registry",
    extractionVersion: "1",
    observationIDs: [AgentRuntime.ObservationID.make("obs_source_provenance")],
    runID,
    actionID: AgentRuntime.ActionID.make("act_source_provenance"),
    sensitivity: "internal",
    verificationStatus: "verified",
  })
  const result = AgentRuntime.EvaluationResult.make({
    id: AgentRuntime.EvaluationID.make("eva_source_provenance"),
    baseline,
    candidate,
    sampleSize: 1,
    successDelta: 1,
    costDelta: 0,
    latencyDelta: 0,
    passed: true,
    evidenceIDs: [evidenceID],
    evaluatedAt: now,
  })
  return { experience, evidence, evaluation: { runID, result } }
}

describe("Evolution source provenance", () => {
  test("creates a deterministic immutable artifact and verifies every binding", () => {
    const source = fixture()
    const first = createSourceProvenance({
      experiences: [source.experience],
      evidence: [source.evidence],
      evaluations: [source.evaluation],
    })
    const second = createSourceProvenance({
      evaluations: [source.evaluation],
      evidence: [source.evidence],
      experiences: [source.experience],
    })
    expect(second).toEqual(first)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.recordDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.experienceIDs).toEqual(["exp_source_provenance"])
    expect(first.evidenceIDs).toEqual(["evd_source_provenance"])
    expect(first.evaluationIDs).toEqual(["eva_source_provenance"])

    const verified = verifySourceProvenance({
      manifest: {
        source_experience_ids: first.experienceIDs,
        source_evidence_ids: first.evidenceIDs,
        source_evaluation_ids: first.evaluationIDs,
        source_provenance_digest: first.recordDigest,
        source_provenance_artifact: sourceProvenanceBinding(first),
      },
      artifact: first,
    })
    expect(verified).toMatchObject({
      verified: true,
      experienceIDs: ["exp_source_provenance"],
      evidenceIDs: ["evd_source_provenance"],
      evaluationIDs: ["eva_source_provenance"],
      runIDs: ["run_source_provenance"],
    })
  })

  test("fails closed on unverified, cross-Run, unevaluated, or tampered source data", () => {
    const source = fixture()
    expect(() =>
      createSourceProvenance({
        experiences: [source.experience],
        evidence: [{ ...source.evidence, verificationStatus: "unverified" }],
        evaluations: [source.evaluation],
      }),
    ).toThrow(SourceProvenanceError)
    expect(() =>
      createSourceProvenance({
        experiences: [source.experience],
        evidence: [{ ...source.evidence, runID: AgentRuntime.RunID.make("run_attacker") }],
        evaluations: [source.evaluation],
      }),
    ).toThrow(SourceProvenanceError)
    expect(() =>
      createSourceProvenance({
        experiences: [source.experience],
        evidence: [source.evidence],
        evaluations: [{ ...source.evaluation, result: { ...source.evaluation.result, passed: false } }],
      }),
    ).toThrow(SourceProvenanceError)

    const artifact = createSourceProvenance({
      experiences: [source.experience],
      evidence: [source.evidence],
      evaluations: [source.evaluation],
    })
    expect(() =>
      verifySourceProvenance({
        manifest: {
          source_experience_ids: artifact.experienceIDs,
          source_evidence_ids: artifact.evidenceIDs,
          source_evaluation_ids: artifact.evaluationIDs,
          source_provenance_digest: artifact.recordDigest,
          source_provenance_artifact: sourceProvenanceBinding(artifact),
        },
        artifact: { ...artifact, content: artifact.content.replace("verified", "forged") },
      }),
    ).toThrow(SourceProvenanceError)
  })
})
