/**
 * Durable, payload-free settlement observation journal.
 *
 * The journal is deliberately a projection of the settlement-coordinator
 * receipt, not a second settlement owner.  It writes one versioned event to
 * the parent Run aggregate on the coordinator's transaction handle and can
 * rebuild an immutable observation checkpoint after a process restart.  No
 * provider output, prompt, result summary, or business payload crosses this
 * boundary.
 */

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Effect, Schema } from "effect"
import { and, asc, eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventSequenceTable, EventTable } from "../event/sql"
import * as ChildSettlement from "./child-settlement"
import * as SettlementCoordinator from "./settlement-coordinator"
import * as SettlementObservation from "./settlement-observation"

const EVENT_DEFINITION = AgentRuntime.Event.ChildRunSettlementObservationRecorded
const EVENT_TYPE = EventV2.versionedType(EVENT_DEFINITION.type, EVENT_DEFINITION.durable!.version)

type RecordedData = typeof EVENT_DEFINITION.data.Type
type RecordedEvent = EventV2.Payload<typeof EVENT_DEFINITION>

export class SettlementObservationJournalError extends Error {
  readonly _tag = "Runtime.SettlementObservationJournalError"

  constructor(
    readonly code: "INVALID_INPUT" | "CORRUPT_HISTORY" | "DUPLICATE" | "MISSING_AGGREGATE",
    reason: string,
    readonly runID?: AgentRuntime.RunID,
    readonly sequence?: number,
  ) {
    super(reason)
    this.name = this._tag
  }
}

const invalid = (reason: string, runID?: AgentRuntime.RunID) =>
  new SettlementObservationJournalError("INVALID_INPUT", reason, runID)
const corrupt = (reason: string, runID: AgentRuntime.RunID, sequence: number) =>
  new SettlementObservationJournalError("CORRUPT_HISTORY", reason, runID, sequence)

export type SettlementObservationJournalRecord = Readonly<{
  readonly event: RecordedEvent
  readonly checkpoint: SettlementObservation.SettlementObservationCheckpoint
  readonly serializedEvent: EventV2.SerializedEvent
}>

export type SettlementObservationJournalAppendInput = Readonly<{
  readonly transaction: Database.Transaction
  readonly parentRunID: AgentRuntime.RunID
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly childRunID: AgentRuntime.RunID
  readonly observerID: string
  readonly execution: unknown
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly sharedTransactionEvidence: ChildSettlement.SettlementSharedTransactionEvidence
  readonly minimumSamples?: number
  readonly eventID?: EventV2.ID
}>

export type SettlementObservationJournalLoadInput = Readonly<{
  readonly parentRunID: AgentRuntime.RunID
  readonly observerID?: string
  readonly minimumSamples?: number
}>

const strictDecodeData = (value: unknown): RecordedData =>
  Schema.decodeUnknownSync(EVENT_DEFINITION.data, {
    errors: "all",
    onExcessProperty: "error",
    propertyOrder: "original",
  })(value)

const toSerializedEvent = (event: RecordedEvent, sequence: number): EventV2.SerializedEvent => ({
  id: event.id,
  type: EVENT_TYPE,
  seq: sequence,
  aggregateID: event.data.runID,
  data: Schema.encodeUnknownSync(EVENT_DEFINITION.data)(event.data) as Record<string, unknown>,
})

