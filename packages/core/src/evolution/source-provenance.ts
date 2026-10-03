export * as EvolutionSourceProvenanceV1 from "./source-provenance"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Schema } from "effect"
import { canonicalHash } from "../util/canonical-hash"

export const SOURCE_PROVENANCE_SCHEMA_VERSION = 1 as const
export const SOURCE_PROVENANCE_ARTIFACT_KIND = "evolution-source-provenance" as const

const DIGEST = /^[0-9a-f]{64}$/
const EXPERIENCE_ID = /^exp_[A-Za-z0-9_-]+$/
const EVIDENCE_ID = /^evd_[A-Za-z0-9_-]+$/
const RUN_ID = /^run_[A-Za-z0-9_-]+$/
const ACTION_ID = /^act_[A-Za-z0-9_-]+$/

export interface SourceProvenanceInput {
  readonly experiences: ReadonlyArray<AgentRuntime.ExperienceRecord>
  readonly evidence: ReadonlyArray<AgentRuntime.Evidence>
  readonly evaluations: ReadonlyArray<{
    readonly runID: AgentRuntime.RunID
    readonly result: AgentRuntime.EvaluationResult
  }>
}

export interface SourceProvenanceArtifact {
  readonly digest: string
  readonly kind: typeof SOURCE_PROVENANCE_ARTIFACT_KIND
  readonly uri: string
  readonly content: string
  readonly recordDigest: string
  readonly experienceIDs: ReadonlyArray<string>
  readonly evidenceIDs: ReadonlyArray<string>
  readonly evaluationIDs: ReadonlyArray<string>
  readonly runIDs: ReadonlyArray<string>
}

export interface SourceProvenanceManifestBinding {
  readonly digest: string
  readonly record_digest: string
  readonly kind: typeof SOURCE_PROVENANCE_ARTIFACT_KIND
  readonly uri: string
}

export interface SourceProvenanceVerification {
  readonly verified: true
  readonly recordDigest: string
  readonly experienceIDs: ReadonlyArray<string>
  readonly evidenceIDs: ReadonlyArray<string>
  readonly evaluationIDs: ReadonlyArray<string>
  readonly runIDs: ReadonlyArray<string>
  readonly evaluations: ReadonlyArray<{
    readonly runID: AgentRuntime.RunID
    readonly result: AgentRuntime.EvaluationResult
  }>
}

export class SourceProvenanceError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "SourceProvenanceError"
  }
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined

const uniqueSorted = (values: ReadonlyArray<string>, name: string): ReadonlyArray<string> => {
  if (new Set(values).size !== values.length) throw new SourceProvenanceError(`${name} contains duplicate identifiers`)
  return Object.freeze([...values].sort())
}

const decodeExperience = (value: unknown): AgentRuntime.ExperienceRecord => {
  try {
    const encoded = Schema.encodeUnknownSync(AgentRuntime.ExperienceRecord)(value)
    return Schema.decodeUnknownSync(AgentRuntime.ExperienceRecord)(encoded)
  } catch {
    try {
      return Schema.decodeUnknownSync(AgentRuntime.ExperienceRecord)(value)
    } catch {
      throw new SourceProvenanceError("source provenance contains an invalid ExperienceRecord")
    }
  }
}

const decodeEvidence = (value: unknown): AgentRuntime.Evidence => {
  try {
    const encoded = Schema.encodeUnknownSync(AgentRuntime.Evidence)(value)
    return Schema.decodeUnknownSync(AgentRuntime.Evidence)(encoded)
  } catch {
    try {
      return Schema.decodeUnknownSync(AgentRuntime.Evidence)(value)
    } catch {
      throw new SourceProvenanceError("source provenance contains invalid Evidence")
    }
  }
}

const decodeEvaluation = (value: unknown): AgentRuntime.EvaluationResult => {
  try {
    const encoded = Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(value)
    return Schema.decodeUnknownSync(AgentRuntime.EvaluationResult)(encoded)
  } catch {
    try {
      return Schema.decodeUnknownSync(AgentRuntime.EvaluationResult)(value)
    } catch {
      throw new SourceProvenanceError("source provenance contains an invalid EvaluationResult")
    }
  }
}

const encodeExperience = (value: AgentRuntime.ExperienceRecord): unknown => {
  try {
    return Schema.encodeUnknownSync(AgentRuntime.ExperienceRecord)(value)
  } catch {
    throw new SourceProvenanceError("source provenance ExperienceRecord cannot be encoded")
  }
}

const encodeEvidence = (value: AgentRuntime.Evidence): unknown => {
  try {
    return Schema.encodeUnknownSync(AgentRuntime.Evidence)(value)
  } catch {
    throw new SourceProvenanceError("source provenance Evidence cannot be encoded")
  }
}

const encodeEvaluation = (value: AgentRuntime.EvaluationResult): unknown => {
  try {
    return Schema.encodeUnknownSync(AgentRuntime.EvaluationResult)(value)
  } catch {
    throw new SourceProvenanceError("source provenance EvaluationResult cannot be encoded")
  }
}

