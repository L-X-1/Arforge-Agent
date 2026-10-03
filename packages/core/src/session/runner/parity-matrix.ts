import * as Parity from "./parity"
import { canonicalHash } from "../../util/canonical-hash"

/**
 * Scenarios that must be replayed through both the formal runner and the
 * mature prompt adapter before a default-runner switch is considered safe.
 *
 * The matrix is deliberately semantic: request IDs, action IDs, prompt text,
 * tool payloads and provider output are not part of the evidence. This keeps
 * the contract useful for recorded cassettes without making a cassette a
 * second source of truth or leaking user data into a parity report.
 */
export const requiredScenarios = [
  "queue",
  "steer",
  "cancel",
  "compaction",
  "structured-output",
  "action-replay",
] as const

export type Scenario = (typeof requiredScenarios)[number]

export type BudgetEvidence = Readonly<{
  readonly attemptsUsed: number
  readonly maxAttempts: number
  readonly durationMsUsed: number
  readonly maxDurationMs: number
  readonly costMicrosUsed: number
  readonly maxCostMicros: number
  readonly tokensUsed: number
  readonly maxTokens: number
}>

/** Metadata-only runtime evidence required before a default-root switch. */
export type ExecutionEvidence = Readonly<{
  readonly checkpoint: Readonly<Parity.CheckpointSummary & { readonly digest: string }>
  readonly budget: BudgetEvidence
}>

/** Metadata-only request identity shared by formal and mature adapters. */
export type RequestProjection = Readonly<{
  readonly schemaVersion: 1
  readonly runID: string
  readonly turnStep: number
  readonly attempt: number
  readonly requestDigest: string
  readonly contextDigest: string
  readonly toolSetRevision: string
  readonly routeConfigRevision: string
  /** Optional identity of the Skill snapshot used to assemble the request. */
  readonly skillSnapshotDigest?: string
  readonly compilerRevision: string
}>

export const requestProjectionFields = [
  "runID",
  "turnStep",
  "attempt",
  "requestDigest",
  "contextDigest",
  "toolSetRevision",
  "routeConfigRevision",
  "skillSnapshotDigest",
  "compilerRevision",
] as const

/** Return stable metadata field names that differ between two adapters. */
export const compareRequestProjection = (
  baseline: RequestProjection,
  candidate: RequestProjection,
): ReadonlyArray<(typeof requestProjectionFields)[number]> =>
  requestProjectionFields.filter((field) => baseline[field] !== candidate[field])

const normalizedCheckpoint = (checkpoint: Parity.CheckpointSummary): Parity.CheckpointSummary => ({
  phase: checkpoint.phase,
  needsContinuation: checkpoint.needsContinuation,
  ...(checkpoint.nextStep === undefined ? {} : { nextStep: checkpoint.nextStep }),
})

/** Digest the semantic checkpoint fields without including the digest itself. */
export const checkpointDigest = (checkpoint: Parity.CheckpointSummary): string => {
  const digest = canonicalHash(normalizedCheckpoint(checkpoint))
  if (!digest) throw new Error("session runner checkpoint is not canonicalizable")
  return digest
}

/** Create immutable, self-consistent metadata-only switch evidence. */
export const makeExecutionEvidence = (input: {
  readonly checkpoint: Parity.CheckpointSummary
  readonly budget: BudgetEvidence
}): ExecutionEvidence => {
  const checkpoint = normalizedCheckpoint(input.checkpoint)
  return Object.freeze({
    checkpoint: Object.freeze({ ...checkpoint, digest: checkpointDigest(checkpoint) }),
    budget: Object.freeze({ ...input.budget }),
  })
}

