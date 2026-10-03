/**
 * Independent verifier core logic (executor/verifier separation).
 *
 * The executor produces a result; the verifier independently checks it by
 * running explicit verification commands (tests, type checks, linters,
 * grep-based assertions) and producing a structured pass/fail report that is
 * fed back to the model as evidence. `summarize` and `report` are pure so
 * they are unit-testable without a shell.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { checkpointResumeToken } from "./durable-run"
import * as EvidenceV2 from "../evidence"
import { RuntimeInsight } from "./insight"
import { digest } from "./insight"

export interface VerificationCheckInput {
  readonly command: string
  readonly exitCode: number | null
  readonly output: string
}

export interface VerificationCheck {
  readonly command: string
  readonly ok: boolean
  readonly exitCode: number | null
  readonly outputTail: string
}

export interface VerificationSummary {
  readonly passed: boolean
  readonly total: number
  readonly passedCount: number
  readonly failedChecks: ReadonlyArray<string>
}

export interface DurableSettlementInput {
  readonly runID: string
  readonly checkpoint?: AgentRuntime.Checkpoint
  readonly actions: ReadonlyArray<{
    readonly actionID: string
    readonly status: string
    readonly observationStatus?: string
  }>
  readonly digest: (value: unknown) => string
}

export interface CompletionGateInput extends DurableSettlementInput {
  readonly independentVerifierPassed: boolean
  /** Recorded for diagnostics only; it never makes completion eligible. */
  readonly modelStopReason?: string
}

export interface CompletionGateResult {
  readonly checks: ReadonlyArray<VerificationCheck>
  readonly summary: VerificationSummary
  readonly allowed: boolean
}

export interface VerificationRunInput {
  readonly runID: string
  readonly traceID: string
  readonly sessionID: string
  readonly toolCallID: string
  readonly actionID?: string
  readonly claim: string
  readonly checks: ReadonlyArray<VerificationCheckInput>
}

export interface VerificationRunResult {
  readonly checks: ReadonlyArray<VerificationCheck>
  readonly summary: VerificationSummary
}

export interface FrozenVerifierIntent {
  readonly actionKind: string
  readonly actionVersion: string
  readonly intentDigest: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface VerifierObservation {
  readonly status: "succeeded" | "failed" | "interrupted"
  readonly observationDigest: string
  readonly summary: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface VerifierArtifactRef {
  readonly kind: string
  readonly ref: string
  readonly digest: string
}

export interface VerifierInput {
  readonly frozenIntent: FrozenVerifierIntent
  readonly observation: VerifierObservation
  readonly artifactRefs: ReadonlyArray<VerifierArtifactRef>
  readonly runID?: AgentRuntime.RunID
  readonly actionID?: AgentRuntime.ActionID
  readonly observationID?: AgentRuntime.ObservationID
}

export interface VerifierExecutionContext {
  readonly deadlineAt: number
  readonly credentialScope: "independent"
  readonly signal: AbortSignal
}

export interface VerificationEvidence {
  readonly verifier: { readonly actionKind: string; readonly actionVersion: string }
  readonly evaluation: VerificationSummary
  readonly evidence: AgentRuntime.Evidence
  readonly evidenceDigest: string
}

export interface VerifierRegistration {
  readonly actionKind: string
  readonly actionVersion: string
  readonly readOnly: true
  readonly credentialScope: "independent"
  readonly deadlineMs?: number
  readonly verify: (
    input: VerifierInput,
    context: VerifierExecutionContext,
  ) => Promise<ReadonlyArray<VerificationCheckInput>>
}

export class VerifierRegistryError extends Error {
  constructor(
    readonly code:
      | "INVALID_REGISTRATION"
      | "INVALID_BINDING"
      | "DUPLICATE"
      | "NOT_FOUND"
      | "INPUT_NOT_FROZEN"
      | "DEADLINE_EXCEEDED",
    message: string,
  ) {
    super(message)
    this.name = "VerifierRegistryError"
  }
}

const MAX_TAIL = 600
const DEFAULT_VERIFIER_DEADLINE_MS = 5_000

const registryKey = (actionKind: string, actionVersion: string) => `${actionKind}@${actionVersion}`

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key))
  }
  return value
}

