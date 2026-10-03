export * as SkillV1 from "./skill-v1"

import { createHash } from "node:crypto"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import type { ManagedSkill } from "./skill/managed"
import { canonicalHash } from "./util/canonical-hash"
import { redact } from "./redact"

export const Skill = SkillContract.Skill
export type Skill = SkillContract.Skill
export const Status = SkillContract.Status
export type Status = SkillContract.Status
export const SecurityReview = SkillContract.SecurityReview
export type SecurityReview = SkillContract.SecurityReview
export const ArtifactRef = SkillContract.ArtifactRef
export type ArtifactRef = SkillContract.ArtifactRef

export class SkillContractError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "SkillContractError"
  }
}

export interface CandidateInput {
  readonly skillID: string
  readonly version: string
  readonly purpose: string
  readonly triggers: ReadonlyArray<string>
  readonly allowedTools: ReadonlyArray<string>
  readonly allowedCapabilities: ReadonlyArray<string>
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly instructionRefs: ReadonlyArray<ArtifactRef>
  readonly assetRefs?: ReadonlyArray<ArtifactRef>
  readonly scriptRefs?: ReadonlyArray<ArtifactRef>
  readonly sourceExperienceIDs: ReadonlyArray<string>
  readonly testIDs: ReadonlyArray<string>
  readonly evaluationID?: string
  readonly policyVersion: string
  readonly rollbackVersion?: string
  readonly now?: number
}

export interface ManagedSkillProvenance {
  readonly sourceExperienceIDs: ReadonlyArray<string>
  readonly testIDs: ReadonlyArray<string>
  readonly evaluationID?: string
  readonly policyVersion: string
  readonly allowedTools?: ReadonlyArray<string>
  readonly allowedCapabilities?: ReadonlyArray<string>
}

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const digestPattern = /^[a-f0-9]{64}$/i
const safePath = /^[A-Za-z0-9._/-]{1,256}$/

const bounded = (value: string, field: string, maximum: number) => {
  const clean = redact(value).trim().slice(0, maximum)
  if (!clean) throw new SkillContractError(`${field} is required`)
  return clean
}

const unique = (values: ReadonlyArray<string>, field: string, maximum: number, required = true) => {
  const result = [...new Set(values.map((value) => bounded(value, field, maximum)))]
  if (required && result.length === 0) throw new SkillContractError(`${field} must contain at least one value`)
  return result
}