const sampleEqual = (
  left: SettlementObservation.SettlementObservationSample,
  right: SettlementObservation.SettlementObservationSample,
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.planDigest === right.planDigest &&
  left.evidenceDigest === right.evidenceDigest &&
  left.transactionKey === right.transactionKey &&
  left.transactionID === right.transactionID &&
  JSON.stringify(left.ownerOrder) === JSON.stringify(right.ownerOrder) &&
  left.ownerCount === right.ownerCount &&
  left.outcome === right.outcome &&
  left.providerExecutionAllowed === right.providerExecutionAllowed &&
  left.executionDigest === right.executionDigest &&
  left.observedAtMs === right.observedAtMs

type JournalRow = Readonly<{
  readonly id: EventV2.ID
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}>

const readRows = (source: Database.Interface["db"] | Database.Transaction, parentRunID: AgentRuntime.RunID) =>
  source
    .select({
      id: EventTable.id,
      seq: EventTable.seq,
      aggregateID: EventTable.aggregate_id,
      data: EventTable.data,
    })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, parentRunID), eq(EventTable.type, EVENT_TYPE)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows as ReadonlyArray<JournalRow>),
    )

const validateObserverID = (observerID: string): void => {
  if (typeof observerID !== "string" || !/^[A-Za-z0-9._:-]{1,255}$/.test(observerID))
    throw invalid("settlement observation observerID is invalid")
}

const validateMinimumSamples = (minimumSamples: number | undefined): number | undefined => {
  if (
    minimumSamples !== undefined &&
    (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 1024)
  )
    throw invalid("settlement observation minimumSamples is invalid")
  return minimumSamples
}

const rebuild = (
  rows: ReadonlyArray<JournalRow>,
  input: Readonly<{ parentRunID: AgentRuntime.RunID; observerID?: string; minimumSamples?: number }>,
): Readonly<{
  readonly checkpoint?: SettlementObservation.SettlementObservationCheckpoint
  readonly records: ReadonlyArray<SettlementObservationJournalRecord>
  readonly sessionID?: AgentRuntime.SessionRun["sessionID"]
}> => {
  const observerID = input.observerID
  if (observerID !== undefined) validateObserverID(observerID)
  const requestedMinimum = validateMinimumSamples(input.minimumSamples)
  let checkpoint: SettlementObservation.SettlementObservationCheckpoint | undefined
  let sessionID: AgentRuntime.SessionRun["sessionID"] | undefined
  let lastSequence = -1
  const childRunIDs = new Set<AgentRuntime.RunID>()
  const records: SettlementObservationJournalRecord[] = []

  for (const row of rows) {
    if (row.aggregateID !== input.parentRunID || !Number.isSafeInteger(row.seq) || row.seq < 0)
      throw corrupt("settlement observation journal row identity is invalid", input.parentRunID, row.seq)
    if (row.seq <= lastSequence)
      throw corrupt("settlement observation journal sequence is not strictly increasing", input.parentRunID, row.seq)
    lastSequence = row.seq

    let data: RecordedData
    try {
      data = strictDecodeData(row.data)
    } catch (cause) {
      throw corrupt(
        `Settlement observation journal event failed strict decoding: ${String(cause)}`,
        input.parentRunID,
        row.seq,
      )
    }
    if (data.runID !== input.parentRunID || data.childRunID === input.parentRunID)
      throw corrupt("settlement observation journal parent/child identity drifted", input.parentRunID, row.seq)
    if (observerID !== undefined && data.observerID !== observerID) continue
    if (sessionID === undefined) sessionID = data.sessionID
    if (sessionID !== data.sessionID)
      throw corrupt("settlement observation journal session identity drifted", input.parentRunID, row.seq)
    if (childRunIDs.has(data.childRunID))
      throw corrupt("settlement observation journal child run is duplicated", input.parentRunID, row.seq)

    const sample = data.sample as SettlementObservation.SettlementObservationSample
    let next: SettlementObservation.SettlementObservationCheckpoint
    try {
      next = SettlementObservation.appendSettlementObservationCheckpoint({
        observerID: data.observerID,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        sample,
        minimumSamples: data.minimumSamples,
      })
    } catch (cause) {
      throw corrupt(
        `Settlement observation journal sample failed immutable validation: ${String(cause)}`,
        input.parentRunID,
        row.seq,
      )
    }
    if (
      data.sampleSequence !== next.window.sampleCount ||
      data.minimumSamples !== next.window.minimumSamples ||
      data.windowDigest !== next.window.windowDigest ||
      data.checkpointDigest !== next.checkpointDigest ||
      DateTime.toEpochMillis(data.recordedAt) !== sample.observedAtMs
    )
      throw corrupt("settlement observation journal checkpoint metadata drifted", input.parentRunID, row.seq)
    if (requestedMinimum !== undefined && data.minimumSamples !== requestedMinimum)
      throw corrupt("settlement observation journal minimumSamples drifted", input.parentRunID, row.seq)
    checkpoint = next
    childRunIDs.add(data.childRunID)
    const event = {
      id: row.id,
      type: EVENT_DEFINITION.type,
      data,
      durable: { aggregateID: row.aggregateID, seq: row.seq, version: EVENT_DEFINITION.durable!.version },
    } as RecordedEvent
    records.push({ event, checkpoint: next, serializedEvent: toSerializedEvent(event, row.seq) })
  }

  return { checkpoint, records, ...(sessionID === undefined ? {} : { sessionID }) }
}