export const freezeVerifierInput = (input: VerifierInput): VerifierInput => deepFreeze(input)

const validRegistration = (registration: VerifierRegistration) => {
  if (!registration.actionKind.trim() || !registration.actionVersion.trim())
    throw new VerifierRegistryError("INVALID_REGISTRATION", "verifier action kind and version are required")
  if (!registration.readOnly || registration.credentialScope !== "independent")
    throw new VerifierRegistryError("INVALID_REGISTRATION", "verifiers must be read-only with independent credentials")
  if (
    registration.deadlineMs !== undefined &&
    (!Number.isSafeInteger(registration.deadlineMs) || registration.deadlineMs < 1)
  )
    throw new VerifierRegistryError("INVALID_REGISTRATION", "verifier deadline must be a positive integer")
  if (typeof registration.verify !== "function")
    throw new VerifierRegistryError("INVALID_REGISTRATION", "verifier implementation is required")
  if (Object.hasOwn(registration, "mutationExecutor"))
    throw new VerifierRegistryError("INVALID_REGISTRATION", "verifiers cannot receive a mutation executor")
}

const assertFrozenInput = (input: VerifierInput) => {
  if (
    !Object.isFrozen(input) ||
    !Object.isFrozen(input.frozenIntent) ||
    !Object.isFrozen(input.frozenIntent.payload) ||
    !Object.isFrozen(input.observation) ||
    !Object.isFrozen(input.observation.values) ||
    !Object.isFrozen(input.artifactRefs)
  )
    throw new VerifierRegistryError("INPUT_NOT_FROZEN", "verifier input must be frozen before verification")
}

const abortError = (actionKind: string) =>
  new VerifierRegistryError("DEADLINE_EXCEEDED", `verifier deadline exceeded: ${actionKind}`)

export class VerifierRegistry {
  private readonly registrations = new Map<string, VerifierRegistration>()

  register(registration: VerifierRegistration): this {
    validRegistration(registration)
    const key = registryKey(registration.actionKind, registration.actionVersion)
    if (this.registrations.has(key)) throw new VerifierRegistryError("DUPLICATE", `verifier already registered: ${key}`)
    this.registrations.set(key, Object.freeze({ ...registration }))
    return this
  }

  get(actionKind: string, actionVersion: string): VerifierRegistration | undefined {
    return this.registrations.get(registryKey(actionKind, actionVersion))
  }

  list(): ReadonlyArray<VerifierRegistration> {
    return Object.freeze([...this.registrations.values()])
  }

  async verify(input: VerifierInput): Promise<VerificationEvidence> {
    assertFrozenInput(input)
    const durableReferences = [input.runID, input.actionID, input.observationID]
    if (
      durableReferences.some((value) => value !== undefined) &&
      durableReferences.some((value) => value === undefined)
    )
      throw new VerifierRegistryError(
        "INVALID_BINDING",
        "durable verifier Evidence requires Run, Action, and Observation references together",
      )
    const registration = this.get(input.frozenIntent.actionKind, input.frozenIntent.actionVersion)
    if (!registration)
      throw new VerifierRegistryError(
        "NOT_FOUND",
        `no verifier registered for ${input.frozenIntent.actionKind}@${input.frozenIntent.actionVersion}`,
      )
    const deadlineMs = registration.deadlineMs ?? DEFAULT_VERIFIER_DEADLINE_MS
    const controller = new AbortController()
    const deadlineAt = Date.now() + deadlineMs
    const timeout = setTimeout(() => controller.abort(), deadlineMs)
    try {
      const checks = await Promise.race([
        registration.verify(input, {
          deadlineAt,
          credentialScope: "independent",
          signal: controller.signal,
        }),
        new Promise<ReadonlyArray<VerificationCheckInput>>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(abortError(registration.actionKind)), { once: true })
        }),
      ])
      const normalized = runChecks(checks)
      const summary = summarize(normalized)
      const evidenceDigest = digest({
        verifier: registryKey(registration.actionKind, registration.actionVersion),
        intent: input.frozenIntent,
        observation: input.observation,
        artifacts: input.artifactRefs,
        checks: normalized,
        summary,
      })
      const evidence = EvidenceV2.create({
        sourceID: `verifier:${registration.actionKind}:${registration.actionVersion}`,
        contentDigest: evidenceDigest,
        ...(input.artifactRefs[0]
          ? { artifactDigest: input.artifactRefs[0].digest, artifactRef: input.artifactRefs[0].ref }
          : {}),
        extractionMethod: "verifier-registry",
        extractionVersion: registration.actionVersion,
        ...(input.runID ? { runID: input.runID } : {}),
        ...(input.actionID ? { actionID: input.actionID } : {}),
        ...(input.observationID ? { observationIDs: [input.observationID] } : {}),
        trust: summary.passed ? "verified" : "untrusted",
        instructionAllowed: false,
        sensitivity: "internal",
        summary: `${registration.actionKind}@${registration.actionVersion}: ${summary.passed ? "passed" : "failed"} (${summary.passedCount}/${summary.total})`,
        verificationStatus: summary.passed ? "verified" : "rejected",
      })
      return {
        verifier: { actionKind: registration.actionKind, actionVersion: registration.actionVersion },
        evaluation: summary,
        evidence,
        evidenceDigest,
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }
}

