/**
 * Transaction-bound DurableRun event writers shared by the coordinator
 * adapters and the DurableRun compatibility wrapper.
 *
 * This module deliberately has no dependency on DurableRun's service module:
 * keeping the low-level EventV2 primitives here lets the canonical adapter
 * factory be used by DurableRun without creating an import cycle.  Callers
 * still own all run/lease/budget authorization; these helpers only validate
 * immutable digests and write through the supplied transaction handle.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { childResultDigest } from "./child-contract"

export interface ChildResultTransactionWriteInput {
  readonly transaction: Database.Transaction
  readonly eventID: EventV2.ID
  readonly runID: AgentRuntime.RunID
  readonly parentRunID: AgentRuntime.RunID
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly result: AgentRuntime.ChildRunResult
  readonly expectedSequence: number
}

export interface ChildBudgetSettlementTransactionWriteInput {
  readonly transaction: Database.Transaction
  readonly eventID: EventV2.ID
  readonly parentRunID: AgentRuntime.RunID
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly childRunID: AgentRuntime.RunID
  readonly reserved: AgentRuntime.ChildBudgetAmount
  readonly actual: AgentRuntime.ChildBudgetAmount
  readonly reservedTotal: AgentRuntime.ChildBudgetAmount
  readonly settledAt: AgentRuntime.ChildRunResult["recordedAt"]
  readonly expectedSequence: number
}

/** A payload-free error raised by a transaction-bound settlement writer. */
export class SettlementTransactionWriterError extends Error {
  readonly _tag = "Runtime.SettlementTransactionWriterError"

  constructor(
    readonly runID: AgentRuntime.RunID,
    reason: string,
  ) {
    super(reason)
    this.name = this._tag
  }
}

const transactionWriteError = (runID: AgentRuntime.RunID, reason: string) =>
  new SettlementTransactionWriterError(runID, reason)

/** Persist the child-result event on the coordinator's transaction handle. */
export const writeChildResultInTransaction = Effect.fn("SettlementTransactionWriters.writeChildResultInTransaction")(
  function* (input: ChildResultTransactionWriteInput) {
    const expectedDigest = childResultDigest({
      status: input.result.status,
      summary: input.result.summary,
      artifactRefs: input.result.artifactRefs,
      evidenceRefs: input.result.evidenceRefs,
      usage: input.result.usage,
    })
    if (expectedDigest === undefined || expectedDigest !== input.result.resultDigest)
      return yield* Effect.fail(
        transactionWriteError(input.runID, "child result digest does not match its immutable fields"),
      )
    if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)
      return yield* Effect.fail(transactionWriteError(input.runID, "child result expected sequence is invalid"))
    const definition = AgentRuntime.Event.ChildRunResultRecorded
    const event = {
      id: input.eventID,
      type: definition.type,
      data: {
        runID: input.runID,
        parentRunID: input.parentRunID,
        sessionID: input.sessionID,
        result: input.result,
      },
    } as EventV2.Payload<typeof definition>
    const committed = yield* EventV2.commitDurableEventInTransaction({
      transaction: input.transaction,
      definition,
      event,
      expectedSequence: input.expectedSequence,
    })
    if (!committed)
      return yield* Effect.fail(
        transactionWriteError(input.runID, "child result owner rejected the transaction binding"),
      )
    return { aggregateID: committed.aggregateID, seq: committed.seq, eventID: input.eventID }
  },
)

/** Persist the parent-owned child-budget settlement event on the same handle. */
export const writeChildBudgetSettlementInTransaction = Effect.fn(
  "SettlementTransactionWriters.writeChildBudgetSettlementInTransaction",
)(function* (input: ChildBudgetSettlementTransactionWriteInput) {
  if (!Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 0)
    return yield* Effect.fail(transactionWriteError(input.parentRunID, "parent budget expected sequence is invalid"))
  const definition = AgentRuntime.Event.ChildRunBudgetSettled
  const event = {
    id: input.eventID,
    type: definition.type,
    data: {
      runID: input.parentRunID,
      sessionID: input.sessionID,
      childRunID: input.childRunID,
      reserved: input.reserved,
      actual: input.actual,
      reservedTotal: input.reservedTotal,
      settledAt: input.settledAt,
    },
  } as EventV2.Payload<typeof definition>
  const committed = yield* EventV2.commitDurableEventInTransaction({
    transaction: input.transaction,
    definition,
    event,
    expectedSequence: input.expectedSequence,
  })
  if (!committed)
    return yield* Effect.fail(
      transactionWriteError(input.parentRunID, "parent budget owner rejected the transaction binding"),
    )
  return { aggregateID: committed.aggregateID, seq: committed.seq, eventID: input.eventID }
})
