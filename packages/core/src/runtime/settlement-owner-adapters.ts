/**
 * Concrete owner adapters for the transaction coordinator.
 *
 * The adapters bridge the coordinator's payload-free scope to the existing
 * EventV2, ExperienceStore and DurableRun writers.  Payloads are captured in
 * this trusted server-side closure and never travel through the coordinator
 * scope; all three writes still receive the same SQL transaction handle.
 * Callers must perform the normal DurableRun/ActionGateway validation before
 * constructing this adapter input.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { ExperienceStoreV1 } from "../experience-store"
import * as AdmissionEvidence from "./admission-evidence"
import * as ChildSettlement from "./child-settlement"
import {
  writeChildBudgetSettlementInTransaction,
  writeChildResultInTransaction,
} from "./settlement-transaction-writers"
import * as SettlementCoordinator from "./settlement-coordinator"
import { canonicalHash } from "../util/canonical-hash"
import { EventV2 } from "../event"

export interface SettlementOwnerAdapterInput {
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly admission: Readonly<{
    readonly identity: ExperienceStoreV1.TrustedExperienceIdentity
    readonly plan: AdmissionEvidence.Plan
    readonly actionID: AgentRuntime.ActionID
    readonly observation: AgentRuntime.Observation
  }>
  readonly childResult: Readonly<{
    readonly eventID: EventV2.ID
    readonly sessionID: AgentRuntime.SessionRun["sessionID"]
    readonly result: AgentRuntime.ChildRunResult
    readonly expectedSequence: number
  }>
  readonly parentBudget: Readonly<{
    readonly eventID: EventV2.ID
    readonly sessionID: AgentRuntime.SessionRun["sessionID"]
    readonly reserved: AgentRuntime.ChildBudgetAmount
    readonly actual: AgentRuntime.ChildBudgetAmount
    readonly reservedTotal: AgentRuntime.ChildBudgetAmount
    readonly settledAt: AgentRuntime.ChildRunResult["recordedAt"]
    readonly expectedSequence: number
  }>
  /**
   * Optional metadata-only observer used to prepare EventV2 replay
   * notifications. It runs inside the transaction after the owner write and
   * receives no payload or external side effect.
   */
  readonly onOwnerWrite?: (
    input: Readonly<{ owner: "child-result" | "parent-budget"; aggregateID: string; seq: number }>,
  ) => void
}

/** Concrete payload binding for a legacy child without admission Evidence. */
export interface LegacySettlementOwnerAdapterInput {
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly childResult: SettlementOwnerAdapterInput["childResult"]
  readonly parentBudget: SettlementOwnerAdapterInput["parentBudget"]
  /**
   * Optional metadata-only observer used to prepare EventV2 replay
   * notifications. It runs inside the transaction before the outer commit,
   * receives no payload, and must not perform an external side effect; the
   * caller must discard the collected metadata if the coordinator fails.
   */
  readonly onOwnerWrite?: (
    input: Readonly<{ owner: "child-result" | "parent-budget"; aggregateID: string; seq: number }>,
  ) => void
}

const ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite> = [
  "admission-evidence",
  "child-result",
  "parent-budget",
]

const legacyOwnerOrder: ReadonlyArray<ChildSettlement.SettlementWrite> = ["child-result", "parent-budget"]

const receipt = (
  owner: ChildSettlement.SettlementWrite,
  scope: SettlementCoordinator.SettlementOwnerTransactionScope,
  ownerDigest: string,
): SettlementCoordinator.SettlementOwnerReceipt =>
  Object.freeze({
    schemaVersion: SettlementCoordinator.SETTLEMENT_COORDINATOR_SCHEMA_VERSION,
    owner,
    transactionKey: scope.transactionKey,
    transactionID: scope.transactionID,
    ownerDigest,
  })

