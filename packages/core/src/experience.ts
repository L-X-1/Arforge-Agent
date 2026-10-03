export * as ExperienceV2 from "./experience"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { Outcome } from "./learning"
import { redact } from "./redact"

export class ExperienceMappingError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "ExperienceMappingError"
  }
}

/** Map only a durable, verifier-backed Learning outcome into reusable evidence. */
export function fromVerifiedOutcome(outcome: Outcome): AgentRuntime.ExperienceRecord {
  if (!outcome.runID || !outcome.actionID || !outcome.evaluationID)
    throw new ExperienceMappingError("experience requires run, action, and evaluation references")
  if (!outcome.evidenceIDs?.length)
    throw new ExperienceMappingError("experience requires immutable evidence references")
  if (outcome.terminal !== true) throw new ExperienceMappingError("experience requires a terminal outcome")
  if (outcome.success && outcome.verifierPassed !== true)
    throw new ExperienceMappingError("successful experience requires verifierPassed=true")
  const summary = redact(
    outcome.success
      ? `Verified success: ${outcome.userInput}`
      : `Verified ${outcome.regression ? "regression" : "failure"}: ${outcome.errorMessage || outcome.userInput}`,
  ).slice(0, 2_000)
  return AgentRuntime.ExperienceRecord.make({
    id: AgentRuntime.ExperienceID.create(),
    runID: AgentRuntime.RunID.make(outcome.runID),
    outcome: outcome.success ? "success" : "failure",
    summary,
    evidenceIDs: outcome.evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
    reusable: outcome.success && outcome.verifierPassed === true,
    createdAt: outcome.time.created,
  })
}