const validate = (input: SourceProvenanceInput) => {
  if (!Array.isArray(input.experiences) || input.experiences.length < 1 || input.experiences.length > 20)
    throw new SourceProvenanceError("source provenance requires between 1 and 20 Experience records")
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 20)
    throw new SourceProvenanceError("source provenance requires between 1 and 20 Evidence records")
  if (!Array.isArray(input.evaluations) || input.evaluations.length < 1 || input.evaluations.length > 20)
    throw new SourceProvenanceError("source provenance requires between 1 and 20 EvaluationResult records")

  const experiences = [...input.experiences]
    .map(decodeExperience)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const evidence = [...input.evidence]
    .map(decodeEvidence)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  const evaluations = [...input.evaluations]
    .map((item) => ({ runID: AgentRuntime.RunID.make(String(item.runID)), result: decodeEvaluation(item.result) }))
    .sort((left, right) => String(left.result.id).localeCompare(String(right.result.id)))
  const experienceIDs = uniqueSorted(
    experiences.map((item) => String(item.id)),
    "source Experience",
  )
  const evidenceIDs = uniqueSorted(
    evidence.map((item) => String(item.id)),
    "source Evidence",
  )
  const evaluationIDs = uniqueSorted(
    evaluations.map((item) => String(item.result.id)),
    "source EvaluationResult",
  )
  if (!experienceIDs.every((id) => EXPERIENCE_ID.test(id)))
    throw new SourceProvenanceError("source provenance contains an invalid Experience identifier")
  if (!evidenceIDs.every((id) => EVIDENCE_ID.test(id)))
    throw new SourceProvenanceError("source provenance contains an invalid Evidence identifier")

  const evidenceByID = new Map(evidence.map((item) => [String(item.id), item] as const))
  const evaluationByRunID = new Map<string, (typeof evaluations)[number]>()
  for (const evaluation of evaluations) {
    const runID = String(evaluation.runID)
    if (evaluationByRunID.has(runID))
      throw new SourceProvenanceError("source provenance must contain exactly one EvaluationResult per Run")
    if (
      !RUN_ID.test(runID) ||
      !String(evaluation.result.id).startsWith("eva_") ||
      evaluation.result.passed !== true ||
      evaluation.result.sampleSize < 1 ||
      !DIGEST.test(evaluation.result.baseline) ||
      !DIGEST.test(evaluation.result.candidate) ||
      evaluation.result.evidenceIDs.length < 1
    )
      throw new SourceProvenanceError("source EvaluationResult must be a passed immutable Run evaluation")
    evaluationByRunID.set(runID, evaluation)
  }
  const referencedEvidence = new Set<string>()
  const runIDs: string[] = []
  for (const experience of experiences) {
    const runID = String(experience.runID)
    if (
      experience.outcome !== "success" ||
      experience.reusable !== true ||
      !RUN_ID.test(runID) ||
      experience.evidenceIDs.length < 1
    )
      throw new SourceProvenanceError("source Experience must be a reusable verified success from a Run")
    if (new Set(experience.evidenceIDs.map(String)).size !== experience.evidenceIDs.length)
      throw new SourceProvenanceError("source Experience contains duplicate Evidence references")
    const evaluation = evaluationByRunID.get(runID)
    if (!evaluation)
      throw new SourceProvenanceError("source Experience requires a passed EvaluationResult from the same Run")
    const evaluationEvidenceIDs = evaluation.result.evidenceIDs.map(String)
    if (!runIDs.includes(runID)) runIDs.push(runID)
    for (const evidenceIDValue of experience.evidenceIDs) {
      const evidenceID = String(evidenceIDValue)
      const item = evidenceByID.get(evidenceID)
      if (!item) throw new SourceProvenanceError("source Experience references missing Evidence")
      if (!evaluationEvidenceIDs.includes(evidenceID))
        throw new SourceProvenanceError("source EvaluationResult does not bind the Experience Evidence")
      if (
        String(item.runID ?? "") !== runID ||
        !ACTION_ID.test(String(item.actionID ?? "")) ||
        item.verificationStatus !== "verified" ||
        (item.trust !== "verified" && item.trust !== "trusted") ||
        item.instructionAllowed !== false ||
        !String(item.contentDigest ?? "").trim() ||
        !String(item.extractionMethod ?? "").trim() ||
        !String(item.extractionVersion ?? "").trim()
      )
        throw new SourceProvenanceError(
          "source Evidence must be verifier-backed, non-instructional, and bound to its Experience Run/action",
        )
      referencedEvidence.add(evidenceID)
    }
  }
  if (referencedEvidence.size !== evidenceIDs.length || evidenceIDs.some((id) => !referencedEvidence.has(id)))
    throw new SourceProvenanceError("source provenance contains Evidence not referenced by an Experience")
  if (evaluationByRunID.size !== runIDs.length || [...evaluationByRunID.keys()].some((id) => !runIDs.includes(id)))
    throw new SourceProvenanceError("source provenance contains an EvaluationResult without an Experience Run")

  return {
    experiences,
    evidence,
    evaluations,
    experienceIDs,
    evidenceIDs,
    evaluationIDs,
    runIDs: Object.freeze(runIDs.sort()),
  }
}

