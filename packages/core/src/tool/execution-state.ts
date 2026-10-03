import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import type { Snapshot } from "../runtime/durable-action"
import * as MutationIntentRuntime from "../runtime/mutation-intent"

/**
 * Semantic projection of a durable tool action.
 *
 * DurableAction remains the only authority for the action lifecycle. This
 * projection deliberately contains no persistence or transition logic: it
 * translates the existing action/attempt/observation evidence into the
 * language used by the Agent Loop and recovery UX.
 */
export type ToolExecutionState =
  | "not_started"
  | "prepared"
  | "dispatched"
  | "observed"
  | "settled"
  | "outcome_unknown"
  | "blocked"
  | "cancelled"

export type ProjectionMode = "live" | "recovery"

export type RepairSource = "none" | "durable-action" | "action-gateway-recovery"

/** Canonical tool-result message emitted after an explicit run interruption. */
export const interruptedErrorMessage = "Tool execution interrupted"

export type RepairProvenance = {
  readonly required: boolean
  readonly source: RepairSource
  readonly reason?: string
}

/** Safe manifest view for recovery surfaces; the free-form summary is omitted. */
export type MutationIntentProjection = Readonly<Omit<AgentRuntime.MutationIntent, "summary">>

export type ToolExecutionProjection = {
  readonly actionID: AgentRuntime.ActionID
  readonly actionStatus: AgentRuntime.ActionStatus
  readonly state: ToolExecutionState
  readonly outcome?: AgentRuntime.Observation["status"]
  readonly attempt?: number
  readonly lastSequence: number
  readonly repair: RepairProvenance
  /**
   * The validated, content-free mutation manifest needed by an operator
   * adapter to perform a fresh fingerprint observation. It contains no raw
   * file bytes or tool arguments.
   */
  readonly mutationIntent?: MutationIntentProjection
  /**
   * A content-free mutation recovery classification derived from the same
   * DurableAction snapshot. It is advisory evidence only: a mutation phase is
   * retry-safe only when it is settled together with a durably settled Action.
   */
  readonly mutationRecovery?: MutationIntentRuntime.MutationRecoveryProjection
}

const noRepair = (): RepairProvenance => ({ required: false, source: "none" })

const repair = (reason: string, source: RepairSource = "durable-action"): RepairProvenance => ({
  required: true,
  source,
  reason,
})

const attemptOf = (snapshot: Snapshot) =>
  snapshot.activeAttempt?.attempt ??
  (snapshot.action.budget.attemptsUsed > 0 ? snapshot.action.budget.attemptsUsed : undefined)

const mutationRecoveryOf = (snapshot: Snapshot) =>
  snapshot.mutationIntent === undefined ? undefined : MutationIntentRuntime.projectRecovery(snapshot.mutationIntent)

const mutationIntentProjectionOf = (snapshot: Snapshot): MutationIntentProjection | undefined => {
  if (snapshot.mutationIntent === undefined) return undefined
  const { summary: _summary, ...manifest } = snapshot.mutationIntent
  return manifest
}

const base = (
  snapshot: Snapshot,
  state: ToolExecutionState,
  options: {
    readonly outcome?: AgentRuntime.Observation["status"]
    readonly attempt?: number
    readonly repair: RepairProvenance
  },
): ToolExecutionProjection => {
  const mutationRecovery = mutationRecoveryOf(snapshot)
  const mutationIntent = mutationIntentProjectionOf(snapshot)
  return {
    actionID: snapshot.action.id,
    actionStatus: snapshot.action.status,
    state,
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    lastSequence: snapshot.lastSequence,
    repair: options.repair,
    ...(mutationIntent === undefined ? {} : { mutationIntent }),
    ...(mutationRecovery === undefined ? {} : { mutationRecovery }),
  }
}

const unknown = (snapshot: Snapshot, mode: ProjectionMode, reason: string): ToolExecutionProjection =>
  base(snapshot, "outcome_unknown", {
    ...(snapshot.observation?.status === undefined ? {} : { outcome: snapshot.observation.status }),
    ...(attemptOf(snapshot) === undefined ? {} : { attempt: attemptOf(snapshot) }),
    repair: repair(reason, mode === "recovery" ? "action-gateway-recovery" : "durable-action"),
  })

/**
 * Projects one validated DurableAction snapshot without changing it.
 *
 * `live` is used while an owned attempt is still running, where executing is
 * truthfully `dispatched`. `recovery` is used after a restart or retry: an
 * executing action is treated as `outcome_unknown` even when it has a safe
 * retry policy, because the policy only authorizes a later recovery decision;
 * it never turns an unobserved side effect into success.
 */