const observationCheck = (kind: string, input: VerifierInput): VerificationCheckInput => ({
  command: `${kind} observation status`,
  exitCode: input.observation.status === "succeeded" ? 0 : 1,
  output: input.observation.summary,
})

const valueCheck = (command: string, value: unknown, output: string): VerificationCheckInput => ({
  command,
  exitCode: value === undefined || value === null || value === "" ? 1 : 0,
  output,
})

export const createDefaultVerifierRegistry = () => {
  const registry = new VerifierRegistry()
  const register = (actionKind: string, verify: VerifierRegistration["verify"]) =>
    registry.register({ actionKind, actionVersion: "1", readOnly: true, credentialScope: "independent", verify })
  register("file", async (input) => [
    observationCheck("file", input),
    valueCheck("file path", input.observation.values.path, "file path observed"),
    valueCheck("file hash", input.observation.values.hash, "file hash observed"),
    valueCheck("file mode", input.observation.values.mode, "file mode observed"),
  ])
  register("shell", async (input) => [
    observationCheck("shell", input),
    {
      command: "shell exit code",
      exitCode: input.observation.values.exitCode === 0 ? 0 : 1,
      output: "declared shell exit code",
    },
  ])
  register("worktree", async (input) => [
    observationCheck("worktree", input),
    valueCheck("worktree HEAD", input.observation.values.head, "worktree HEAD observed"),
    valueCheck("worktree status", input.observation.values.status, "worktree status observed"),
    valueCheck("worktree registry", input.observation.values.registry, "worktree registry observed"),
  ])
  register("share", async (input) => [
    observationCheck("share", input),
    valueCheck("share provider lookup", input.observation.values.providerLookupDigest, "provider lookup observed"),
    valueCheck("share digest", input.observation.values.digest, "share digest observed"),
    valueCheck("share visibility", input.observation.values.visibility, "share visibility observed"),
  ])
  register("browser", async (input) => [
    observationCheck("browser", input),
    valueCheck("browser target state", input.observation.values.targetState, "browser target state observed"),
  ])
  register("workflow", async (input) => [
    observationCheck("workflow", input),
    {
      command: "workflow required steps settled",
      exitCode: input.observation.values.requiredStepsSettled === true ? 0 : 1,
      output: "required workflow steps",
    },
    {
      command: "workflow actions settled",
      exitCode: input.observation.values.actionsSettled === true ? 0 : 1,
      output: "workflow actions",
    },
  ])
  return registry
}

export function runChecks(checks: ReadonlyArray<VerificationCheckInput>): ReadonlyArray<VerificationCheck> {
  return checks.map((check) => ({
    command: check.command,
    ok: check.exitCode === 0,
    exitCode: check.exitCode,
    outputTail: check.output.slice(-MAX_TAIL),
  }))
}