export type Entry = Readonly<{
  readonly scenario: Scenario
  readonly provider: Parity.SemanticExecutionTrace
  readonly formal: Parity.SemanticExecutionTrace
  readonly mature: Parity.SemanticExecutionTrace
  readonly evidence?: Readonly<{
    readonly provider: ExecutionEvidence
    readonly formal: ExecutionEvidence
    readonly mature: ExecutionEvidence
  }>
  /** Optional request metadata gate, kept separate from execution evidence for backward compatibility. */
  readonly requestProjections?: Readonly<{
    readonly provider: RequestProjection
    readonly formal: RequestProjection
    readonly mature: RequestProjection
  }>
  /**
   * Exact prepared HTTP request digests from the shared recorded transport.
   * When present, independent real runs may retain owner-specific run IDs and
   * compiler revisions while the gate still proves that provider bytes were
   * identical. Without this proof the legacy all-field projection comparison
   * remains fail-closed.
   */
  readonly transportRequestDigests?: Readonly<{
    readonly provider: string
    readonly formal: string
    readonly mature: string
  }>
}>

export type Comparison = Readonly<{
  readonly scenario: Scenario
  readonly formal: Parity.ParityComparison
  readonly mature: Parity.ParityComparison
}>

export type Result = Readonly<{
  readonly complete: boolean
  readonly missing: ReadonlyArray<Scenario>
  readonly duplicate: ReadonlyArray<Scenario>
  readonly unknown: ReadonlyArray<string>
  readonly comparisons: ReadonlyArray<Comparison>
  readonly evidenceMissing: ReadonlyArray<Scenario>
  readonly requestProjectionMissing: ReadonlyArray<Scenario>
  readonly differences: ReadonlyArray<string>
}>

const required = new Set<string>(requiredScenarios)

const adapterMismatch = (scenario: string, side: string, actual: string, expected: string) =>
  `${scenario}: ${side} adapter must be ${expected}, received ${actual}`

const evidenceDigest = /^[0-9a-f]{64}$/

/**
 * Validate the metadata-only request identity once for both the live runtime
 * invariant and the parity matrix. The returned reasons intentionally contain
 * field names only; no request body or provider payload can enter diagnostics.
 */
export const requestProjectionErrors = (projection: unknown): ReadonlyArray<string> => {
  const value =
    projection !== null && typeof projection === "object" && !Array.isArray(projection)
      ? (projection as Partial<RequestProjection>)
      : undefined
  const errors: string[] = []
  if (value?.schemaVersion !== 1) errors.push("schemaVersion is invalid")
  if (typeof value?.runID !== "string" || value.runID.length === 0 || Buffer.byteLength(value.runID, "utf8") > 256)
    errors.push("runID is invalid")
  for (const field of ["turnStep", "attempt"] as const) {
    const numberValue = value?.[field]
    if (typeof numberValue !== "number" || !Number.isSafeInteger(numberValue) || numberValue < 1)
      errors.push(`${field} is invalid`)
  }
  for (const field of ["requestDigest", "contextDigest", "toolSetRevision", "routeConfigRevision"] as const) {
    const digestValue = value?.[field]
    if (typeof digestValue !== "string" || !evidenceDigest.test(digestValue))
      errors.push(`${field} is not a sha256 hex digest`)
  }
  if (
    value?.skillSnapshotDigest !== undefined &&
    (typeof value.skillSnapshotDigest !== "string" || !evidenceDigest.test(value.skillSnapshotDigest))
  )
    errors.push("skillSnapshotDigest is not a sha256 hex digest")
  if (
    typeof value?.compilerRevision !== "string" ||
    value.compilerRevision.length === 0 ||
    value.compilerRevision.length > 128
  )
    errors.push("compilerRevision is invalid")
  return errors
}

const validateRequestProjection = (scenario: string, side: string, projection: unknown, differences: string[]) => {
  for (const error of requestProjectionErrors(projection))
    differences.push(`${scenario}: ${side} request projection ${error}`)
}

const projectionRecord = (value: unknown): value is RequestProjection => value !== null && typeof value === "object"

const validateTransportDigest = (scenario: string, side: string, value: unknown, differences: string[]) => {
  if (typeof value !== "string" || !evidenceDigest.test(value))
    differences.push(`${scenario}: ${side} transport request digest is not a sha256 hex digest`)
}

const evidenceNumber = (value: unknown, field: string, scenario: string, side: string, differences: string[]) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    differences.push(`${scenario}: ${side} evidence ${field} must be a non-negative safe integer`)
}

