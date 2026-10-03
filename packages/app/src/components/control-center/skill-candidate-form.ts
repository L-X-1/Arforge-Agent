export interface SkillCandidateDraft {
  readonly skillID: string
  readonly version: string
  readonly purpose: string
  readonly triggers: string
  readonly instructions: string
  readonly allowedTools: string
  readonly allowedCapabilities: string
  readonly inputSchema: string
  readonly outputSchema: string
  readonly testID: string
  readonly testInput: string
  readonly testExpected: string
  readonly policyVersion: string
}

export type SkillCandidateField = keyof SkillCandidateDraft | "sourceExperienceIDs"
export type SkillCandidateFormErrorCode =
  | "skill-id-format"
  | "version-format"
  | "purpose-required"
  | "triggers-required"
  | "instructions-required"
  | "tools-limit"
  | "capabilities-limit"
  | "sources-required"
  | "json-object"
  | "test-id-required"
  | "policy-required"
export type SkillCandidateFormErrors = Partial<Record<SkillCandidateField, SkillCandidateFormErrorCode>>

export interface SkillCandidateCreatePayload {
  readonly skillID: string
  readonly version: string
  readonly purpose: string
  readonly triggers: ReadonlyArray<string>
  readonly allowedTools: ReadonlyArray<string>
  readonly allowedCapabilities: ReadonlyArray<string>
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly instructions: string
  readonly sourceExperienceIDs: ReadonlyArray<string>
  readonly testCases: ReadonlyArray<{
    readonly id: string
    readonly input: Readonly<Record<string, unknown>>
    readonly expected: Readonly<Record<string, unknown>>
  }>
  readonly policyVersion: string
}

export const defaultSkillCandidateDraft = (): SkillCandidateDraft => ({
  skillID: "",
  version: "1.0.0",
  purpose: "",
  triggers: "",
  instructions: "",
  allowedTools: "",
  allowedCapabilities: "",
  inputSchema: '{\n  "type": "object"\n}',
  outputSchema: '{\n  "type": "object"\n}',
  testID: "case-1",
  testInput: "{}",
  testExpected: "{}",
  policyVersion: "skill-policy-v1",
})

export const splitSkillCandidateList = (value: string) => [
  ...new Set(
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
]

const parseObject = (value: string): Readonly<Record<string, unknown>> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Readonly<Record<string, unknown>>
  } catch {
    return undefined
  }
}

const listError = (values: ReadonlyArray<string>, maximumItems: number, maximumLength: number) =>
  values.length > maximumItems || values.some((item) => item.length > maximumLength)

export const buildSkillCandidatePayload = (
  draft: SkillCandidateDraft,
  selectedExperienceIDs: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly value: SkillCandidateCreatePayload }
  | { readonly ok: false; readonly errors: SkillCandidateFormErrors } => {
  const skillID = draft.skillID.trim()
  const version = draft.version.trim()
  const purpose = draft.purpose.trim()
  const instructions = draft.instructions.trim()
  const triggers = splitSkillCandidateList(draft.triggers)
  const allowedTools = splitSkillCandidateList(draft.allowedTools)
  const allowedCapabilities = splitSkillCandidateList(draft.allowedCapabilities)
  const sourceExperienceIDs = [...new Set(selectedExperienceIDs.map((item) => item.trim()).filter(Boolean))].toSorted()
  const testID = draft.testID.trim()
  const policyVersion = draft.policyVersion.trim()
  const inputSchema = parseObject(draft.inputSchema)
  const outputSchema = parseObject(draft.outputSchema)
  const testInput = parseObject(draft.testInput)
  const testExpected = parseObject(draft.testExpected)
  const errors: SkillCandidateFormErrors = {}

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(skillID)) errors.skillID = "skill-id-format"
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || version.length > 64) errors.version = "version-format"
  if (!purpose || purpose.length > 1_000) errors.purpose = "purpose-required"
  if (triggers.length === 0 || listError(triggers, 50, 160)) errors.triggers = "triggers-required"
  if (!instructions || instructions.length > 100_000) errors.instructions = "instructions-required"
  if (listError(allowedTools, 100, 160)) errors.allowedTools = "tools-limit"
  if (listError(allowedCapabilities, 100, 160)) errors.allowedCapabilities = "capabilities-limit"
  if (
    sourceExperienceIDs.length === 0 ||
    sourceExperienceIDs.length > 20 ||
    sourceExperienceIDs.some((id) => !id.startsWith("exp_") || id.length > 160)
  )
    errors.sourceExperienceIDs = "sources-required"
  if (!inputSchema) errors.inputSchema = "json-object"
  if (!outputSchema) errors.outputSchema = "json-object"
  if (!testID || testID.length > 160) errors.testID = "test-id-required"
  if (!testInput) errors.testInput = "json-object"
  if (!testExpected) errors.testExpected = "json-object"
  if (!policyVersion || policyVersion.length > 120) errors.policyVersion = "policy-required"

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      skillID,
      version,
      purpose,
      triggers,
      allowedTools,
      allowedCapabilities,
      inputSchema: inputSchema!,
      outputSchema: outputSchema!,
      instructions,
      sourceExperienceIDs,
      testCases: [{ id: testID, input: testInput!, expected: testExpected! }],
      policyVersion,
    },
  }
}
