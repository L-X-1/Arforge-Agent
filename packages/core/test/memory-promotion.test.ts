import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as Promotion from "@arforge-ai/schema/memory-promotion"
import { evaluatePromotion, terminalStatus } from "@arforge-ai/core/memory-promotion"

const runID = AgentRuntime.RunID.make("run_promotion")
const observationID = AgentRuntime.ObservationID.make("obs_promotion")
const evidence = (overrides: Partial<AgentRuntime.Evidence> = {}): AgentRuntime.Evidence => ({
  id: AgentRuntime.EvidenceID.make("evd_promotion"),
  source: "verification",
  sourceDigest: "digest",
  trust: "verified",
  instructionAllowed: false,
  summary: "Migration test passed.",
  capturedAt: DateTime.makeUnsafe(0),
  runID,
  observationIDs: [observationID],
  sensitivity: "internal",
  verificationStatus: "verified",
  ...overrides,
})

const input = (overrides: Partial<Promotion.PromotionInput> = {}): Promotion.PromotionInput => ({
  runID,
  runStatus: "completed",
  verifierPassed: true,
  evidence: [evidence()],
  observationIDs: [observationID],
  targetClass: "semantic",
  policyAllows: true,
  dedupStatus: "novel",
  sensitiveContent: false,
  userConfirmed: false,
  ...overrides,
})

describe("Memory Step 5.9 Run promotion", () => {
  test("promotes only to Candidate after terminal verified evidence", () => {
    expect(evaluatePromotion(input())).toMatchObject({ action: "candidate", candidateRequired: true })
    expect(String(evaluatePromotion(input()).runID)).toBe("run_promotion")
    expect(evaluatePromotion(input()).evidenceIDs.map(String)).toEqual(["evd_promotion"])
  })

  test("rejects non-terminal, failed-verifier, untraceable, and policy-denied runs", () => {
    expect(evaluatePromotion(input({ runStatus: "failed" }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ verifierPassed: false }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ observationIDs: [] }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ policyAllows: false }))).toMatchObject({ action: "reject" })
  })

  test("rejects duplicate/conflict, unconfirmed sensitive content, and invalid evidence", () => {
    expect(evaluatePromotion(input({ dedupStatus: "duplicate" }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ dedupStatus: "conflict" }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ sensitiveContent: true, userConfirmed: false }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ sensitiveContent: true, userConfirmed: true }))).toMatchObject({ action: "candidate" })
    expect(evaluatePromotion(input({ evidence: [evidence({ sensitivity: "secret" })] }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ evidence: [evidence({ runID: AgentRuntime.RunID.make("run_other") })] }))).toMatchObject({ action: "reject" })
  })

  test("does not promote unverified model summaries or empty evidence", () => {
    expect(evaluatePromotion(input({ evidence: [] }))).toMatchObject({ action: "reject" })
    expect(evaluatePromotion(input({ evidence: [evidence({ verificationStatus: "unverified" })] }))).toMatchObject({
      action: "candidate",
    })
    expect(terminalStatus("completed")).toBe(true)
    expect(terminalStatus("failed")).toBe(false)
  })
})