const validateEvidence = (
  scenario: string,
  side: string,
  input: unknown,
  differences: string[],
): input is ExecutionEvidence => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    differences.push(`${scenario}: ${side} evidence is invalid`)
    return false
  }
  const evidence = input as Partial<ExecutionEvidence>
  if (evidence.checkpoint === undefined || evidence.checkpoint === null || typeof evidence.checkpoint !== "object") {
    differences.push(`${scenario}: ${side} evidence checkpoint is invalid`)
    return false
  }
  if (evidence.budget === undefined || evidence.budget === null || typeof evidence.budget !== "object") {
    differences.push(`${scenario}: ${side} evidence budget is invalid`)
    return false
  }
  const checkpoint = evidence.checkpoint as Partial<ExecutionEvidence["checkpoint"]>
  if (typeof checkpoint.digest !== "string" || !evidenceDigest.test(checkpoint.digest))
    differences.push(`${scenario}: ${side} evidence checkpoint digest is not a sha256 hex digest`)
  else {
    try {
      if (checkpoint.digest !== checkpointDigest(checkpoint as Parity.CheckpointSummary & { readonly digest: string }))
        differences.push(`${scenario}: ${side} evidence checkpoint digest does not match checkpoint fields`)
    } catch {
      differences.push(`${scenario}: ${side} evidence checkpoint fields are not canonicalizable`)
    }
  }
  if (checkpoint.phase !== "continuation" && checkpoint.phase !== "idle" && checkpoint.phase !== "mature-session-loop")
    differences.push(`${scenario}: ${side} evidence checkpoint phase is invalid`)
  if (typeof checkpoint.needsContinuation !== "boolean")
    differences.push(`${scenario}: ${side} evidence checkpoint needsContinuation must be boolean`)
  if (checkpoint.nextStep !== undefined && (!Number.isSafeInteger(checkpoint.nextStep) || checkpoint.nextStep < 1))
    differences.push(`${scenario}: ${side} evidence checkpoint nextStep must be a positive safe integer`)

  const budget = evidence.budget as BudgetEvidence
  const budgetFields = [
    "attemptsUsed",
    "maxAttempts",
    "durationMsUsed",
    "maxDurationMs",
    "costMicrosUsed",
    "maxCostMicros",
    "tokensUsed",
    "maxTokens",
  ] as const
  for (const field of budgetFields) evidenceNumber(budget[field], `budget.${field}`, scenario, side, differences)
  if (
    typeof budget.attemptsUsed === "number" &&
    typeof budget.maxAttempts === "number" &&
    budget.attemptsUsed > budget.maxAttempts
  )
    differences.push(`${scenario}: ${side} evidence budget attemptsUsed exceeds maxAttempts`)
  if (
    typeof budget.durationMsUsed === "number" &&
    typeof budget.maxDurationMs === "number" &&
    budget.durationMsUsed > budget.maxDurationMs
  )
    differences.push(`${scenario}: ${side} evidence budget durationMsUsed exceeds maxDurationMs`)
  if (
    typeof budget.costMicrosUsed === "number" &&
    typeof budget.maxCostMicros === "number" &&
    budget.costMicrosUsed > budget.maxCostMicros
  )
    differences.push(`${scenario}: ${side} evidence budget costMicrosUsed exceeds maxCostMicros`)
  if (
    typeof budget.tokensUsed === "number" &&
    typeof budget.maxTokens === "number" &&
    budget.tokensUsed > budget.maxTokens
  )
    differences.push(`${scenario}: ${side} evidence budget tokensUsed exceeds maxTokens`)
  return true
}