/** Read and strictly rebuild one observer's checkpoint from committed rows. */
export const load = Effect.fn("SettlementObservationJournal.load")(function* (
  db: Database.Interface["db"],
  input: SettlementObservationJournalLoadInput,
) {
  if (db === null || typeof db !== "object")
    return yield* Effect.fail(invalid("settlement observation database is required"))
  if (typeof input?.parentRunID !== "string" || input.parentRunID.length === 0)
    return yield* Effect.fail(invalid("settlement observation parentRunID is required"))
  const rows = yield* readRows(db, input.parentRunID)
  const rebuilt = yield* Effect.try({
    try: () => rebuild(rows, input),
    catch: (error) => (error instanceof SettlementObservationJournalError ? error : invalid(String(error))),
  })
  return rebuilt.checkpoint
})

/**
 * Append one observation event atomically with the three settlement owners.
 * A matching child sample is an exact idempotent replay; any divergent
 * duplicate, sequence drift, or malformed history fails closed.
 */
export const appendInTransaction = Effect.fn("SettlementObservationJournal.appendInTransaction")(function* (
  input: SettlementObservationJournalAppendInput,
) {
  if (input === null || typeof input !== "object")
    return yield* Effect.fail(invalid("settlement observation append input is required"))
  if (input.transaction === null || typeof input.transaction !== "object")
    return yield* Effect.fail(invalid("settlement observation transaction is required"))
  if (typeof input?.parentRunID !== "string" || input.parentRunID.length === 0)
    return yield* Effect.fail(invalid("settlement observation parentRunID is required"))
  if (typeof input.childRunID !== "string" || input.childRunID.length === 0 || input.childRunID === input.parentRunID)
    return yield* Effect.fail(invalid("settlement observation childRunID is invalid", input.parentRunID))
  if (input.plan === null || typeof input.plan !== "object")
    return yield* Effect.fail(invalid("settlement observation commit plan is required", input.parentRunID))
  if (input.plan.parentRunID !== input.parentRunID || input.plan.childRunID !== input.childRunID)
    return yield* Effect.fail(
      invalid("settlement observation execution plan does not match the parent/child aggregate", input.parentRunID),
    )
  const requestedMinimum = yield* Effect.try({
    try: () => {
      validateObserverID(input.observerID)
      return validateMinimumSamples(input.minimumSamples)
    },
    catch: (error) => (error instanceof SettlementObservationJournalError ? error : invalid(String(error))),
  })
  const sample = yield* Effect.try({
    try: () =>
      SettlementObservation.observationFromExecution({
        execution: input.execution,
        plan: input.plan,
        sharedTransactionEvidence: input.sharedTransactionEvidence,
      }),
    catch: (error) => invalid(`settlement observation execution is invalid: ${String(error)}`, input.parentRunID),
  })
  const rows = yield* readRows(input.transaction, input.parentRunID)
  const rebuilt = yield* Effect.try({
    try: () => rebuild(rows, { parentRunID: input.parentRunID, observerID: input.observerID }),
    catch: (error) => (error instanceof SettlementObservationJournalError ? error : invalid(String(error))),
  })
  const existing = rebuilt.records.find((record) => record.event.data.childRunID === input.childRunID)
  if (existing) {
    if (
      existing.event.data.sessionID !== input.sessionID ||
      existing.event.data.observerID !== input.observerID ||
      !sampleEqual(existing.event.data.sample, sample) ||
      (requestedMinimum !== undefined && existing.event.data.minimumSamples !== requestedMinimum)
    )
      return yield* Effect.fail(
        new SettlementObservationJournalError(
          "DUPLICATE",
          "settlement observation child sample conflicts with its existing journal record",
          input.parentRunID,
          existing.event.durable?.seq,
        ),
      )
    return existing
  }

  if (rebuilt.sessionID !== undefined && rebuilt.sessionID !== input.sessionID)
    return yield* Effect.fail(invalid("settlement observation journal session identity drifted", input.parentRunID))
  const checkpoint = yield* Effect.try({
    try: () =>
      SettlementObservation.appendSettlementObservationCheckpoint({
        observerID: input.observerID,
        ...(rebuilt.checkpoint === undefined ? {} : { checkpoint: rebuilt.checkpoint }),
        sample,
        ...(requestedMinimum === undefined ? {} : { minimumSamples: requestedMinimum }),
      }),
    catch: (error) => invalid(`settlement observation checkpoint append failed: ${String(error)}`, input.parentRunID),
  })
  const sequenceRow = yield* input.transaction
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, input.parentRunID))
    .get()
    .pipe(Effect.orDie)
  if (!sequenceRow || !Number.isSafeInteger(sequenceRow.seq) || sequenceRow.seq < 0)
    return yield* Effect.fail(
      new SettlementObservationJournalError(
        "MISSING_AGGREGATE",
        "settlement observation parent aggregate does not exist",
        input.parentRunID,
      ),
    )

  const data: RecordedData = {
    runID: input.parentRunID,
    sessionID: input.sessionID,
    childRunID: input.childRunID,
    observerID: input.observerID,
    sampleSequence: checkpoint.window.sampleCount,
    minimumSamples: checkpoint.window.minimumSamples,
    sample,
    windowDigest: checkpoint.window.windowDigest,
    checkpointDigest: checkpoint.checkpointDigest,
    recordedAt: DateTime.makeUnsafe(sample.observedAtMs),
  }
  const event = {
    id: input.eventID ?? EventV2.ID.create(),
    type: EVENT_DEFINITION.type,
    data,
  } as RecordedEvent
  const committed = yield* EventV2.commitDurableEventInTransaction({
    transaction: input.transaction,
    definition: EVENT_DEFINITION,
    event,
    expectedSequence: sequenceRow.seq,
  })
  if (!committed)
    return yield* Effect.fail(
      invalid("settlement observation journal parent aggregate owner rejected the transaction", input.parentRunID),
    )
  const persistedEvent = committed.event as RecordedEvent
  return {
    event: persistedEvent,
    checkpoint,
    serializedEvent: toSerializedEvent(persistedEvent, committed.seq),
  } satisfies SettlementObservationJournalRecord
})

/** Strictly inspect a serialized journal event before replay/notification. */
export const assertSerializedEvent = (event: EventV2.SerializedEvent, parentRunID: AgentRuntime.RunID): void => {
  if (event.aggregateID !== parentRunID || event.type !== EVENT_TYPE)
    throw invalid("settlement observation serialized event identity drifted", parentRunID)
  const data = strictDecodeData(event.data)
  if (data.runID !== parentRunID)
    throw invalid("settlement observation serialized event parent identity drifted", parentRunID)
}

export const type = EVENT_TYPE
