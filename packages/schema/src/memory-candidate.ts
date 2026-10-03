import { AgentRuntime } from "./agent-runtime"
import { Memory } from "./memory"
import * as MemoryClass from "./memory-class"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { Schema } from "effect"

const brandedID = (prefix: string, brand: string) =>
  Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + `${Date.now().toString(36)}-candidate`) })),
  )

export const CandidateID = brandedID("mcan_", "MemoryCandidateID")
export type CandidateID = typeof CandidateID.Type

export const Sensitivity = Schema.Literals(["public", "internal", "confidential", "secret"]).annotate({
  identifier: "MemoryCandidateSensitivity",
})
export type Sensitivity = typeof Sensitivity.Type

export const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
  identifier: "MemoryCandidateConfidence",
})
export type Confidence = typeof Confidence.Type

export const DedupStatus = Schema.Literals(["unknown", "novel", "near_duplicate", "duplicate", "conflict"]).annotate({
  identifier: "MemoryCandidateDedupStatus",
})
export type DedupStatus = typeof DedupStatus.Type

export const Dedup = Schema.Struct({
  status: DedupStatus,
  comparedMemoryIDs: Schema.Array(Memory.ID).check(Schema.isMaxLength(100)),
  similarity: Schema.Finite.pipe(optional),
}).annotate({ identifier: "MemoryCandidateDedup" })
export interface Dedup extends Schema.Schema.Type<typeof Dedup> {}

export const RetentionMode = Schema.Literals(["default", "short", "long", "indefinite", "until_review"]).annotate({
  identifier: "MemoryCandidateRetentionMode",
})
export type RetentionMode = typeof RetentionMode.Type

export const RetentionProposal = Schema.Struct({
  mode: RetentionMode,
  expiresAt: DateTimeUtcFromMillis.pipe(optional),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)),
}).annotate({ identifier: "MemoryCandidateRetentionProposal" })
export interface RetentionProposal extends Schema.Schema.Type<typeof RetentionProposal> {}

export const Proposer = Schema.Struct({
  kind: Schema.Literals(["user", "agent", "system"]),
  principalRef: AgentRuntime.ControlPrincipalRef.pipe(optional),
  runID: AgentRuntime.RunID.pipe(optional),
}).annotate({ identifier: "MemoryCandidateProposer" })
export interface Proposer extends Schema.Schema.Type<typeof Proposer> {}

export const PolicyDecision = Schema.Struct({
  status: Schema.Literals(["pending", "allow", "deny", "review"]),
  policyVersion: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)),
}).annotate({ identifier: "MemoryCandidatePolicyDecision" })
export interface PolicyDecision extends Schema.Schema.Type<typeof PolicyDecision> {}

export const Status = Schema.Literals([
  "proposed",
  "approved",
  "rejected",
  "promoted",
  "expired",
  "superseded",
]).annotate({
  identifier: "MemoryCandidateStatus",
})
export type Status = typeof Status.Type

export const ReviewOperation = Schema.Literals(["proposed", "approved", "rejected", "activated"]).annotate({
  identifier: "MemoryCandidateReviewOperation",
})
export type ReviewOperation = typeof ReviewOperation.Type

export const ReviewAudit = Schema.Struct({
  auditID: Schema.String.check(Schema.isStartsWith("mcaud_")),
  operation: ReviewOperation,
  actorKind: Schema.Literals(["user", "agent", "system", "maintenance", "recovery"]),
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(500)),
  policyVersion: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(100)),
  statusFrom: Status.pipe(optional),
  statusTo: Status,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "MemoryCandidateReviewAudit" })
export interface ReviewAudit extends Schema.Schema.Type<typeof ReviewAudit> {}

export const ReviewBlockCode = Schema.Literals([
  "status_not_proposed",
  "policy_not_allow",
  "secret_or_credential",
  "duplicate",
  "conflict",
  "working_state",
]).annotate({ identifier: "MemoryCandidateReviewBlockCode" })
export type ReviewBlockCode = typeof ReviewBlockCode.Type

export const Candidate = Schema.Struct({
  candidateID: CandidateID,
  proposedClass: MemoryClass.MemoryClass,
  content: Memory.Content,
  sourceEvidenceIDs: Schema.Array(AgentRuntime.EvidenceID).check(Schema.isMaxLength(100)),
  scope: Memory.Scope,
  sensitivity: Sensitivity,
  confidence: Confidence,
  dedup: Dedup,
  retention: RetentionProposal,
  proposer: Proposer,
  policy: PolicyDecision,
  status: Status,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    expires: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Memory.Candidate" })
export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}

export const Review = Schema.Struct({
  candidateID: CandidateID,
  proposedClass: MemoryClass.MemoryClass,
  content: Memory.Content.pipe(optional),
  contentRedacted: Schema.Boolean,
  sourceEvidenceIDs: Schema.Array(AgentRuntime.EvidenceID).check(Schema.isMaxLength(100)),
  scope: Memory.Scope,
  sensitivity: Sensitivity,
  confidence: Confidence,
  dedup: Dedup,
  retention: RetentionProposal,
  proposer: Proposer,
  policy: PolicyDecision,
  status: Status,
  reason: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(500)),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    expires: DateTimeUtcFromMillis.pipe(optional),
  }),
  approvalAllowed: Schema.Boolean,
  activationAllowed: Schema.Boolean,
  blockedReasons: Schema.Array(ReviewBlockCode),
  audit: Schema.Array(ReviewAudit).check(Schema.isMaxLength(100)),
}).annotate({ identifier: "MemoryCandidateReview" })
export interface Review extends Schema.Schema.Type<typeof Review> {}

/**
 * Candidate promotion is intentionally stricter than merely being present.
 * Step 5.4 adds authority and sensitivity policy; this gate prevents a
 * proposed/review/duplicate candidate from being mistaken for active memory.
 */
export const isActivationEligible = (candidate: Candidate): boolean =>
  candidate.proposedClass !== "working" &&
  candidate.status === "approved" &&
  candidate.policy.status === "allow" &&
  candidate.dedup.status !== "duplicate" &&
  candidate.dedup.status !== "conflict" &&
  candidate.sensitivity !== "secret"