const compareEvidence = (
  scenario: string,
  baseline: ExecutionEvidence,
  candidate: ExecutionEvidence,
  side: string,
  differences: string[],
) => {
  // A mature checkpoint retains its storage-owner phase so recovery can
  // decode it without guessing.  For cross-runtime behavior, however, a
  // settled mature loop is the same semantic cursor as Core `idle`, while a
  // resumable mature loop is `continuation`. Compare that canonical meaning
  // rather than the owner-specific persisted tag/digest.
  const semanticCheckpoint = (checkpoint: ExecutionEvidence["checkpoint"]): Parity.CheckpointSummary => ({
    phase:
      checkpoint.phase === "mature-session-loop"
        ? checkpoint.needsContinuation
          ? "continuation"
          : "idle"
        : checkpoint.phase,
    ...(checkpoint.nextStep === undefined ? {} : { nextStep: checkpoint.nextStep }),
    needsContinuation: checkpoint.needsContinuation,
  })
  const baselineCheckpoint = semanticCheckpoint(baseline.checkpoint)
  const candidateCheckpoint = semanticCheckpoint(candidate.checkpoint)
  for (const field of ["phase", "nextStep", "needsContinuation"] as const) {
    if (baselineCheckpoint[field] !== candidateCheckpoint[field])
      differences.push(`${scenario}: provider/${side} evidence checkpoint.${field}`)
  }
  if (checkpointDigest(baselineCheckpoint) !== checkpointDigest(candidateCheckpoint))
    differences.push(`${scenario}: provider/${side} evidence checkpoint.digest`)
  const budgetFields: ReadonlyArray<keyof BudgetEvidence> = [
    "attemptsUsed",
    "maxAttempts",
    "maxDurationMs",
    "costMicrosUsed",
    "maxCostMicros",
    "tokensUsed",
    "maxTokens",
  ]
  // Wall-clock duration is validated against each run's hard maximum above,
  // but two independent replays cannot be required to consume the same
  // milliseconds. Deterministic parity covers decisions, attempts, tokens,
  // cost, and limits—not scheduler timing.
  for (const field of budgetFields) {
    if (baseline.budget[field] !== candidate.budget[field])
      differences.push(`${scenario}: provider/${side} evidence budget.${field}`)
  }
}

export type EvaluateOptions = Readonly<{
  /** Require per-adapter checkpoint and budget evidence for the switch gate. */
  readonly requireEvidence?: boolean
  /** Require the metadata-only request projection on every required scenario. */
  readonly requireRequestProjections?: boolean
}>

/**
 * Evaluate a recorded parity matrix without throwing. Callers can persist the
 * returned metadata as evidence, while CI/acceptance gates can use
 * `assertComplete` for a fail-closed decision.
 */