const assertInput = (input: SettlementOwnerAdapterInput): void => {
  ChildSettlement.assertSettlementCommitPlan(input.plan)
  if (input.plan.mode !== "same-transaction" || input.plan.outboxRequired !== false)
    throw new Error("settlement owner adapters require a same-transaction commit plan")
  if (JSON.stringify(input.plan.ownerOrder) !== JSON.stringify(ownerOrder))
    throw new Error("settlement owner adapters require the complete Evidence → result → budget order")
  if (input.plan.owners.evidence !== "experience-store")
    throw new Error("settlement owner adapters require an Evidence-bearing plan")
  if (input.admission.plan.parentRunID !== input.plan.parentRunID)
    throw new Error("admission Evidence adapter parent identity does not match the settlement plan")
  if (input.admission.plan.childRunID !== input.plan.childRunID)
    throw new Error("admission Evidence adapter child identity does not match the settlement plan")
  if (String(input.admission.plan.evidenceID) !== `evd_admission_${input.admission.plan.admissionDigest}`)
    throw new Error("admission Evidence adapter identity is invalid")
  if (!input.childResult.result.evidenceRefs.some((id) => String(id) === String(input.admission.plan.evidenceID)))
    throw new Error("admission Evidence adapter identity is not carried by the child result")
  if (input.childResult.result.resultDigest !== input.plan.expectedDigests.childResult)
    throw new Error("child-result adapter digest does not match the settlement plan")
  const budgetDigest = canonicalHash(input.parentBudget.actual)
  if (budgetDigest === undefined || budgetDigest !== input.plan.expectedDigests.parentBudget)
    throw new Error("parent-budget adapter digest does not match the settlement plan")
  if (input.childResult.eventID === input.parentBudget.eventID)
    throw new Error("settlement owner event IDs must be distinct")
}

const assertLegacyInput = (input: LegacySettlementOwnerAdapterInput): void => {
  ChildSettlement.assertSettlementCommitPlan(input.plan)
  if (input.plan.mode !== "same-transaction" || input.plan.outboxRequired !== false)
    throw new Error("legacy settlement owner adapters require a same-transaction commit plan")
  if (input.plan.owners.evidence !== "not-required")
    throw new Error("legacy settlement owner adapters cannot accept an Evidence-bearing plan")
  if (JSON.stringify(input.plan.ownerOrder) !== JSON.stringify(legacyOwnerOrder))
    throw new Error("legacy settlement owner adapters require the child-result → parent-budget order")
  if (input.childResult.result.resultDigest !== input.plan.expectedDigests.childResult)
    throw new Error("legacy child-result adapter digest does not match the settlement plan")
  const budgetDigest = canonicalHash(input.parentBudget.actual)
  if (budgetDigest === undefined || budgetDigest !== input.plan.expectedDigests.parentBudget)
    throw new Error("legacy parent-budget adapter digest does not match the settlement plan")
  if (input.childResult.eventID === input.parentBudget.eventID)
    throw new Error("legacy settlement owner event IDs must be distinct")
}

/**
 * Create the three concrete writers consumed by
 * `executeSettlementTransaction`.  This function does not execute a
 * transaction; it only binds validated owner payloads to the one coordinator
 * seam so tests and future production callers cannot accidentally open a
 * second database callback per owner.
 */
