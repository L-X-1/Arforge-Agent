import { AgentRuntime } from "./agent-runtime"
import * as MemoryClass from "./memory-class"
import * as MemoryCandidate from "./memory-candidate"
import { Schema } from "effect"

export const PromotionAction = Schema.Literals(["candidate", "reject"]).annotate({
  identifier: "MemoryPromotionAction",
})
export type PromotionAction = typeof PromotionAction.Type

export const PromotionInput = Schema.Struct({
  runID: AgentRuntime.RunID,
  runStatus: AgentRuntime.RunStatus,
  verifierPassed: Schema.Boolean,
  evidence: Schema.Array(AgentRuntime.Evidence),
  observationIDs: Schema.Array(AgentRuntime.ObservationID),
  targetClass: MemoryClass.LongTermMemoryClass,
  policyAllows: Schema.Boolean,
  dedupStatus: MemoryCandidate.DedupStatus,
  sensitiveContent: Schema.Boolean,
  userConfirmed: Schema.Boolean,
}).annotate({ identifier: "MemoryPromotionInput" })
export interface PromotionInput extends Schema.Schema.Type<typeof PromotionInput> {}

export const PromotionDecision = Schema.Struct({
  action: PromotionAction,
  candidateRequired: Schema.Literal(true),
  reason: Schema.String,
  evidenceIDs: Schema.Array(AgentRuntime.EvidenceID),
  runID: AgentRuntime.RunID,
}).annotate({ identifier: "MemoryPromotionDecision" })
export interface PromotionDecision extends Schema.Schema.Type<typeof PromotionDecision> {}
