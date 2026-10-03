import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionEvent } from "@arforge-ai/schema/session-event"
import { Effect, Schema } from "effect"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import * as SessionCheckpoint from "../checkpoint"
import * as SessionRunnerEvidence from "./evidence"
import { requestProjectionErrors, type RequestProjection } from "./parity-matrix"

/**
 * The smallest database-independent row shape needed by the runner evidence
 * boundary.  Callers may obtain rows through EventV2, Drizzle, or a recorded
 * fixture; this adapter deliberately owns no database service and never
 * writes or mutates the supplied history.
 */
export type DurableHistoryRow = Readonly<{
  readonly aggregateID: string
  readonly sequence: number
  readonly type: string
  readonly data: unknown
}>

export type RunnerEventQuery = Readonly<{
  readonly sessionID: string
  readonly runID: string
}>

/**
 * Injectable read-only source for committed runner events.  Production uses
 * the EventV2/Database implementation below; recorded or replay harnesses may
 * provide a source backed by an isolated composition root without changing
 * the history/evidence consumer.
 */
export interface RunnerEventRowSource {
  readonly collect: (input: RunnerEventQuery) => Effect.Effect<ReadonlyArray<EventV2.SerializedEvent>, unknown, never>
}

/**
 * Convert committed EventV2 rows into the database-independent history shape.
 * This is the only adapter that accepts the serialized row contract, so
 * acceptance harnesses and production readers cannot silently drop the event
 * id, sequence, or aggregate identity before strict history validation.
 */
export const fromEventRows = (
  events: ReadonlyArray<EventV2.SerializedEvent>,
  options: RunnerHistoryOptions,
): RunnerHistory => {
  const rows = events.map((event) => {
    if (
      event === null ||
      typeof event !== "object" ||
      typeof event.id !== "string" ||
      !event.id.startsWith("evt_") ||
      typeof event.aggregateID !== "string" ||
      event.aggregateID.length === 0 ||
      typeof event.type !== "string" ||
      event.type.length === 0 ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      event.data === null ||
      typeof event.data !== "object" ||
      Array.isArray(event.data)
    )
      throw new DurableHistoryError("Serialized EventV2 runner row is invalid")
    return {
      aggregateID: event.aggregateID,
      sequence: event.seq,
      type: event.type,
      data: event.data,
    } satisfies DurableHistoryRow
  })
  return fromRows(rows, options)
}

/**
 * Collect the committed EventV2 rows for one session/run pair without
 * decoding or projecting them. This is the production read boundary used by
 * history/evidence consumers: event identity, aggregate identity, sequence,
 * type, and data are retained exactly as stored, while writes remain owned by
 * EventV2/DurableRun. The returned rows are intentionally still untrusted;
 * callers must pass them through `fromEventRows` before using them as runner
 * evidence.
 */
export const collectEventRows = Effect.fn("SessionRunnerHistory.collectEventRows")(function* (
  db: Database.Interface["db"],
  input: RunnerEventQuery,
) {
  if (input.sessionID.length === 0 || input.runID.length === 0)
    throw new DurableHistoryError("Runner event collector sessionID and runID are required")
  const aggregateIDs = [...new Set([input.sessionID, input.runID])]
  return yield* EventV2.readSerialized(db, { aggregateIDs })
})

/** Build a row source from a caller-owned read function without adding state. */
export const makeRunnerEventRowSource = (collect: RunnerEventRowSource["collect"]): RunnerEventRowSource =>
  Object.freeze({ collect })

/** Default production row source; EventV2 remains the only storage owner. */
export const runnerEventRowSourceFromDatabase = (db: Database.Interface["db"]): RunnerEventRowSource =>
  makeRunnerEventRowSource((input) => collectEventRows(db, input))

/**
 * Production composition-root source. Prefer this over passing a raw
 * database handle when the EventV2 service is available; lightweight test
 * implementations may omit the optional reader and will fail closed.
 */
export const runnerEventRowSourceFromEventV2 = (
  events: Pick<EventV2.Interface, "readSerialized">,
): RunnerEventRowSource =>
  makeRunnerEventRowSource((input) =>
    Effect.suspend(() => {
      if (input.sessionID.length === 0 || input.runID.length === 0)
        return Effect.die(new DurableHistoryError("Runner event collector sessionID and runID are required"))
      const readSerialized = events.readSerialized
      if (!readSerialized) return Effect.die(new DurableHistoryError("EventV2 serialized reader is unavailable"))
      return readSerialized({ aggregateIDs: [...new Set([input.sessionID, input.runID])] })
    }),
  )