export const evaluate = (entries: ReadonlyArray<Entry>, options: EvaluateOptions = {}): Result => {
  const counts = new Map<string, number>()
  const unknown = new Set<string>()
  const comparisons: Comparison[] = []
  const evidenceMissing = new Set<Scenario>()
  const requestProjectionMissing = new Set<Scenario>()
  const differences: string[] = []

  for (const entry of entries) {
    const scenario = String(entry.scenario)
    counts.set(scenario, (counts.get(scenario) ?? 0) + 1)
    if (!required.has(scenario)) {
      unknown.add(scenario)
      continue
    }

    if (entry.provider.adapter !== "provider-replay")
      differences.push(adapterMismatch(scenario, "provider", entry.provider.adapter, "provider-replay"))
    if (entry.formal.adapter !== "formal-runner")
      differences.push(adapterMismatch(scenario, "formal", entry.formal.adapter, "formal-runner"))
    if (entry.mature.adapter !== "mature-prompt")
      differences.push(adapterMismatch(scenario, "mature", entry.mature.adapter, "mature-prompt"))

    const formal = Parity.compare(entry.provider, entry.formal)
    const mature = Parity.compare(entry.provider, entry.mature)
    comparisons.push({ scenario: entry.scenario, formal, mature })
    for (const field of formal.differences) differences.push(`${scenario}: provider/formal ${field}`)
    for (const field of mature.differences) differences.push(`${scenario}: provider/mature ${field}`)

    if (entry.requestProjections) {
      const projections = entry.requestProjections
      validateRequestProjection(scenario, "provider", projections.provider, differences)
      validateRequestProjection(scenario, "formal", projections.formal, differences)
      validateRequestProjection(scenario, "mature", projections.mature, differences)
      const transport = entry.transportRequestDigests
      if (transport) {
        validateTransportDigest(scenario, "provider", transport.provider, differences)
        validateTransportDigest(scenario, "formal", transport.formal, differences)
        validateTransportDigest(scenario, "mature", transport.mature, differences)
        if (transport.provider !== transport.formal)
          differences.push(`${scenario}: provider/formal transport request.digest`)
        if (transport.provider !== transport.mature)
          differences.push(`${scenario}: provider/mature transport request.digest`)
        // Independent full-loop replays intentionally allocate different run
        // IDs and may still persist owner-specific compiler provenance. Exact
        // transport identity owns request equivalence here; cursor identity
        // must nevertheless agree.
        if (projectionRecord(projections.provider) && projectionRecord(projections.formal)) {
          for (const field of ["turnStep", "attempt"] as const)
            if (projections.provider[field] !== projections.formal[field])
              differences.push(`${scenario}: provider/formal request.${field}`)
        }
        if (projectionRecord(projections.provider) && projectionRecord(projections.mature)) {
          for (const field of ["turnStep", "attempt"] as const)
            if (projections.provider[field] !== projections.mature[field])
              differences.push(`${scenario}: provider/mature request.${field}`)
        }
      } else {
        if (projectionRecord(projections.provider) && projectionRecord(projections.formal)) {
          for (const field of compareRequestProjection(projections.provider, projections.formal))
            differences.push(`${scenario}: provider/formal request.${field}`)
        }
        if (projectionRecord(projections.provider) && projectionRecord(projections.mature)) {
          for (const field of compareRequestProjection(projections.provider, projections.mature))
            differences.push(`${scenario}: provider/mature request.${field}`)
        }
      }
    } else if (options.requireRequestProjections) {
      requestProjectionMissing.add(entry.scenario)
    }

    if (options.requireEvidence) {
      if (!entry.evidence) {
        evidenceMissing.add(entry.scenario)
      } else {
        const providerValid = validateEvidence(scenario, "provider", entry.evidence.provider, differences)
        const formalValid = validateEvidence(scenario, "formal", entry.evidence.formal, differences)
        const matureValid = validateEvidence(scenario, "mature", entry.evidence.mature, differences)
        if (providerValid && formalValid)
          compareEvidence(scenario, entry.evidence.provider, entry.evidence.formal, "formal", differences)
        if (providerValid && matureValid)
          compareEvidence(scenario, entry.evidence.provider, entry.evidence.mature, "mature", differences)
      }
    }
  }

  const missing = requiredScenarios.filter((scenario) => !counts.has(scenario))
  const duplicate = requiredScenarios.filter((scenario) => (counts.get(scenario) ?? 0) > 1)
  const allDifferences = [...new Set(differences)]

  const missingEvidence = requiredScenarios.filter((scenario) => evidenceMissing.has(scenario))
  const missingRequestProjections = requiredScenarios.filter((scenario) => requestProjectionMissing.has(scenario))

  return {
    complete:
      missing.length === 0 &&
      duplicate.length === 0 &&
      unknown.size === 0 &&
      missingEvidence.length === 0 &&
      missingRequestProjections.length === 0 &&
      allDifferences.length === 0,
    missing,
    duplicate,
    unknown: [...unknown].sort(),
    comparisons,
    evidenceMissing: missingEvidence,
    requestProjectionMissing: missingRequestProjections,
    differences: allDifferences,
  }
}

/**
 * Fail closed when the matrix is incomplete or either adapter diverges from
 * the provider replay. The returned result is stable evidence for test logs.
 */
export const assertComplete = (entries: ReadonlyArray<Entry>, options: EvaluateOptions = {}): Result => {
  const result = evaluate(entries, options)
  if (!result.complete) {
    const details = [
      result.missing.length > 0 ? `missing=${result.missing.join(",")}` : undefined,
      result.duplicate.length > 0 ? `duplicate=${result.duplicate.join(",")}` : undefined,
      result.unknown.length > 0 ? `unknown=${result.unknown.join(",")}` : undefined,
      result.evidenceMissing.length > 0 ? `evidenceMissing=${result.evidenceMissing.join(",")}` : undefined,
      result.requestProjectionMissing.length > 0
        ? `requestProjectionMissing=${result.requestProjectionMissing.join(",")}`
        : undefined,
      result.differences.length > 0 ? `differences=${result.differences.join(";")}` : undefined,
    ].filter((value): value is string => value !== undefined)
    throw new Error(`SessionRunner parity matrix is incomplete: ${details.join(" | ")}`)
  }
  return result
}