const safeRef = (ref: ArtifactRef): ArtifactRef => {
  const path = bounded(ref.path, "artifact path", 256).replaceAll("\\", "/")
  if (
    !safePath.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    throw new SkillContractError(`artifact path is unsafe: ${path}`)
  if (!digestPattern.test(ref.digest)) throw new SkillContractError(`artifact digest is invalid: ${path}`)
  return { path, digest: ref.digest.toLowerCase() }
}

const refs = (values: ReadonlyArray<ArtifactRef>, field: string, required: boolean) => {
  if (required && values.length === 0) throw new SkillContractError(`${field} must contain at least one reference`)
  const normalized = values
    .map(safeRef)
    .toSorted((left, right) => left.path.localeCompare(right.path) || left.digest.localeCompare(right.digest))
  const keys = new Set<string>()
  for (const ref of normalized) {
    const key = `${ref.path}\u0000${ref.digest}`
    if (keys.has(key)) throw new SkillContractError(`${field} contains duplicate references`)
    keys.add(key)
  }
  return normalized
}

const artifactPayload = (input: {
  readonly skillID: string
  readonly version: string
  readonly purpose: string
  readonly triggers: ReadonlyArray<string>
  readonly allowedTools: ReadonlyArray<string>
  readonly allowedCapabilities: ReadonlyArray<string>
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly instructionRefs: ReadonlyArray<ArtifactRef>
  readonly assetRefs: ReadonlyArray<ArtifactRef>
  readonly scriptRefs: ReadonlyArray<ArtifactRef>
  readonly sourceExperienceIDs: ReadonlyArray<string>
  readonly testIDs: ReadonlyArray<string>
  readonly evaluationID?: string
  readonly rollbackVersion?: string
}) => ({
  skillID: input.skillID,
  version: input.version,
  purpose: input.purpose,
  triggers: input.triggers,
  allowedTools: input.allowedTools,
  allowedCapabilities: input.allowedCapabilities,
  inputSchema: input.inputSchema,
  outputSchema: input.outputSchema,
  instructionRefs: input.instructionRefs,
  assetRefs: input.assetRefs,
  scriptRefs: input.scriptRefs,
  sourceExperienceIDs: input.sourceExperienceIDs,
  testIDs: input.testIDs,
  ...(input.evaluationID === undefined ? {} : { evaluationID: input.evaluationID }),
  ...(input.rollbackVersion === undefined ? {} : { rollbackVersion: input.rollbackVersion }),
})

const now = (value?: number) => {
  const timestamp = value ?? Date.now()
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new SkillContractError("now must be finite and non-negative")
  return DateTime.makeUnsafe(timestamp)
}

export const createCandidate = (input: CandidateInput): Skill => {
  const skillID = bounded(input.skillID, "skillID", 128)
  const version = bounded(input.version, "version", 64)
  if (!versionPattern.test(version)) throw new SkillContractError("version must use semantic version syntax")
  const sourceExperienceIDs = unique(input.sourceExperienceIDs, "sourceExperienceIDs", 160)
  if (sourceExperienceIDs.some((id) => !id.startsWith("exp_")))
    throw new SkillContractError("sourceExperienceIDs must reference Experience records")
  const testIDs = unique(input.testIDs, "testIDs", 160)
  const evaluationID = input.evaluationID === undefined ? undefined : bounded(input.evaluationID, "evaluationID", 160)
  if (evaluationID !== undefined && !evaluationID.startsWith("eva_"))
    throw new SkillContractError("evaluationID must reference an Evaluation record")
  const policyVersion = bounded(input.policyVersion, "policyVersion", 120)
  const sourceExperienceRefs = sourceExperienceIDs.map((id) => AgentRuntime.ExperienceID.make(id))
  const evaluationRef = evaluationID === undefined ? undefined : AgentRuntime.EvaluationID.make(evaluationID)
  const artifactRefs = {
    instructionRefs: refs(input.instructionRefs, "instructionRefs", true),
    assetRefs: refs(input.assetRefs ?? [], "assetRefs", false),
    scriptRefs: refs(input.scriptRefs ?? [], "scriptRefs", false),
  }
  const normalized = {
    skillID: SkillContract.SkillID.make(skillID),
    version,
    purpose: bounded(input.purpose, "purpose", 1_000),
    triggers: unique(input.triggers, "triggers", 160),
    allowedTools: unique(input.allowedTools, "allowedTools", 160, false),
    allowedCapabilities: unique(input.allowedCapabilities, "allowedCapabilities", 160, false),
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    ...artifactRefs,
    sourceExperienceIDs: sourceExperienceRefs,
    testIDs,
    ...(evaluationRef === undefined ? {} : { evaluationID: evaluationRef }),
    ...(input.rollbackVersion === undefined
      ? {}
      : { rollbackVersion: bounded(input.rollbackVersion, "rollbackVersion", 64) }),
  }
  const digest = canonicalHash(artifactPayload(normalized))
  if (!digest || !digestPattern.test(digest)) throw new SkillContractError("skill artifact is not canonicalizable")
  const createdAt = now(input.now)
  return SkillContract.Skill.make({
    ...normalized,
    digest: SkillContract.Digest.make(digest),
    securityReview: {
      status: "pending",
      evidenceIDs: [],
      policyVersion,
    },
    status: "candidate",
    createdAt,
    updatedAt: createdAt,
  })
}

export const transition = (
  skill: Skill,
  status: Status,
  input: { readonly now?: number; readonly rollbackVersion?: string } = {},
): Skill => {
  const allowed: Readonly<Record<Status, ReadonlyArray<Status>>> = {
    draft: ["candidate"],
    candidate: ["draft", "canary"],
    canary: ["candidate", "active", "retired"],
    active: ["retired"],
    retired: [],
  }
  if (!allowed[skill.status].includes(status))
    throw new SkillContractError(`invalid skill transition: ${skill.status} -> ${status}`)
  if ((status === "canary" || status === "active") && skill.securityReview.status !== "passed")
    throw new SkillContractError("canary/active skills require a passed security review")
  if (status === "active" && skill.evaluationID === undefined)
    throw new SkillContractError("active skills require an evaluation ID")
  const updatedAt = now(input.now)
  return SkillContract.Skill.make({
    ...skill,
    status,
    ...(input.rollbackVersion === undefined
      ? {}
      : { rollbackVersion: bounded(input.rollbackVersion, "rollbackVersion", 64) }),
    updatedAt,
  })
}

export const ensureNoPermissionExpansion = (previous: Skill, next: Skill): void => {
  const isSubset = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
    after.every((value) => before.includes(value))
  if (
    !isSubset(previous.allowedTools, next.allowedTools) ||
    !isSubset(previous.allowedCapabilities, next.allowedCapabilities)
  )
    throw new SkillContractError("skill update expands tools or capabilities")
}

export const fromManagedSkill = (managed: ManagedSkill, content: string, provenance: ManagedSkillProvenance): Skill => {
  const contentDigest = createHash("sha256").update(content, "utf8").digest("hex")
  return createCandidate({
    skillID: managed.id,
    version: managed.version,
    purpose: managed.description || managed.name,
    triggers: [managed.id, managed.name, ...managed.tags],
    allowedTools: provenance.allowedTools ?? [],
    allowedCapabilities: provenance.allowedCapabilities ?? [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    instructionRefs: [{ path: managed.entrypoint, digest: contentDigest }],
    sourceExperienceIDs: provenance.sourceExperienceIDs,
    testIDs: provenance.testIDs,
    evaluationID: provenance.evaluationID,
    policyVersion: provenance.policyVersion,
  })
}