export const createSourceProvenance = (input: SourceProvenanceInput): SourceProvenanceArtifact => {
  const checked = validate(input)
  const payload = {
    schema_version: SOURCE_PROVENANCE_SCHEMA_VERSION,
    experiences: checked.experiences.map(encodeExperience),
    evidence: checked.evidence.map(encodeEvidence),
    evaluations: checked.evaluations.map((item) => ({
      run_id: String(item.runID),
      result: encodeEvaluation(item.result),
    })),
  }
  const recordDigest = canonicalHash(payload)
  if (!recordDigest) throw new SourceProvenanceError("source provenance is not canonicalizable")
  const kind = SOURCE_PROVENANCE_ARTIFACT_KIND
  const uri = `artifact://evolution/source-provenance/${recordDigest}/source.json`
  const content = JSON.stringify(payload)
  const digest = canonicalHash({ kind, uri, content })
  if (!digest) throw new SourceProvenanceError("source provenance artifact is not canonicalizable")
  return Object.freeze({
    digest,
    kind,
    uri,
    content,
    recordDigest,
    experienceIDs: checked.experienceIDs,
    evidenceIDs: checked.evidenceIDs,
    evaluationIDs: checked.evaluationIDs,
    runIDs: checked.runIDs,
  })
}

export const sourceProvenanceBinding = (artifact: SourceProvenanceArtifact): SourceProvenanceManifestBinding =>
  Object.freeze({
    digest: artifact.digest,
    record_digest: artifact.recordDigest,
    kind: artifact.kind,
    uri: artifact.uri,
  })

export const verifySourceProvenance = (input: {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly artifact: {
    readonly digest: string
    readonly kind: string
    readonly uri: string
    readonly content: string
  }
}): SourceProvenanceVerification => {
  const binding = record(input.manifest.source_provenance_artifact)
  const manifestExperienceIDs = strings(input.manifest.source_experience_ids)
  const manifestEvidenceIDs = strings(input.manifest.source_evidence_ids)
  const manifestEvaluationIDs = strings(input.manifest.source_evaluation_ids)
  if (!binding || !manifestExperienceIDs || !manifestEvidenceIDs || !manifestEvaluationIDs)
    throw new SourceProvenanceError("candidate source provenance binding is missing")
  let payload: Readonly<Record<string, unknown>> | undefined
  try {
    payload = record(JSON.parse(input.artifact.content))
  } catch {
    payload = undefined
  }
  if (
    !payload ||
    payload.schema_version !== SOURCE_PROVENANCE_SCHEMA_VERSION ||
    !Array.isArray(payload.experiences) ||
    !Array.isArray(payload.evidence) ||
    !Array.isArray(payload.evaluations)
  )
    throw new SourceProvenanceError("source provenance artifact payload is invalid")
  const rebuilt = createSourceProvenance({
    experiences: payload.experiences.map(decodeExperience),
    evidence: payload.evidence.map(decodeEvidence),
    evaluations: payload.evaluations.map((value) => {
      const item = record(value)
      if (!item || typeof item.run_id !== "string")
        throw new SourceProvenanceError("source provenance EvaluationResult Run binding is invalid")
      return { runID: AgentRuntime.RunID.make(item.run_id), result: decodeEvaluation(item.result) }
    }),
  })
  if (
    !DIGEST.test(input.artifact.digest) ||
    input.artifact.digest !== rebuilt.digest ||
    input.artifact.kind !== rebuilt.kind ||
    input.artifact.uri !== rebuilt.uri ||
    input.artifact.content !== rebuilt.content ||
    binding.digest !== rebuilt.digest ||
    binding.record_digest !== rebuilt.recordDigest ||
    binding.kind !== rebuilt.kind ||
    binding.uri !== rebuilt.uri ||
    input.manifest.source_provenance_digest !== rebuilt.recordDigest ||
    canonicalHash(manifestExperienceIDs) !== canonicalHash(rebuilt.experienceIDs) ||
    canonicalHash(manifestEvidenceIDs) !== canonicalHash(rebuilt.evidenceIDs) ||
    canonicalHash(manifestEvaluationIDs) !== canonicalHash(rebuilt.evaluationIDs)
  )
    throw new SourceProvenanceError("candidate source provenance artifact is forged or stale")
  return Object.freeze({
    verified: true,
    recordDigest: rebuilt.recordDigest,
    experienceIDs: rebuilt.experienceIDs,
    evidenceIDs: rebuilt.evidenceIDs,
    evaluationIDs: rebuilt.evaluationIDs,
    runIDs: rebuilt.runIDs,
    evaluations: Object.freeze(
      payload.evaluations.map((value) => {
        const item = record(value)!
        return Object.freeze({
          runID: AgentRuntime.RunID.make(String(item.run_id)),
          result: decodeEvaluation(item.result),
        })
      }),
    ),
  })
}
