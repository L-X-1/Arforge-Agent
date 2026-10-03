export type SkillEvaluationResultChoice = "" | "passed" | "failed"

export type SkillEvaluationResourceDraft = {
  result: SkillEvaluationResultChoice
  steps: string
  tokens: string
  costMinor: string
}

export type SkillEvaluationObservationDraft = {
  caseID: string
  baseline: SkillEvaluationResourceDraft
  candidate: SkillEvaluationResourceDraft
  newFailures: string
  newSecretFindings: string
  newEgressAttempts: string
  evidenceIDs: string[]
  safetyConfirmed: boolean
}

export type SkillEvaluationFormErrorCode =
  | "case-set-mismatch"
  | "result-required"
  | "number-required"
  | "evidence-required"
  | "evidence-invalid"
  | "safety-confirmation-required"

export type SkillEvaluationFormErrors = Readonly<Record<string, SkillEvaluationFormErrorCode>>

export type SkillEvaluationObservationPayload = {
  readonly caseID: string
  readonly baseline: {
    readonly success: boolean
    readonly steps: number
    readonly tokens: number
    readonly costMinor: number
    readonly newFailures: number
    readonly newSecretFindings: number
    readonly newEgressAttempts: number
  }
  readonly candidate: {
    readonly success: boolean
    readonly steps: number
    readonly tokens: number
    readonly costMinor: number
    readonly newFailures: number
    readonly newSecretFindings: number
    readonly newEgressAttempts: number
  }
  readonly evidenceIDs: ReadonlyArray<string>
}

const emptyResource = (): SkillEvaluationResourceDraft => ({ result: "", steps: "", tokens: "", costMinor: "" })

export const createSkillEvaluationDrafts = (
  testIDs: ReadonlyArray<string>,
): ReadonlyArray<SkillEvaluationObservationDraft> =>
  testIDs.map((caseID) => ({
    caseID,
    baseline: emptyResource(),
    candidate: emptyResource(),
    newFailures: "0",
    newSecretFindings: "0",
    newEgressAttempts: "0",
    evidenceIDs: [],
    safetyConfirmed: false,
  }))

export const skillEvaluationField = (
  index: number,
  field:
    | "baseline-result"
    | "baseline-steps"
    | "baseline-tokens"
    | "baseline-cost"
    | "candidate-result"
    | "candidate-steps"
    | "candidate-tokens"
    | "candidate-cost"
    | "new-failures"
    | "new-secret-findings"
    | "new-egress-attempts"
    | "evidence"
    | "safety-confirmed",
) => `case:${index}:${field}`

const parseNumber = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

const success = (value: SkillEvaluationResultChoice) => {
  if (value === "passed") return true
  if (value === "failed") return false
  return undefined
}

export const buildSkillEvaluationPayload = (input: {
  readonly drafts: ReadonlyArray<SkillEvaluationObservationDraft>
  readonly expectedTestIDs: ReadonlyArray<string>
  readonly allowedEvidenceIDs: ReadonlyArray<string>
}):
  | { readonly ok: true; readonly observations: ReadonlyArray<SkillEvaluationObservationPayload> }
  | { readonly ok: false; readonly errors: SkillEvaluationFormErrors } => {
  const errors: Record<string, SkillEvaluationFormErrorCode> = {}
  const expected = [...input.expectedTestIDs].toSorted()
  const actual = input.drafts.map((item) => item.caseID).toSorted()
  if (expected.length === 0 || expected.join("\u0000") !== actual.join("\u0000")) errors.form = "case-set-mismatch"

  const allowedEvidence = new Set(input.allowedEvidenceIDs)
  const observations: SkillEvaluationObservationPayload[] = []
  for (const [index, draft] of input.drafts.entries()) {
    const baselineSuccess = success(draft.baseline.result)
    const candidateSuccess = success(draft.candidate.result)
    const baselineSteps = parseNumber(draft.baseline.steps)
    const baselineTokens = parseNumber(draft.baseline.tokens)
    const baselineCost = parseNumber(draft.baseline.costMinor)
    const candidateSteps = parseNumber(draft.candidate.steps)
    const candidateTokens = parseNumber(draft.candidate.tokens)
    const candidateCost = parseNumber(draft.candidate.costMinor)
    const newFailures = parseNumber(draft.newFailures)
    const newSecretFindings = parseNumber(draft.newSecretFindings)
    const newEgressAttempts = parseNumber(draft.newEgressAttempts)
    if (baselineSuccess === undefined) errors[skillEvaluationField(index, "baseline-result")] = "result-required"
    if (candidateSuccess === undefined) errors[skillEvaluationField(index, "candidate-result")] = "result-required"
    if (baselineSteps === undefined) errors[skillEvaluationField(index, "baseline-steps")] = "number-required"
    if (baselineTokens === undefined) errors[skillEvaluationField(index, "baseline-tokens")] = "number-required"
    if (baselineCost === undefined) errors[skillEvaluationField(index, "baseline-cost")] = "number-required"
    if (candidateSteps === undefined) errors[skillEvaluationField(index, "candidate-steps")] = "number-required"
    if (candidateTokens === undefined) errors[skillEvaluationField(index, "candidate-tokens")] = "number-required"
    if (candidateCost === undefined) errors[skillEvaluationField(index, "candidate-cost")] = "number-required"
    if (newFailures === undefined) errors[skillEvaluationField(index, "new-failures")] = "number-required"
    if (newSecretFindings === undefined) errors[skillEvaluationField(index, "new-secret-findings")] = "number-required"
    if (newEgressAttempts === undefined) errors[skillEvaluationField(index, "new-egress-attempts")] = "number-required"
    const evidenceIDs = [...new Set(draft.evidenceIDs)]
    if (evidenceIDs.length === 0) errors[skillEvaluationField(index, "evidence")] = "evidence-required"
    else if (evidenceIDs.some((id) => !allowedEvidence.has(id)))
      errors[skillEvaluationField(index, "evidence")] = "evidence-invalid"
    if (!draft.safetyConfirmed) errors[skillEvaluationField(index, "safety-confirmed")] = "safety-confirmation-required"

    if (
      baselineSuccess !== undefined &&
      candidateSuccess !== undefined &&
      baselineSteps !== undefined &&
      baselineTokens !== undefined &&
      baselineCost !== undefined &&
      candidateSteps !== undefined &&
      candidateTokens !== undefined &&
      candidateCost !== undefined &&
      newFailures !== undefined &&
      newSecretFindings !== undefined &&
      newEgressAttempts !== undefined &&
      evidenceIDs.length > 0 &&
      evidenceIDs.every((id) => allowedEvidence.has(id)) &&
      draft.safetyConfirmed
    )
      observations.push({
        caseID: draft.caseID,
        baseline: {
          success: baselineSuccess,
          steps: baselineSteps,
          tokens: baselineTokens,
          costMinor: baselineCost,
          newFailures: 0,
          newSecretFindings: 0,
          newEgressAttempts: 0,
        },
        candidate: {
          success: candidateSuccess,
          steps: candidateSteps,
          tokens: candidateTokens,
          costMinor: candidateCost,
          newFailures,
          newSecretFindings,
          newEgressAttempts,
        },
        evidenceIDs,
      })
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, observations }
}
