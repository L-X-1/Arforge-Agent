import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { canonicalHash } from "./util/canonical-hash"
import { redact } from "./redact"

export type ExperienceCandidateStatus = "candidate" | "approved" | "rejected" | "expired"
export type ExperienceReviewStatus = "pending" | "approved" | "rejected" | "expired"

export interface ExperienceCandidate {
  readonly candidateID: string
  readonly problemSignature: string
  readonly applicableScope: string
  readonly conditions: ReadonlyArray<string>
  readonly attemptedStrategy: string
  readonly verifiedOutcome: "success" | "failure"
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly counterexamples: ReadonlyArray<string>
  readonly confidence: number
  readonly supportCount: number
  readonly sourceRunIDs: ReadonlyArray<AgentRuntime.RunID>
  readonly sourceExperienceIDs: ReadonlyArray<AgentRuntime.ExperienceID>
  readonly expiryAt?: number
  readonly reviewStatus: ExperienceReviewStatus
  readonly policyVersion: string
  readonly status: ExperienceCandidateStatus
  readonly digest: string
}

export interface CreateExperienceCandidateInput {
  readonly problemSignature: string
  readonly applicableScope: string
  readonly conditions: ReadonlyArray<string>
  readonly attemptedStrategy: string
  readonly verifiedOutcome: AgentRuntime.ExperienceRecord
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly counterexamples?: ReadonlyArray<string>
  readonly policyVersion: string
  readonly expiryAt?: number
}

export interface AddSupportInput {
  readonly experience: AgentRuntime.ExperienceRecord
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly counterexample?: string
}

export class ExperienceCandidateError extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "CONFLICT" | "NOT_CANDIDATE",
    message: string,
  ) {
    super(message)
    this.name = "ExperienceCandidateError"
  }
}

const bounded = (value: string, name: string, maximum: number) => {
  const clean = redact(value).trim().slice(0, maximum)
  if (!clean) throw new ExperienceCandidateError("INVALID_INPUT", `${name} is required`)
  return clean
}

const unique = (values: ReadonlyArray<string>) => [...new Set(values.map((value) => value.trim()).filter(Boolean))]

const confidenceFor = (supportCount: number, counterexamples: number) =>
  Math.max(0, Math.min(0.95, (supportCount - counterexamples * 0.75) / 5))

const digestOf = (candidate: Omit<ExperienceCandidate, "candidateID" | "digest">) =>
  canonicalHash({
    problemSignature: candidate.problemSignature,
    applicableScope: candidate.applicableScope,
    conditions: candidate.conditions,
    attemptedStrategy: candidate.attemptedStrategy,
    verifiedOutcome: candidate.verifiedOutcome,
    evidenceIDs: candidate.evidenceIDs,
    counterexamples: candidate.counterexamples,
    supportCount: candidate.supportCount,
    sourceRunIDs: candidate.sourceRunIDs,
    sourceExperienceIDs: candidate.sourceExperienceIDs,
    expiryAt: candidate.expiryAt,
    policyVersion: candidate.policyVersion,
  }) ?? ""

const candidateIDFor = (digest: string) => `exc_${digest.slice(0, 24)}`

const assertExperience = (experience: AgentRuntime.ExperienceRecord) => {
  if (!experience.runID || experience.evidenceIDs.length === 0)
    throw new ExperienceCandidateError("INVALID_INPUT", "experience must reference a run and evidence")
  if (!experience.reusable)
    throw new ExperienceCandidateError("INVALID_INPUT", "only reusable verified experiences may seed a candidate")
}

export const createExperienceCandidate = (input: CreateExperienceCandidateInput): ExperienceCandidate => {
  assertExperience(input.verifiedOutcome)
  const policyVersion = bounded(input.policyVersion, "policyVersion", 120)
  const evidenceIDs = unique([...input.evidenceIDs.map(String), ...input.verifiedOutcome.evidenceIDs.map(String)])
  if (evidenceIDs.length === 0) throw new ExperienceCandidateError("INVALID_INPUT", "candidate requires evidence IDs")
  const sourceRunIDs = [String(input.verifiedOutcome.runID)]
  const sourceExperienceIDs = [String(input.verifiedOutcome.id)]
  const counterexamples = unique((input.counterexamples ?? []).map((value) => bounded(value, "counterexample", 500)))
  const base = {
    problemSignature: bounded(input.problemSignature, "problemSignature", 500),
    applicableScope: bounded(input.applicableScope, "applicableScope", 500),
    conditions: unique(input.conditions.map((value) => bounded(value, "condition", 500))),
    attemptedStrategy: bounded(input.attemptedStrategy, "attemptedStrategy", 2_000),
    verifiedOutcome: input.verifiedOutcome.outcome === "success" ? ("success" as const) : ("failure" as const),
    evidenceIDs: evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
    counterexamples,
    confidence: confidenceFor(1, counterexamples.length),
    supportCount: 1,
    sourceRunIDs: sourceRunIDs.map((id) => AgentRuntime.RunID.make(id)),
    sourceExperienceIDs: sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id)),
    ...(input.expiryAt === undefined ? {} : { expiryAt: input.expiryAt }),
    reviewStatus: "pending" as const,
    policyVersion,
    status: "candidate" as const,
  }
  const digest = digestOf(base)
  if (!digest) throw new ExperienceCandidateError("INVALID_INPUT", "candidate is not canonicalizable")
  return Object.freeze({ ...base, candidateID: candidateIDFor(digest), digest })
}

export const addSupport = (candidate: ExperienceCandidate, input: AddSupportInput): ExperienceCandidate => {
  if (candidate.status !== "candidate")
    throw new ExperienceCandidateError("NOT_CANDIDATE", "only candidate status may receive support")
  assertExperience(input.experience)
  const runID = String(input.experience.runID)
  const experienceID = String(input.experience.id)
  if (candidate.sourceRunIDs.some((id) => String(id) === runID))
    throw new ExperienceCandidateError("CONFLICT", "the same source run cannot support a candidate twice")
  const evidenceIDs = unique([
    ...candidate.evidenceIDs.map(String),
    ...input.evidenceIDs.map(String),
    ...input.experience.evidenceIDs.map(String),
  ])
  const counterexamples = unique([
    ...candidate.counterexamples,
    ...(input.counterexample ? [bounded(input.counterexample, "counterexample", 500)] : []),
  ])
  const next = {
    ...candidate,
    evidenceIDs: evidenceIDs.map((id) => AgentRuntime.EvidenceID.make(id)),
    counterexamples,
    confidence: confidenceFor(candidate.supportCount + 1, counterexamples.length),
    supportCount: candidate.supportCount + 1,
    sourceRunIDs: [...candidate.sourceRunIDs, AgentRuntime.RunID.make(runID)],
    sourceExperienceIDs: [...candidate.sourceExperienceIDs, AgentRuntime.ExperienceID.make(experienceID)],
  }
  const digest = digestOf(next)
  if (!digest) throw new ExperienceCandidateError("INVALID_INPUT", "candidate is not canonicalizable")
  return Object.freeze({ ...next, digest })
}

export const isPromotionEligible = (candidate: ExperienceCandidate, now = Date.now()) =>
  candidate.status === "candidate" &&
  candidate.reviewStatus === "pending" &&
  (candidate.expiryAt === undefined || candidate.expiryAt > now) &&
  candidate.supportCount >= 3 &&
  candidate.confidence >= 0.6 &&
  candidate.counterexamples.length < candidate.supportCount
