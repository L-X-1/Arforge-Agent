export * as SkillV1 from "./skill-v1"

import { Schema } from "effect"
import { AgentRuntime } from "./agent-runtime"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"

const skillID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)).pipe(
  Schema.brand("SkillV1.SkillID"),
  statics((schema) => ({ create: () => schema.make(`skill_${Date.now().toString(36)}`) })),
)

export const SkillID = skillID
export type SkillID = typeof SkillID.Type

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/i)).annotate({
  identifier: "SkillV1.Digest",
})
export type Digest = typeof Digest.Type

export const Status = Schema.Literals(["draft", "candidate", "canary", "active", "retired"]).annotate({
  identifier: "SkillV1.Status",
})
export type Status = typeof Status.Type

export const SecurityReview = Schema.Struct({
  status: Schema.Literals(["pending", "passed", "failed"]),
  evidenceIDs: Schema.Array(AgentRuntime.EvidenceID),
  reviewerID: Schema.String.pipe(optional),
  policyVersion: Schema.String,
  reviewedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "SkillV1.SecurityReview" })
export interface SecurityReview extends Schema.Schema.Type<typeof SecurityReview> {}

export const ArtifactRef = Schema.Struct({
  path: Schema.String,
  digest: Digest,
}).annotate({ identifier: "SkillV1.ArtifactRef" })
export interface ArtifactRef extends Schema.Schema.Type<typeof ArtifactRef> {}

export const Skill = Schema.Struct({
  skillID,
  version: Schema.String,
  digest: Digest,
  purpose: Schema.String,
  triggers: Schema.Array(Schema.String),
  allowedTools: Schema.Array(Schema.String),
  allowedCapabilities: Schema.Array(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.Record(Schema.String, Schema.Unknown),
  instructionRefs: Schema.Array(ArtifactRef),
  assetRefs: Schema.Array(ArtifactRef),
  scriptRefs: Schema.Array(ArtifactRef),
  sourceExperienceIDs: Schema.Array(AgentRuntime.ExperienceID),
  testIDs: Schema.Array(Schema.String),
  evaluationID: AgentRuntime.EvaluationID.pipe(optional),
  securityReview: SecurityReview,
  status: Status,
  rollbackVersion: Schema.String.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "SkillV1.Skill" })
export interface Skill extends Schema.Schema.Type<typeof Skill> {}