export const project = (snapshot: Snapshot, mode: ProjectionMode = "recovery"): ToolExecutionProjection => {
  const action = snapshot.action
  const outcome = snapshot.observation?.status
  const attempt = attemptOf(snapshot)

  switch (action.status) {
    case "proposed":
    case "policy_evaluated":
    case "awaiting_approval":
      return action.budget.attemptsUsed === 0 && snapshot.activeAttempt === undefined && outcome === undefined
        ? base(snapshot, "not_started", { repair: noRepair() })
        : unknown(snapshot, mode, "The durable action has attempt evidence before its execution handoff.")

    case "authorized":
      return action.budget.attemptsUsed === 0 && snapshot.activeAttempt === undefined && outcome === undefined
        ? base(snapshot, "prepared", { repair: noRepair() })
        : unknown(snapshot, mode, "The authorized action carries execution evidence without a settled observation.")

    case "executing":
      if (outcome !== undefined || snapshot.activeAttempt === undefined || attempt === undefined)
        return unknown(snapshot, mode, "The action reached execution without a complete durable observation.")
      return mode === "recovery"
        ? unknown(snapshot, mode, "The action was dispatched before recovery and its external outcome is unknown.")
        : base(snapshot, "dispatched", { attempt, repair: noRepair() })

    case "observed":
    case "verifying":
    case "compensating":
      return outcome === undefined
        ? unknown(snapshot, mode, "The action state requires an observation, but none is durably recorded.")
        : base(snapshot, "observed", {
            outcome,
            ...(attempt === undefined ? {} : { attempt }),
            repair: repair("The observation exists but the durable action has not reached a terminal settlement."),
          })

    case "settled":
      return outcome === undefined
        ? unknown(snapshot, mode, "The action is marked settled without a durable observation.")
        : base(snapshot, "settled", {
            outcome,
            ...(attempt === undefined ? {} : { attempt }),
            repair: noRepair(),
          })

    case "blocked":
      return action.budget.attemptsUsed > 0 && outcome === undefined
        ? unknown(snapshot, mode, "The action was blocked after an attempt without a durable observation.")
        : base(snapshot, "blocked", {
            ...(outcome === undefined ? {} : { outcome }),
            ...(attempt === undefined ? {} : { attempt }),
            repair: noRepair(),
          })

    case "cancelled":
      return action.budget.attemptsUsed > 0 && outcome === undefined
        ? unknown(snapshot, mode, "The action was cancelled after dispatch without a durable observation.")
        : base(snapshot, "cancelled", {
            ...(outcome === undefined ? {} : { outcome }),
            ...(attempt === undefined ? {} : { attempt }),
            repair: noRepair(),
          })
  }
}

/**
 * Stable mutation recovery wording; it deliberately contains no raw tool input
 * or file bytes. This remains useful even when the action itself has a
 * terminal-looking status but the mutation transaction has not settled.
 */
export const mutationRecoveryMessage = (projection: ToolExecutionProjection): string => {
  const mutation = projection.mutationRecovery
  if (mutation === undefined) return ""
  if (mutation.phase === "settled" && projection.state === "settled" && projection.outcome !== undefined) return ""
  if (mutation.phase === "rolled_back")
    return (
      "Mutation recovery is rolled_back for transaction " +
      mutation.transactionID +
      ": " +
      mutation.reason +
      " The Action outcome is not durably settled; Automatic retry is blocked until the action is reconciled."
    )
  if (mutation.decision === "settled")
    return (
      "Mutation recovery is settled for transaction " +
      mutation.transactionID +
      ", but the Action state is " +
      projection.state +
      "; Automatic retry is blocked until the action is reconciled."
    )
  return (
    "Mutation recovery requires " +
    mutation.decision +
    " for transaction " +
    mutation.transactionID +
    ": " +
    mutation.reason +
    " Automatic retry is blocked; inspect the recorded targets before retrying."
  )
}

/** Stable model/operator wording; it deliberately contains no raw tool input. */
export const recoveryMessage = (projection: ToolExecutionProjection): string => {
  if (projection.state !== "outcome_unknown") return ""
  const mutationMessage = mutationRecoveryMessage(projection)
  return `Tool outcome is unknown (${projection.repair.reason ?? "durable observation is missing"}); inspect or reconcile the external state before retrying.${mutationMessage === "" ? "" : ` ${mutationMessage}`}`
}
