import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { ContextContract } from "@arforge-ai/core/context-contract"
import { ContextPackage } from "@arforge-ai/core/context-package"
import { ContextRecovery } from "@arforge-ai/core/context-recovery"
import { EvidenceV2 } from "@arforge-ai/core/evidence"

const providerTokenizer = { revision: "provider-tokenizer-v2", count: (text: string) => text.length }

const evidence = EvidenceV2.create({
  evidenceID: AgentRuntime.EvidenceID.create(),
  sourceID: "memory:durable",
  contentDigest: "durable-content-digest",
  extractionMethod: "durable-test",
  extractionVersion: "1",
  trust: "verified",
  instructionAllowed: false,
  sensitivity: "internal",
  summary: "Durable evidence summary.",
})

const durableUnit = (evidenceID?: string): ContextContract.Unit => ({
  id: "durable-request",
  origin: "request",
  authority: "runtime-input",
  contextLayer: "current_request",
  trust: "trusted",
  text: "rebuild from durable state",
  mandatory: true,
  priority: 100,
  ...(evidenceID === undefined ? {} : { evidenceID, sourceID: "memory:durable", sourceDigest: evidence.contentDigest }),
})

describe("ContextRecovery", () => {
  test("recompiles durable state for a new model without reusing the old token layout", () => {
    const service = EvidenceV2.makeService([evidence])
    const durable = {
      sessionID: "session-durable",
      runID: "run-durable",
      checkpointID: "checkpoint-durable",
      units: [durableUnit(evidence.id)],
    }
    const oldPackage = ContextPackage.compile({
      model: "old-model",
      modelProfileRevision: "old-profile",
      tokenizer: { revision: "old-tokenizer", count: () => 1 },
      usableInputTokens: 100,
      units: durable.units,
    })
    const result = ContextRecovery.recompile({
      durable,
      modelID: "new-model",
      modelProfileRevision: "new-profile",
      tokenizer: providerTokenizer,
      usableInputTokens: 100,
      protectedFacts: ["rebuild from durable state"],
      evidence: service,
      missingEvidence: "block",
    })

    expect(result.status).toBe("recompiled")
    expect(result.recompiledFrom).toEqual({ sessionID: "session-durable", runID: "run-durable", checkpointID: "checkpoint-durable" })
    expect(result.package).toMatchObject({
      model: "new-model",
      modelProfileRevision: "new-profile",
      tokenizerRevision: "provider-tokenizer-v2",
      tokenizerMethod: "provider-tokenizer",
    })
    expect(result.package.digest).not.toBe(oldPackage.digest)
    expect(result.package.usedInputTokens).toBeGreaterThan(oldPackage.usedInputTokens)
    expect(result.compilerVersion).toBe(ContextPackage.COMPILER_VERSION)
    expect(result.missingEvidenceIDs).toEqual([])
  })

  test("can explicitly downgrade missing evidence and marks the rebuilt unit as derived", () => {
    const missingID = AgentRuntime.EvidenceID.create()
    const result = ContextRecovery.recompile({
      durable: { sessionID: "session-degrade", units: [durableUnit(missingID)] },
      modelID: "recovery-model",
      modelProfileRevision: "recovery-profile",
      usableInputTokens: 100,
      missingEvidence: "degrade",
      evidence: EvidenceV2.makeService(),
    })
    const manifest = result.package.manifest[0]
    expect(result.status).toBe("degraded")
    expect(result.missingEvidenceIDs).toEqual([missingID])
    expect(manifest).toMatchObject({
      origin: "summary",
      authority: "derived",
      contextLayer: "derived_summary",
      trust: "derived",
      selected: true,
    })
    expect(manifest?.evidenceID).toBeUndefined()
  })

  test("blocks recovery when required evidence is missing", () => {
    const missingID = AgentRuntime.EvidenceID.create()
    expect(() =>
      ContextRecovery.recompile({
        durable: { sessionID: "session-block", units: [durableUnit()] },
        modelID: "recovery-model",
        modelProfileRevision: "recovery-profile",
        usableInputTokens: 100,
        requiredEvidenceIDs: [missingID],
        missingEvidence: "block",
        evidence: EvidenceV2.makeService(),
      }),
    ).toThrow("missing evidence")
  })
})