export function summarize(checks: ReadonlyArray<VerificationCheck>): VerificationSummary {
  const passedCount = checks.filter((check) => check.ok).length
  return {
    passed: checks.length > 0 && passedCount === checks.length,
    total: checks.length,
    passedCount,
    failedChecks: checks.filter((check) => !check.ok).map((check) => check.command),
  }
}

/**
 * Effectful verifier boundary used by evaluation and replay callers.
 * The check logic remains pure; this boundary owns the trace/Insight join.
 */
export function verify(input: VerificationRunInput): Effect.Effect<VerificationRunResult> {
  const startedAt = Date.now()
  return Effect.sync(() => {
    const checks = runChecks(input.checks)
    return { checks, summary: summarize(checks) }
  }).pipe(
    Effect.tap(({ checks, summary }) =>
      Effect.sync(() =>
        RuntimeInsight.recordVerification({
          timestamp: Date.now(),
          runID: input.runID,
          traceID: input.traceID,
          ...(input.actionID ? { actionID: input.actionID } : {}),
          sessionID: input.sessionID,
          toolCallID: input.toolCallID,
          claim: input.claim,
          commands: checks.map((check) => check.command),
          results: checks,
          passed: summary.passed,
          durationMs: Math.max(0, Date.now() - startedAt),
        }),
      ),
    ),
    Effect.withSpan("Arforge.Verifier", {
      attributes: {
        "arforge.run_id": input.runID,
        "arforge.trace_id": input.traceID,
        "arforge.session_id": input.sessionID,
        "arforge.tool_call_id": input.toolCallID,
        "arforge.action_id": input.actionID ?? "",
        "arforge.check_count": input.checks.length,
      },
    }),
  )
}

export function verificationReport(summary: VerificationSummary): string {
  const lines = ["## 验证报告（独立 Verifier）", `通过 ${summary.passedCount}/${summary.total}`]
  if (summary.passed) {
    lines.push("结论：PASSED — 全部验证项通过。")
  } else {
    lines.push("结论：FAILED — 以下验证项未通过：")
    for (const command of summary.failedChecks) lines.push(`- \`${command}\``)
    lines.push("在继续任务之前，必须修复验证失败项或说明其不适用。")
  }
  return lines.join("\n")
}

/** Independent durable invariants required before a Run may complete. */
export function durableSettlementChecks(input: DurableSettlementInput): ReadonlyArray<VerificationCheck> {
  const checkpointDigest = input.checkpoint ? input.digest(input.checkpoint.state) : undefined
  const expectedResumeToken = input.checkpoint ? checkpointResumeToken(input.checkpoint) : undefined
  const checkpointValid =
    input.checkpoint !== undefined &&
    input.checkpoint.runID === input.runID &&
    checkpointDigest === input.checkpoint.stateDigest &&
    expectedResumeToken === input.checkpoint.resumeToken
  const unsettled = input.actions.filter(
    (action) => action.status !== "settled" || action.observationStatus !== "succeeded",
  )
  return runChecks([
    {
      command: "恢复点完整性",
      exitCode: checkpointValid ? 0 : 1,
      output: checkpointValid ? "恢复状态摘要与继续令牌一致" : "缺少恢复点，或恢复状态摘要/继续令牌不一致",
    },
    {
      command: "副作用动作结算",
      exitCode: unsettled.length === 0 ? 0 : 1,
      output:
        unsettled.length === 0
          ? `${input.actions.length} 个动作均已持久观察并结算`
          : `未结算动作：${unsettled.map((action) => `${action.actionID}:${action.status}/${action.observationStatus ?? "missing"}`).join(", ")}`,
    },
  ])
}

/** Completion is a verifier decision; provider/model stop reasons are non-authoritative hints. */
export function completionGate(input: CompletionGateInput): CompletionGateResult {
  const checks = [
    ...durableSettlementChecks(input),
    ...runChecks([
      {
        command: "独立 verifier 结论",
        exitCode: input.independentVerifierPassed ? 0 : 1,
        output: input.independentVerifierPassed ? "独立 verifier 通过" : "独立 verifier 未通过",
      },
    ]),
  ]
  const summary = summarize(checks)
  return { checks, summary, allowed: summary.passed }
}