export type RunnerHistoryOptions = Readonly<{
  readonly sessionID: string
  readonly runID: string
  /** Logical evidence owner to retain from a shared session aggregate. */
  readonly owner?: "provider" | "formal" | "mature" | "all"
}>

export type RunnerHistory = Readonly<{
  readonly sessionID: string
  readonly runID: string
  readonly runCreated: typeof AgentRuntime.Event.RunCreated.data.Type | undefined
  /** State transitions are retained so terminal settlement can be checked against committed history. */
  readonly stateChanges: ReadonlyArray<typeof AgentRuntime.Event.RunStateChanged.data.Type>
  readonly checkpoint: typeof AgentRuntime.Event.RunCheckpointCreated.data.Type | undefined
  readonly attempts: ReadonlyArray<typeof AgentRuntime.Event.RunAttemptFinished.data.Type>
  readonly formalRequest: typeof SessionEvent.RequestEnvelopePrepared.data.Type | undefined
  readonly matureBinding: typeof SessionEvent.RequestBindingPrepared.data.Type | undefined
}>

/** History decoding failed before any metadata could be used as evidence. */
export class DurableHistoryError extends Error {
  readonly _tag = "SessionRunner.DurableHistoryError" as const

  constructor(message: string) {
    super(message)
    this.name = "DurableHistoryError"
  }
}

const types = {
  runCreated: EventV2.versionedType(AgentRuntime.Event.RunCreated.type, AgentRuntime.Event.RunCreated.durable!.version),
  stateChanged: EventV2.versionedType(
    AgentRuntime.Event.RunStateChanged.type,
    AgentRuntime.Event.RunStateChanged.durable!.version,
  ),
  checkpoint: EventV2.versionedType(
    AgentRuntime.Event.RunCheckpointCreated.type,
    AgentRuntime.Event.RunCheckpointCreated.durable!.version,
  ),
  attemptFinished: EventV2.versionedType(
    AgentRuntime.Event.RunAttemptFinished.type,
    AgentRuntime.Event.RunAttemptFinished.durable!.version,
  ),
  formalRequest: EventV2.versionedType(
    SessionEvent.RequestEnvelopePrepared.type,
    SessionEvent.RequestEnvelopePrepared.durable!.version,
  ),
  matureBinding: EventV2.versionedType(
    SessionEvent.RequestBindingPrepared.type,
    SessionEvent.RequestBindingPrepared.durable!.version,
  ),
} as const

const decode = <S extends Schema.Decoder<unknown, never>>(row: DurableHistoryRow, schema: S): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema, {
      errors: "all",
      onExcessProperty: "error",
      propertyOrder: "original",
    })(row.data)
  } catch {
    // Do not include serialized event data in the error.  A malformed row may
    // contain prompt text, tool arguments, or credentials from an old store.
    throw new DurableHistoryError(`Durable runner event ${row.type} failed strict schema decoding`)
  }
}

const checkSequence = (rows: ReadonlyArray<DurableHistoryRow>, aggregateID: string) => {
  const aggregateRows = rows
    .filter((row) => row.aggregateID === aggregateID)
    .toSorted((left, right) => left.sequence - right.sequence)
  for (let index = 0; index < aggregateRows.length; index += 1) {
    const row = aggregateRows[index]!
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 0 || row.sequence !== index)
      throw new DurableHistoryError(`Durable runner history for ${aggregateID} is not contiguous`)
  }
}

const latest = <T>(values: ReadonlyArray<T>): T | undefined => values.at(-1)

/**
 * Decode the durable rows relevant to one session/run pair into one immutable
 * runner history projection. Unknown event types are retained for sequence
 * validation but are ignored by this owner; recognized events are decoded
 * strictly and identity-checked against the requested pair.
 */