export const createSettlementOwnerWriters = (
  input: SettlementOwnerAdapterInput,
): SettlementCoordinator.SettlementOwnerWriters => {
  assertInput(input)
  const evidenceDigest = input.plan.expectedDigests.evidence!
  const childResultDigest = input.plan.expectedDigests.childResult
  const parentBudgetDigest = input.plan.expectedDigests.parentBudget
  return {
    "admission-evidence": (transaction, scope) =>
      ExperienceStoreV1.recordAdmissionEvidenceInTransaction({
        transaction,
        identity: input.admission.identity,
        plan: input.admission.plan,
        actionID: input.admission.actionID,
        observation: input.admission.observation,
      }).pipe(
        Effect.flatMap((projection) =>
          projection.recordDigest === evidenceDigest
            ? Effect.succeed(receipt("admission-evidence", scope, evidenceDigest))
            : Effect.fail(new Error("admission Evidence record digest drifted during transaction write")),
        ),
      ),
    "child-result": (transaction, scope) =>
      writeChildResultInTransaction({
        transaction,
        eventID: input.childResult.eventID,
        runID: input.plan.childRunID,
        parentRunID: input.plan.parentRunID,
        sessionID: input.childResult.sessionID,
        result: input.childResult.result,
        expectedSequence: input.childResult.expectedSequence,
      }).pipe(
        Effect.tap((committed) =>
          Effect.sync(() =>
            input.onOwnerWrite?.({ owner: "child-result", aggregateID: committed.aggregateID, seq: committed.seq }),
          ),
        ),
        Effect.as(receipt("child-result", scope, childResultDigest)),
      ),
    "parent-budget": (transaction, scope) =>
      writeChildBudgetSettlementInTransaction({
        transaction,
        eventID: input.parentBudget.eventID,
        parentRunID: input.plan.parentRunID,
        sessionID: input.parentBudget.sessionID,
        childRunID: input.plan.childRunID,
        reserved: input.parentBudget.reserved,
        actual: input.parentBudget.actual,
        reservedTotal: input.parentBudget.reservedTotal,
        settledAt: input.parentBudget.settledAt,
        expectedSequence: input.parentBudget.expectedSequence,
      }).pipe(
        Effect.tap((committed) =>
          Effect.sync(() =>
            input.onOwnerWrite?.({ owner: "parent-budget", aggregateID: committed.aggregateID, seq: committed.seq }),
          ),
        ),
        Effect.as(receipt("parent-budget", scope, parentBudgetDigest)),
      ),
  }
}

/**
 * Create the two concrete writers for a legacy child settlement. The
 * implementation delegates to the same EventV2 transaction primitives as
 * the Evidence-bearing adapter instead of opening a second transaction per
 * owner.
 */
export const createLegacySettlementOwnerWriters = (
  input: LegacySettlementOwnerAdapterInput,
): SettlementCoordinator.LegacySettlementOwnerWriters => {
  assertLegacyInput(input)
  const childResultDigest = input.plan.expectedDigests.childResult
  const parentBudgetDigest = input.plan.expectedDigests.parentBudget
  return {
    "child-result": (transaction, scope) =>
      writeChildResultInTransaction({
        transaction,
        eventID: input.childResult.eventID,
        runID: input.plan.childRunID,
        parentRunID: input.plan.parentRunID,
        sessionID: input.childResult.sessionID,
        result: input.childResult.result,
        expectedSequence: input.childResult.expectedSequence,
      }).pipe(
        Effect.tap((committed) =>
          Effect.sync(() =>
            input.onOwnerWrite?.({ owner: "child-result", aggregateID: committed.aggregateID, seq: committed.seq }),
          ),
        ),
        Effect.as(receipt("child-result", scope, childResultDigest)),
      ),
    "parent-budget": (transaction, scope) =>
      writeChildBudgetSettlementInTransaction({
        transaction,
        eventID: input.parentBudget.eventID,
        parentRunID: input.plan.parentRunID,
        sessionID: input.parentBudget.sessionID,
        childRunID: input.plan.childRunID,
        reserved: input.parentBudget.reserved,
        actual: input.parentBudget.actual,
        reservedTotal: input.parentBudget.reservedTotal,
        settledAt: input.parentBudget.settledAt,
        expectedSequence: input.parentBudget.expectedSequence,
      }).pipe(
        Effect.tap((committed) =>
          Effect.sync(() =>
            input.onOwnerWrite?.({ owner: "parent-budget", aggregateID: committed.aggregateID, seq: committed.seq }),
          ),
        ),
        Effect.as(receipt("parent-budget", scope, parentBudgetDigest)),
      ),
  }
}
