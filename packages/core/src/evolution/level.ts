export * as EvolutionLevelV1 from "./level"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"

export type EvolutionOperation =
  | "suggest"
  | "report"
  | "adjust_runtime_parameter"
  | "create_candidate"
  | "offline_evaluate"
  | "run_sandbox"
  | "start_canary"
  | "promote"
  | "modify_core_source"
  | "publish_core"

export type EvolutionCandidateKind = "skill" | "prompt" | "workflow" | "router" | "code"
export type EffectiveCandidateLevel = "L0" | "L2" | "L3" | "L4"

export interface EvolutionLevelClaim {
  readonly level: AgentRuntime.EvolutionLevel
  readonly operation: EvolutionOperation
  readonly target?: string
  readonly candidateKind?: EvolutionCandidateKind
  readonly reversible?: boolean
  readonly securityCritical?: boolean
  readonly isolated?: boolean
  readonly humanApproved?: boolean
  readonly policyApproved?: boolean
  readonly controlled?: boolean
  readonly rollbackReady?: boolean
}

export interface EvolutionLevelDefinition {
  readonly level: AgentRuntime.EvolutionLevel
  readonly capability: string
  readonly operations: ReadonlyArray<EvolutionOperation>
  readonly executable: boolean
}

export class EvolutionLevelViolation extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "EvolutionLevelViolation"
  }
}

const definition = (
  level: AgentRuntime.EvolutionLevel,
  capability: string,
  operations: ReadonlyArray<EvolutionOperation>,
  executable = true,
): EvolutionLevelDefinition =>
  Object.freeze({ level, capability, operations: Object.freeze([...operations]), executable })

const MATRIX: Readonly<Record<AgentRuntime.EvolutionLevel, EvolutionLevelDefinition>> = Object.freeze({
  L0: definition("L0", "inert suggestions and reports", ["suggest", "report"]),
  L1: definition("L1", "reversible non-security runtime parameters", ["adjust_runtime_parameter"]),
  L2: definition("L2", "prompt, workflow, or skill candidate with offline evaluation", [
    "create_candidate",
    "offline_evaluate",
  ]),
  L3: definition("L3", "isolated sandbox or bounded canary", ["run_sandbox", "start_canary"]),
  L4: definition("L4", "approved controlled promotion with immediate rollback", ["promote"]),
  L5: definition(
    "L5",
    "autonomous core source modification or publishing",
    ["modify_core_source", "publish_core"],
    false,
  ),
})

const CANDIDATE_KINDS: ReadonlySet<EvolutionCandidateKind> = new Set(["skill", "prompt", "workflow"])

const reject = (reason: string): never => {
  throw new EvolutionLevelViolation(reason)
}

const requireCandidateKind = (claim: EvolutionLevelClaim): EvolutionCandidateKind => {
  const kind = claim.candidateKind
  if (!kind || !CANDIDATE_KINDS.has(kind))
    return reject("Evolution candidates are limited to prompt, workflow, or skill artifacts")
  return kind
}

const assert = (claim: EvolutionLevelClaim): Readonly<EvolutionLevelClaim> => {
  const policy = MATRIX[claim.level]
  if (!policy.operations.includes(claim.operation))
    return reject(`${claim.operation} is not allowed at Evolution ${claim.level}`)
  if (!policy.executable) return reject("L5 autonomous core source modification and publishing are forbidden")

  switch (claim.level) {
    case "L0":
      break
    case "L1": {
      const target = typeof claim.target === "string" ? claim.target.trim().toLowerCase() : ""
      if (!target.startsWith("runtime.parameter."))
        return reject("L1 may adjust only an explicitly non-security runtime parameter")
      if (claim.securityCritical !== false) return reject("L1 cannot adjust a security-critical parameter")
      if (claim.reversible !== true) return reject("L1 runtime parameter changes must be reversible")
      break
    }
    case "L2":
      requireCandidateKind(claim)
      if (claim.operation === "offline_evaluate" && claim.isolated !== true)
        return reject("L2 candidate evaluation must be offline and isolated")
      break
    case "L3":
      requireCandidateKind(claim)
      if (claim.isolated !== true) return reject("L3 execution must remain isolated")
      if (claim.reversible !== true) return reject("L3 sandbox and canary execution must be reversible")
      break
    case "L4":
      requireCandidateKind(claim)
      if (claim.humanApproved !== true && claim.policyApproved !== true)
        return reject("L4 promotion requires human or policy approval")
      if (claim.controlled !== true) return reject("L4 promotion must use the controlled runtime")
      if (claim.rollbackReady !== true) return reject("L4 promotion requires immediate rollback readiness")
      break
    case "L5":
      return reject("L5 autonomous core source modification and publishing are forbidden")
  }
  return Object.freeze({ ...claim })
}

const STATUS_LEVEL: Readonly<Record<AgentRuntime.EvolutionStatus, EffectiveCandidateLevel>> = Object.freeze({
  signal: "L0",
  proposal: "L2",
  candidate: "L2",
  sandbox_evaluation: "L2",
  rejected: "L2",
  eligible: "L2",
  canary: "L3",
  monitoring: "L3",
  promoted: "L4",
  retained: "L4",
  rolled_back: "L2",
  archived: "L2",
})

const forStatus = (status: AgentRuntime.EvolutionStatus): EffectiveCandidateLevel => STATUS_LEVEL[status]

const cloneDefinition = (value: EvolutionLevelDefinition): EvolutionLevelDefinition =>
  Object.freeze({ ...value, operations: Object.freeze([...value.operations]) })

const publicPolicy = (): Readonly<Record<AgentRuntime.EvolutionLevel, EvolutionLevelDefinition>> =>
  Object.freeze({
    L0: cloneDefinition(MATRIX.L0),
    L1: cloneDefinition(MATRIX.L1),
    L2: cloneDefinition(MATRIX.L2),
    L3: cloneDefinition(MATRIX.L3),
    L4: cloneDefinition(MATRIX.L4),
    L5: cloneDefinition(MATRIX.L5),
  })

export const EvolutionLevels = Object.freeze({
  VERSION: "1.0",
  MATRIX,
  assert,
  forStatus,
  public: publicPolicy,
})
