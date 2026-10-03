/**
 * Deterministic recovery planning.
 *
 * The planner returns one of a finite set of recovery operations. It never
 * executes an operation and never treats a model suggestion as eligibility.
 * Eligibility is derived only from the immutable action contract and durable
 * observation/lease facts supplied by the caller.
 */

export type RecoveryPlanKind =
  | "replay_result"
  | "resume_safe_phase"
  | "reconcile_external_state"
  | "compensate"
  | "pause_for_manual"
  | "fail_terminal"

export type ExternalState = "known_success" | "known_failure" | "unknown" | "not_applicable"

export interface RecoveryContract {
  readonly actionKind: string
  readonly actionVersion: string
  readonly safeResumePhases: ReadonlyArray<string>
  readonly canReplayResult: boolean
  readonly canReconcileExternalState: boolean
  readonly compensation: "available" | "unavailable"
}

export interface RecoveryInput {
  readonly actionKind: string
  readonly actionVersion: string
  readonly phase: string
  readonly leaseExpired: boolean
  readonly hasIntentDigest: boolean
  readonly observationStatus?: "succeeded" | "failed" | "interrupted"
  readonly verifierPassed?: boolean
  readonly externalState: ExternalState
  readonly modelSuggestion?: RecoveryPlanKind
}

export interface RecoveryPlan {
  readonly kind: RecoveryPlanKind
  readonly eligible: boolean
  readonly deterministic: true
  readonly reason: string
  readonly actionKind: string
  readonly actionVersion: string
  readonly modelSuggestion?: RecoveryPlanKind
}

export class RecoveryPlannerError extends Error {
  constructor(
    readonly code: "INVALID_CONTRACT" | "DUPLICATE" | "NOT_FOUND",
    message: string,
  ) {
    super(message)
    this.name = "RecoveryPlannerError"
  }
}

const key = (actionKind: string, actionVersion: string) => `${actionKind}@${actionVersion}`

const validateContract = (contract: RecoveryContract) => {
  if (!contract.actionKind.trim() || !contract.actionVersion.trim())
    throw new RecoveryPlannerError("INVALID_CONTRACT", "recovery action kind and version are required")
  if (contract.safeResumePhases.some((phase) => !phase.trim()))
    throw new RecoveryPlannerError("INVALID_CONTRACT", "safe resume phases must be non-empty")
}

export class RecoveryContractRegistry {
  private readonly contracts = new Map<string, RecoveryContract>()

  register(contract: RecoveryContract): this {
    validateContract(contract)
    const contractKey = key(contract.actionKind, contract.actionVersion)
    if (this.contracts.has(contractKey))
      throw new RecoveryPlannerError("DUPLICATE", `recovery contract already registered: ${contractKey}`)
    this.contracts.set(
      contractKey,
      Object.freeze({ ...contract, safeResumePhases: Object.freeze([...contract.safeResumePhases]) }),
    )
    return this
  }

  get(actionKind: string, actionVersion: string): RecoveryContract | undefined {
    return this.contracts.get(key(actionKind, actionVersion))
  }

  list(): ReadonlyArray<RecoveryContract> {
    return Object.freeze([...this.contracts.values()])
  }
}

const plan = (input: RecoveryInput, kind: RecoveryPlanKind, eligible: boolean, reason: string): RecoveryPlan => ({
  kind,
  eligible,
  deterministic: true,
  reason,
  actionKind: input.actionKind,
  actionVersion: input.actionVersion,
  ...(input.modelSuggestion ? { modelSuggestion: input.modelSuggestion } : {}),
})

export class RecoveryPlanner {
  constructor(readonly contracts: RecoveryContractRegistry) {}

  decide(input: RecoveryInput): RecoveryPlan {
    const contract = this.contracts.get(input.actionKind, input.actionVersion)
    if (!contract)
      throw new RecoveryPlannerError(
        "NOT_FOUND",
        `no recovery contract registered for ${input.actionKind}@${input.actionVersion}`,
      )

    if (contract.canReplayResult && input.observationStatus === "succeeded" && input.verifierPassed === true)
      return plan(input, "replay_result", true, "durable successful observation has independent verifier evidence")

    if (!input.hasIntentDigest)
      return plan(input, "pause_for_manual", true, "recovery cannot safely resume without the immutable intent digest")

    if (input.externalState === "unknown" && contract.canReconcileExternalState)
      return plan(
        input,
        "reconcile_external_state",
        true,
        "external state is unknown and the action contract provides reconciliation",
      )

    if (!input.leaseExpired)
      return plan(
        input,
        "pause_for_manual",
        true,
        "the previous lease is still active; recovery must not compete with its owner",
      )

    if (contract.safeResumePhases.includes(input.phase))
      return plan(
        input,
        "resume_safe_phase",
        true,
        `phase ${input.phase} is explicitly resumable by the action contract`,
      )

    if (
      contract.compensation === "available" &&
      ["failed", "observed", "verifying", "compensating"].includes(input.phase)
    )
      return plan(input, "compensate", true, `phase ${input.phase} permits the registered compensation contract`)

    if (["cancelled", "blocked", "settled"].includes(input.phase))
      return plan(input, "fail_terminal", false, `terminal phase ${input.phase} has no eligible recovery operation`)

    return plan(
      input,
      "pause_for_manual",
      true,
      `phase ${input.phase} is not eligible for deterministic automatic recovery`,
    )
  }
}

export const createDefaultRecoveryContracts = () => {
  const registry = new RecoveryContractRegistry()
  registry
    .register({
      actionKind: "file",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: true,
      canReconcileExternalState: false,
      compensation: "unavailable",
    })
    .register({
      actionKind: "shell",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: true,
      canReconcileExternalState: true,
      compensation: "unavailable",
    })
    .register({
      actionKind: "worktree",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: true,
      canReconcileExternalState: true,
      compensation: "available",
    })
    .register({
      actionKind: "share",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: true,
      canReconcileExternalState: true,
      compensation: "unavailable",
    })
    .register({
      actionKind: "browser",
      actionVersion: "1",
      safeResumePhases: ["authorized"],
      canReplayResult: true,
      canReconcileExternalState: true,
      compensation: "unavailable",
    })
    .register({
      actionKind: "workflow",
      actionVersion: "1",
      safeResumePhases: ["queued", "running"],
      canReplayResult: true,
      canReconcileExternalState: true,
      compensation: "unavailable",
    })
  return registry
}
