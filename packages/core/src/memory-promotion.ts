import * as AgentRuntime from "@arforge-ai/schema/agent-runtime"
import * as Promotion from "@arforge-ai/schema/memory-promotion"

const reject = (input: Promotion.PromotionInput, reason: string): Promotion.PromotionDecision => ({
  action: "reject",
  candidateRequired: true,
  reason,
  evidenceIDs: input.evidence.map((evidence) => evidence.id),
  runID: input.runID,
})

/**
 * Run promotion can only emit a Candidate. Active Memory activation remains a
 * separate policy/authority operation, even when every verification passes.
 */
export const evaluatePromotion = (input: Promotion.PromotionInput): Promotion.PromotionDecision => {
  if (input.runStatus !== "completed") return reject(input, "Only a terminal completed Run can promote Memory.")
  if (!input.verifierPassed) return reject(input, "A verifier-passed result is required before promotion.")
  if (input.observationIDs.length === 0) return reject(input, "Promotion must reference at least one Observation.")
  if (!input.policyAllows) return reject(input, "Current Memory policy does not allow this target class or scope.")
  if (input.dedupStatus === "duplicate" || input.dedupStatus === "conflict") {
    return reject(input, "Promotion failed the candidate dedup/conflict gate.")
  }
  if (input.sensitiveContent && !input.userConfirmed) {
    return reject(input, "Sensitive Memory requires explicit user confirmation before activation.")
  }
  if (input.evidence.length === 0) return reject(input, "Promotion requires non-empty Evidence references.")
  if (
    input.evidence.some(
      (evidence) =>
        evidence.sensitivity === "confidential" ||
        evidence.sensitivity === "secret" ||
        evidence.verificationStatus === "rejected" ||
        evidence.verificationStatus === "expired" ||
        evidence.runID !== input.runID ||
        (evidence.observationIDs !== undefined &&
          evidence.observationIDs.every((observationID) => !input.observationIDs.includes(observationID))),
    )
  ) {
    return reject(input, "Evidence is confidential, invalid, expired, or not traceable to this Run.")
  }
  return {
    action: "candidate",
    candidateRequired: true,
    reason: "Verified Run evidence may create a Candidate; active promotion remains a separate governed action.",
    evidenceIDs: input.evidence.map((evidence) => evidence.id),
    runID: input.runID,
  }
}

export const terminalStatus = (status: AgentRuntime.RunStatus): boolean => status === "completed"