export const fromRows = (inputRows: ReadonlyArray<DurableHistoryRow>, options: RunnerHistoryOptions): RunnerHistory => {
  if (options.sessionID.length === 0 || options.runID.length === 0)
    throw new DurableHistoryError("Runner history sessionID and runID are required")

  const rows = inputRows.filter((row) => {
    if (row === null || typeof row !== "object") throw new DurableHistoryError("Runner history row is invalid")
    return row.aggregateID === options.sessionID || row.aggregateID === options.runID
  })
  checkSequence(rows, options.sessionID)
  checkSequence(rows, options.runID)

  let runCreated: RunnerHistory["runCreated"]
  const stateChanges: Array<typeof AgentRuntime.Event.RunStateChanged.data.Type> = []
  const checkpoints: Array<typeof AgentRuntime.Event.RunCheckpointCreated.data.Type> = []
  const attempts: Array<typeof AgentRuntime.Event.RunAttemptFinished.data.Type> = []
  const formalRequests: Array<typeof SessionEvent.RequestEnvelopePrepared.data.Type> = []
  const matureBindings: Array<typeof SessionEvent.RequestBindingPrepared.data.Type> = []
  const owner = options.owner ?? "all"

  for (const row of rows.toSorted((left, right) =>
    left.aggregateID === right.aggregateID
      ? left.sequence - right.sequence
      : left.aggregateID.localeCompare(right.aggregateID),
  )) {
    switch (row.type) {
      case types.runCreated: {
        if (row.aggregateID !== options.runID)
          throw new DurableHistoryError("RunCreated aggregate does not match the requested run")
        if (runCreated !== undefined)
          throw new DurableHistoryError("Runner history contains more than one RunCreated event")
        const data = decode(row, AgentRuntime.Event.RunCreated.data)
        if (data.runID !== options.runID || data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RunCreated identity does not match the requested session/run")
        runCreated = data
        break
      }
      case types.stateChanged: {
        if (row.aggregateID !== options.runID)
          throw new DurableHistoryError("RunStateChanged aggregate does not match the requested run")
        const data = decode(row, AgentRuntime.Event.RunStateChanged.data)
        if (data.runID !== options.runID || data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RunStateChanged identity does not match the requested session/run")
        stateChanges.push(data)
        break
      }
      case types.checkpoint: {
        if (row.aggregateID !== options.runID)
          throw new DurableHistoryError("RunCheckpointCreated aggregate does not match the requested run")
        const data = decode(row, AgentRuntime.Event.RunCheckpointCreated.data)
        if (data.runID !== options.runID || data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RunCheckpointCreated identity does not match the requested session/run")
        checkpoints.push(data)
        break
      }
      case types.attemptFinished: {
        if (row.aggregateID !== options.runID)
          throw new DurableHistoryError("RunAttemptFinished aggregate does not match the requested run")
        const data = decode(row, AgentRuntime.Event.RunAttemptFinished.data)
        if (data.runID !== options.runID || data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RunAttemptFinished identity does not match the requested session/run")
        attempts.push(data)
        break
      }
      case types.formalRequest: {
        if (row.aggregateID !== options.sessionID)
          throw new DurableHistoryError("RequestEnvelopePrepared aggregate does not match the requested session")
        const data = decode(row, SessionEvent.RequestEnvelopePrepared.data)
        if (data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RequestEnvelopePrepared identity does not match the requested session/run")
        // The session aggregate retains every run's requests. Validate its
        // complete sequence and schema, but only project this run's evidence.
        if (data.runID !== options.runID) break
        if (owner === "formal" || owner === "all") formalRequests.push(data)
        break
      }
      case types.matureBinding: {
        if (row.aggregateID !== options.sessionID)
          throw new DurableHistoryError("RequestBindingPrepared aggregate does not match the requested session")
        const data = decode(row, SessionEvent.RequestBindingPrepared.data)
        if (data.sessionID !== options.sessionID)
          throw new DurableHistoryError("RequestBindingPrepared identity does not match the requested session/run")
        if (data.runID !== options.runID) break
        if (owner === "mature" || owner === "all") matureBindings.push(data)
        break
      }
    }
  }

  return Object.freeze({
    sessionID: options.sessionID,
    runID: options.runID,
    runCreated,
    stateChanges: Object.freeze([...stateChanges]),
    checkpoint: latest(checkpoints),
    attempts: Object.freeze([...attempts]),
    formalRequest: latest(formalRequests),
    matureBinding: latest(matureBindings),
  })
}

export type RunnerTerminalStatus = "completed" | "paused" | "failed" | "cancelled"

export type TerminalHistoryExpectation = Readonly<{
  readonly status: RunnerTerminalStatus
  readonly attempt: number
  /** Paused/failed recovery may legitimately have no semantic cursor. */
  readonly requireCheckpoint?: boolean
}>

export type TerminalHistorySummary = Readonly<{
  readonly sessionID: string
  readonly runID: string
  readonly status: RunnerTerminalStatus
  readonly attempt: number
  readonly checkpointPresent: boolean
  /** Deliberately excludes the durable transition's free-form reason text. */
  readonly transition: Readonly<Pick<typeof AgentRuntime.Event.RunStateChanged.data.Type, "from" | "to" | "changedAt">>
}>

/**
 * Metadata-only notification emitted after a runner has validated its
 * committed terminal history. The callback is an internal composition seam;
 * it intentionally receives no serialized rows or provider content.
 */
export type RunnerSettlementObserver = (input: TerminalHistorySummary) => Effect.Effect<void>

/**
 * Trusted internal hook for parity/replay composition roots.  Unlike the
 * metadata-only observer above, this hook receives a source that is backed by
 * the exact committed rows already read for terminal validation.  The source
 * is intentionally scoped to the settled session/run pair and is not a
 * public response shape; callers must keep serialized data inside their
 * evidence boundary.
 */
export type RunnerSettlementCollectorInput = Readonly<{
  readonly query: RunnerEventQuery
  readonly summary: TerminalHistorySummary
  readonly source: RunnerEventRowSource
}>

export type RunnerSettlementCollector = (input: RunnerSettlementCollectorInput) => Effect.Effect<void, unknown>

export type TerminalHistoryCollection = Readonly<{
  readonly summary: TerminalHistorySummary
  /** A cached, pair-scoped source over the rows used for terminal validation. */
  readonly source: RunnerEventRowSource
}>

/**
 * Validate the committed terminal boundary without trusting an in-memory
 * DurableRun snapshot. The latest state transition and attempt-finished event
 * must agree with the caller's settlement, and successful/paused runs must
 * retain a semantic cursor unless the caller explicitly opts out. The return
 * value is metadata-only so diagnostics never expose prompts, tool inputs, or
 * provider responses.
 */
export const assertTerminalHistory = (
  history: RunnerHistory,
  expectation: TerminalHistoryExpectation,
): TerminalHistorySummary => {
  if (!Number.isSafeInteger(expectation.attempt) || expectation.attempt < 1)
    throw new DurableHistoryError("Terminal history attempt must be a positive safe integer")
  if (!history.runCreated) throw new DurableHistoryError("Terminal history is missing RunCreated")

  const transition = latest(history.stateChanges)
  if (!transition || transition.to !== expectation.status)
    throw new DurableHistoryError("Terminal history state transition does not match the settled status")

  const attempt = latest(history.attempts)
  if (!attempt || attempt.attempt !== expectation.attempt)
    throw new DurableHistoryError("Terminal history is missing the settled attempt")

  const expectedOutcome =
    expectation.status === "completed" ? "completed" : expectation.status === "failed" ? "failed" : "interrupted"
  if (attempt.outcome !== expectedOutcome)
    throw new DurableHistoryError("Terminal history attempt outcome does not match the settled status")

  const requireCheckpoint = expectation.requireCheckpoint ?? expectation.status === "completed"
  if (requireCheckpoint && !history.checkpoint)
    throw new DurableHistoryError("Terminal history is missing the semantic checkpoint")

  return Object.freeze({
    sessionID: history.sessionID,
    runID: history.runID,
    status: expectation.status,
    attempt: expectation.attempt,
    checkpointPresent: history.checkpoint !== undefined,
    transition: Object.freeze({ from: transition.from, to: transition.to, changedAt: transition.changedAt }),
  })
}

/**
 * Read and validate one terminal run through an injected committed-row source,
 * retaining a cached source for a trusted parity/replay collector. The
 * original source is called exactly once; collectors cannot accidentally read
 * a different database snapshot or a different session/run pair.
 */
export const collectTerminalHistoryWithSource = Effect.fn("SessionRunnerHistory.collectTerminalHistoryWithSource")(
  function* (source: RunnerEventRowSource, input: RunnerEventQuery, expectation: TerminalHistoryExpectation) {
    const events = yield* source.collect(input)
    const cachedRows = Object.freeze(
      events.map((event) => Object.freeze({ ...event })),
    ) as ReadonlyArray<EventV2.SerializedEvent>
    const history = yield* Effect.try({
      try: () => fromEventRows(cachedRows, { sessionID: input.sessionID, runID: input.runID }),
      catch: (cause) =>
        cause instanceof DurableHistoryError
          ? cause
          : new DurableHistoryError("Committed terminal runner history failed strict decoding"),
    })
    const summary = assertTerminalHistory(history, expectation)
    const pairSource = makeRunnerEventRowSource((query) =>
      query.sessionID === input.sessionID && query.runID === input.runID
        ? Effect.succeed(cachedRows)
        : Effect.die(new DurableHistoryError("Terminal history source is scoped to its settled session/run pair")),
    )
    return Object.freeze({ summary, source: pairSource }) satisfies TerminalHistoryCollection
  },
)

/**
 * Read and validate one terminal run through an injected committed-row source.
 * The source owns storage access; this helper owns only strict decoding and
 * the terminal contract, making it safe for both formal and mature roots.
 */
export const collectTerminalHistory = Effect.fn("SessionRunnerHistory.collectTerminalHistory")(function* (
  source: RunnerEventRowSource,
  input: RunnerEventQuery,
  expectation: TerminalHistoryExpectation,
) {
  const collection = yield* collectTerminalHistoryWithSource(source, input, expectation)
  return collection.summary
})

/**
 * Fold the immutable run-created budget with every decoded attempt-finished
 * usage record.  This is intentionally kept beside row decoding so callers
 * cannot accidentally count a hand-written fixture or silently reset a
 * retry budget after restart.
 */
export const budgetFromHistory = (history: Pick<RunnerHistory, "runCreated" | "attempts">): AgentRuntime.Budget => {
  const initial = history.runCreated?.run.budget
  if (!initial) throw new DurableHistoryError("Runner history is missing RunCreated budget")

  // RunCreated contains the durable attempt high-water mark at creation. A
  // finished-attempt history must continue from that mark without gaps: a
  // missing or rolled-back attempt would otherwise make the recovered budget
  // look smaller than the side effects that may already have happened.
  let previousAttempt = initial.attemptsUsed
  let durationMs = 0
  let costMicros = 0
  let tokens = 0
  const add = (current: number, value: number, field: string): number => {
    const next = current + value
    if (!Number.isSafeInteger(next)) throw new DurableHistoryError(`Runner history ${field} usage exceeds safe integer`)
    return next
  }
  for (const attempt of history.attempts) {
    if (attempt.attempt !== previousAttempt + 1)
      throw new DurableHistoryError("Runner history attempt sequence has a gap or rollback")
    previousAttempt = attempt.attempt
    durationMs = add(durationMs, attempt.durationMs, "durationMs")
    costMicros = add(costMicros, attempt.costMicros, "costMicros")
    tokens = add(tokens, attempt.tokens, "tokens")
  }

  const attemptsUsed = add(initial.attemptsUsed, history.attempts.length, "attempts")
  const total = (base: number, delta: number, field: string): number => add(base, delta, field)

  return AgentRuntime.Budget.make({
    ...initial,
    attemptsUsed,
    durationMsUsed: total(initial.durationMsUsed, durationMs, "durationMs"),
    costMicrosUsed: total(initial.costMicrosUsed, costMicros, "costMicros"),
    tokensUsed: total(initial.tokensUsed, tokens, "tokens"),
  })
}

/**
 * Decode the latest semantic checkpoint owned by this history projection.
 * Database/event callers should use this helper instead of decoding raw
 * checkpoint JSON themselves; malformed or missing state is deliberately
 * reduced to a bounded history error before it can enter parity evidence.
 */
export const checkpointFromHistory = (
  history: Pick<RunnerHistory, "sessionID" | "checkpoint">,
): SessionCheckpoint.Decoded => {
  const state = history.checkpoint?.checkpoint.state
  if (state === undefined) throw new DurableHistoryError("Runner history is missing a semantic checkpoint")
  try {
    return SessionCheckpoint.decode(state, history.sessionID)
  } catch {
    throw new DurableHistoryError("Runner history semantic checkpoint failed strict decoding")
  }
}

/**
 * Build execution-only evidence from one immutable history owner.  Provider
 * replay, formal runner, and mature prompt adapters all use this same
 * projection when they have no request-owner event; callers must not reuse a
 * side's already-composed evidence object as another side's durable proof.
 */
export const executionEvidenceFromHistory = (
  history: Pick<RunnerHistory, "sessionID" | "checkpoint" | "runCreated" | "attempts">,
): SessionRunnerEvidence.ExecutionEvidence =>
  SessionRunnerEvidence.fromDurable({
    checkpoint: checkpointFromHistory(history),
    budget: budgetFromHistory(history),
  })

/** Build formal durable evidence directly from one immutable history owner. */
export const formalEvidenceFromHistory = (history: RunnerHistory): SessionRunnerEvidence.FormalDurableEvidence => {
  const request = history.formalRequest
  if (!request) throw new DurableHistoryError("Runner history is missing a formal request event")
  return SessionRunnerEvidence.fromFormalDurable({
    checkpoint: checkpointFromHistory(history),
    budget: budgetFromHistory(history),
    event: { envelope: request.envelope, requestDigest: request.requestDigest },
    runID: history.runID,
  })
}

/** Build mature durable evidence directly from one immutable history owner. */
export const matureEvidenceFromHistory = (history: RunnerHistory): SessionRunnerEvidence.MatureDurableEvidence => {
  const binding = history.matureBinding
  if (!binding) throw new DurableHistoryError("Runner history is missing a mature request binding event")
  return SessionRunnerEvidence.fromMatureDurable({
    checkpoint: checkpointFromHistory(history),
    budget: budgetFromHistory(history),
    binding,
    runID: history.runID,
  })
}

/**
 * Compose the three side-specific histories into one parity evidence bundle.
 * Each side remains an independent immutable history projection, while this
 * function is the only shared entry that assembles the matrix-facing shape.
 * The provider request projection is supplied by its transport adapter because
 * Provider replay has no formal/mature owner event of its own.
 */
export const evidenceFromHistories = (input: {
  readonly provider: RunnerHistory
  readonly formal: RunnerHistory
  readonly mature: RunnerHistory
  readonly providerRequest: RequestProjection
}): Readonly<{
  readonly evidence: Readonly<{
    readonly provider: SessionRunnerEvidence.ExecutionEvidence
    readonly formal: SessionRunnerEvidence.ExecutionEvidence
    readonly mature: SessionRunnerEvidence.ExecutionEvidence
  }>
  readonly requestProjections: Readonly<{
    readonly provider: RequestProjection
    readonly formal: RequestProjection
    readonly mature: RequestProjection
  }>
}> => {
  const projectionErrors = requestProjectionErrors(input.providerRequest)
  if (projectionErrors.length > 0)
    throw new DurableHistoryError(`Provider request projection is invalid: ${projectionErrors.join(", ")}`)
  if (input.providerRequest.runID !== input.provider.runID)
    throw new DurableHistoryError("Provider request projection runID does not match the provider history")

  const formal = formalEvidenceFromHistory(input.formal)
  const mature = matureEvidenceFromHistory(input.mature)
  const provider = executionEvidenceFromHistory(input.provider)
  const requestProjections = Object.freeze({
    provider: Object.freeze({ ...input.providerRequest }),
    formal: formal.request,
    mature: SessionRunnerEvidence.fromMatureBinding(mature.binding, input.mature.runID),
  })
  return Object.freeze({
    evidence: Object.freeze({ provider, formal: formal.execution, mature: mature.execution }),
    requestProjections,
  })
}

/**
 * Compose parity evidence directly from EventV2 serialized rows. Each side is
 * decoded with its logical owner, while all three rows remain independently
 * validated against the same session/run identity. This is the reusable
 * acceptance boundary for queue and the later steer/cancel scenarios.
 */
export const evidenceFromEventRows = (input: {
  readonly providerRows: ReadonlyArray<EventV2.SerializedEvent>
  readonly formalRows: ReadonlyArray<EventV2.SerializedEvent>
  readonly matureRows: ReadonlyArray<EventV2.SerializedEvent>
  readonly sessionID: string
  readonly runID: string
  readonly providerRequest: RequestProjection
}) =>
  evidenceFromHistories({
    provider: fromEventRows(input.providerRows, { sessionID: input.sessionID, runID: input.runID, owner: "provider" }),
    formal: fromEventRows(input.formalRows, { sessionID: input.sessionID, runID: input.runID, owner: "formal" }),
    mature: fromEventRows(input.matureRows, { sessionID: input.sessionID, runID: input.runID, owner: "mature" }),
    providerRequest: input.providerRequest,
  })

export { types as runnerHistoryTypes }
