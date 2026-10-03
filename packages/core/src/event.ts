export * as EventV2 from "./event"

import { Cause, Context, Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { Event } from "@arforge-ai/schema/event"
import type { Data, Definition, Payload } from "@arforge-ai/schema/event"
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm"
import { Database } from "./database/database"
import { EventSequenceTable, EventTable } from "./event/sql"
import { Location } from "./location"
import { makeGlobalNode } from "./effect/app-node"
import { isDeepStrictEqual } from "node:util"
import { Durable } from "@arforge-ai/schema/durable-event-manifest"

export const ID = Event.ID
export type ID = import("@arforge-ai/schema/event").ID
export type { Data, Definition, Payload } from "@arforge-ai/schema/event"

export type Subscriber<D extends Definition = Definition> = (event: Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("EventV2.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

/**
 * Read the last committed event for one durable aggregate.
 *
 * EventV2 deliberately keeps the database query here instead of making
 * projection owners reach into EventTable.  The raw serialized shape is
 * returned so the consumer can decode only the event family it owns. This
 * method intentionally does not require the global manifest: tests and
 * package-local projections may publish durable definitions that are not part
 * of the process-wide inventory. This is the bounded counterpart to
 * `durable()`, which is a
 * historical-plus-live stream and therefore must not be collected during
 * startup.
 */
export const latest = Effect.fn("EventV2.latest")(function* (db: Database.Interface["db"], aggregateID: string) {
  const row = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, aggregateID))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined

  const event: SerializedEvent = {
    id: row.id,
    type: row.type,
    seq: row.seq,
    aggregateID: row.aggregate_id,
    data: row.data,
  }
  return event
})

export type SerializedEvent = {
  readonly id: ID
  readonly type: string
  readonly seq: number
  readonly aggregateID: string
  readonly data: Record<string, unknown>
}

/** Verify a publish receipt against its exact committed row, not the latest
 * aggregate event (which may already belong to another publication). */
export const readCommitted = Effect.fn("EventV2.readCommitted")(function* <D extends Definition>(
  db: Database.Interface["db"],
  definition: D,
  receipt: Payload<D>,
) {
  const durable = definition.durable
  const binding = receipt.durable
  if (!durable || !binding || receipt.type !== definition.type || binding.version !== durable.version)
    return yield* Effect.die(new Error("Event publication has no matching durable receipt"))
  const row = yield* db.select().from(EventTable).where(eq(EventTable.id, receipt.id)).get().pipe(Effect.orDie)
  if (
    !row ||
    row.aggregate_id !== binding.aggregateID ||
    row.seq !== binding.seq ||
    row.type !== versionedType(definition.type, durable.version)
  )
    return yield* Effect.die(new Error("Committed event identity does not match its publication receipt"))
  // Round-trip through the definition's JSON codec exactly as durable storage
  // does, so optional undefined values are not confused with stored fields.
  const encoded = Schema.encodeUnknownSync(Schema.fromJsonString(definition.data))(receipt.data)
  const expected = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(encoded)
  if (!isDeepStrictEqual(row.data, expected))
    return yield* Effect.die(new Error("Committed event data does not match its publication receipt"))
  return {
    id: row.id,
    type: row.type,
    aggregateID: row.aggregate_id,
    seq: row.seq,
    data: row.data,
  } satisfies SerializedEvent
})

/**
 * Read committed durable rows for a bounded set of aggregates without
 * decoding them through the global manifest.  Projection owners use this
 * serialized boundary when they need to retain event identity and sequence
 * before applying their own strict schema; writes and sequence ownership stay
 * inside EventV2.
 */
export const readSerialized = Effect.fn("EventV2.readSerialized")(function* (
  db: Database.Interface["db"],
  input: Readonly<{
    readonly aggregateIDs: ReadonlyArray<string>
    /** Exact persisted (versioned) event types. Omission reads all; empty selects none. */
    readonly types?: ReadonlyArray<string>
  }>,
) {
  const aggregateIDs = [...new Set(input.aggregateIDs)]
  if (
    aggregateIDs.length === 0 ||
    aggregateIDs.some((aggregateID) => typeof aggregateID !== "string" || aggregateID.length === 0)
  )
    return yield* Effect.die(new Error("EventV2 serialized read requires at least one non-empty aggregateID"))
  const types = input.types === undefined ? undefined : [...new Set(input.types)]
  if (types?.some((type) => typeof type !== "string" || type.length === 0))
    return yield* Effect.die(new Error("EventV2 serialized read requires non-empty event types"))
  if (types?.length === 0) return []

  const rows = yield* db
    .select({
      id: EventTable.id,
      type: EventTable.type,
      seq: EventTable.seq,
      aggregateID: EventTable.aggregate_id,
      data: EventTable.data,
    })
    .from(EventTable)
    .where(
      and(
        inArray(EventTable.aggregate_id, aggregateIDs),
        types === undefined ? undefined : inArray(EventTable.type, types),
      ),
    )
    .orderBy(asc(EventTable.aggregate_id), asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)

  return rows.map(
    (row) =>
      ({
        id: row.id,
        type: row.type,
        seq: row.seq,
        aggregateID: row.aggregateID,
        data: row.data,
      }) satisfies SerializedEvent,
  )
})

/**
 * Result returned by the transaction-bound durable event writer.
 *
 * This helper intentionally performs only the EventV2 SQL portion of a
 * commit.  It does not publish to PubSub and does not open another
 * transaction; a caller that is coordinating multiple owners must invoke it
 * with the coordinator's transaction handle and publish notifications only
 * after the outer transaction has committed.
 */
export interface DurableTransactionCommitResult {
  readonly aggregateID: string
  readonly seq: number
  readonly event: Payload
  /** False means the exact replay already existed and no notification is needed. */
  readonly inserted: boolean
}

export interface DurableTransactionCommitInput {
  readonly transaction: Database.Transaction
  readonly definition: Definition
  readonly event: Payload
  readonly expectedSequence?: number
  readonly replay?: Readonly<{
    readonly seq: number
    readonly aggregateID: string
    readonly ownerID?: string
    readonly strictOwner?: boolean
  }>
  /** Optional projection work which must complete before the event row is inserted. */
  readonly beforeInsert?: (event: Payload, seq: number, transaction: Database.Transaction) => Effect.Effect<void>
}

/**
 * Persist one durable EventV2 row on an already-open transaction.
 *
 * The checks mirror the established EventV2 commit path: aggregate identity,
 * expected sequence, replay idempotency, owner fencing and event-ID
 * uniqueness are all enforced before the insert.  Keeping this primitive in
 * EventV2 lets DurableRun and future settlement adapters share the exact
 * sequence/serialization rules instead of writing a parallel event table.
 */
export const commitDurableEventInTransaction = Effect.fn("EventV2.commitDurableEventInTransaction")(function* (
  input: DurableTransactionCommitInput,
) {
  const durable = input.definition?.durable
  if (!durable) {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: "Transaction-bound commits require a durable EventV2 definition",
      }),
    )
  }
  if (
    input.event.type !== input.definition.type ||
    typeof input.event.id !== "string" ||
    !input.event.id.startsWith("evt_")
  ) {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: "Transaction-bound event identity does not match its definition",
      }),
    )
  }
  const data = input.event.data as Record<string, unknown>
  const aggregateID = data[durable.aggregate]
  if (typeof aggregateID !== "string") {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Expected string aggregate field ${durable.aggregate}`,
      }),
    )
  }
  if (input.replay && input.replay.aggregateID !== aggregateID) {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Aggregate mismatch: expected ${input.replay.aggregateID}, got ${aggregateID}`,
      }),
    )
  }
  const row = yield* input.transaction
    .select({ seq: EventSequenceTable.seq, ownerID: EventSequenceTable.owner_id })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  const latest = row?.seq ?? -1
  if (input.expectedSequence !== undefined && latest !== input.expectedSequence)
    return yield* Effect.die(new AggregateSequenceConflictError(aggregateID, input.expectedSequence, latest))

  const encoded = Schema.encodeUnknownSync(input.definition.data)(input.event.data) as Record<string, unknown>
  if (input.replay?.strictOwner && row?.ownerID && row.ownerID !== input.replay.ownerID) {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Replay owner mismatch for aggregate ${aggregateID}: expected ${row.ownerID}, got ${input.replay.ownerID ?? "none"}`,
      }),
    )
  }
  if (input.replay && input.replay.seq <= latest) {
    const stored = yield* input.transaction
      .select()
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, aggregateID), eq(EventTable.seq, input.replay.seq)))
      .get()
      .pipe(Effect.orDie)
    if (
      stored?.id === input.event.id &&
      stored.type === versionedType(input.definition.type, durable.version) &&
      isDeepStrictEqual(stored.data, encoded)
    ) {
      if (input.replay.ownerID && row?.ownerID == null) {
        yield* input.transaction
          .update(EventSequenceTable)
          .set({ owner_id: input.replay.ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }
      return {
        aggregateID,
        seq: input.replay.seq,
        event: {
          ...input.event,
          durable: { aggregateID, seq: input.replay.seq, version: durable.version },
        },
        inserted: false,
      } satisfies DurableTransactionCommitResult
    }
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Replay diverged at aggregate ${aggregateID} sequence ${input.replay.seq}`,
      }),
    )
  }
  if (input.replay && row?.ownerID && row.ownerID !== input.replay.ownerID) return undefined
  const seq = input.replay?.seq ?? latest + 1
  if (input.replay && seq !== latest + 1) {
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Sequence mismatch for aggregate ${aggregateID}: expected ${latest + 1}, got ${seq}`,
      }),
    )
  }
  const stored = yield* input.transaction
    .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
    .from(EventTable)
    .where(eq(EventTable.id, input.event.id))
    .get()
    .pipe(Effect.orDie)
  if (stored)
    return yield* Effect.die(
      new InvalidDurableEventError({
        type: input.event.type,
        message: `Event ${input.event.id} already exists at aggregate ${stored.aggregateID} sequence ${stored.seq}`,
      }),
    )
  const committedEvent = {
    ...input.event,
    durable: { aggregateID, seq, version: durable.version },
  } as Payload
  if (input.beforeInsert) yield* input.beforeInsert(committedEvent, seq, input.transaction)
  yield* input.transaction
    .insert(EventSequenceTable)
    .values([{ aggregate_id: aggregateID, seq, owner_id: input.replay?.ownerID }])
    .onConflictDoUpdate({
      target: EventSequenceTable.aggregate_id,
      set: {
        seq,
        ...(input.replay?.ownerID && row?.ownerID == null ? { owner_id: input.replay.ownerID } : {}),
      },
    })
    .run()
    .pipe(Effect.orDie)
  yield* input.transaction
    .insert(EventTable)
    .values([
      {
        id: input.event.id,
        aggregate_id: aggregateID,
        seq,
        type: versionedType(input.definition.type, durable.version),
        data: encoded,
      },
    ])
    .run()
    .pipe(Effect.orDie)
  return { aggregateID, seq, event: committedEvent, inserted: true } satisfies DurableTransactionCommitResult
})

export class InvalidDurableEventError extends Schema.TaggedErrorClass<InvalidDurableEventError>()(
  "EventV2.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

export class AggregateSequenceConflictError extends Error {
  readonly _tag = "EventV2.AggregateSequenceConflict"
  constructor(
    readonly aggregateID: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Aggregate ${aggregateID} changed: expected sequence ${expected}, found ${actual}`)
  }
}

/**
 * Determines whether a defect is a transient database error that can be
 * safely retried for event commits.
 *
 * In PostgreSQL mode the SQLite-specific `BEGIN IMMEDIATE` serialization is
 * unavailable, so concurrent transactions targeting the same aggregate can
 * race on the (aggregate_id, seq) unique index. Because the transaction
 * recalculates `seq` from the latest committed value on every attempt, the
 * entire operation is idempotent and safe to retry.
 *
 * Error wrapping chain (PostgreSQL):
 *   pg driver → SqlError (@effect/sql) → EffectDrizzleQueryError (drizzle-orm) → orDie → defect
 *
 * The EffectDrizzleQueryError stores the original SqlError inside its `cause`
 * field as `Cause.fail(sqlError)`, so we must unwrap both layers.
 */
function isRetryableSqlError(error: unknown): boolean {
  if (!isSqlError(error)) return false
  const reason = error.reason
  switch (reason._tag) {
    case "UniqueViolation":
      // Retry only sequence-index conflicts; other unique violations (e.g.
      // duplicate event ID) indicate logic bugs that must not be masked.
      return reason.constraint.includes("event_aggregate_seq")
    case "DeadlockError":
    case "SerializationError":
    case "LockTimeoutError":
    case "ConnectionError":
    case "StatementTimeoutError":
      return true
    default:
      return false
  }
}

function isRetryableCommitDefect(defect: unknown): boolean {
  // Direct SqlError (SQLite path or unwrapped pg errors)
  if (isRetryableSqlError(defect)) return true
  // EffectDrizzleQueryError wrapping a SqlError (PostgreSQL path via drizzle-orm)
  if (
    typeof defect === "object" &&
    defect !== null &&
    "_tag" in defect &&
    (defect as Record<string, unknown>)._tag === "EffectDrizzleQueryError" &&
    "cause" in defect
  ) {
    const inner = (defect as { cause: unknown }).cause
    if (Cause.isCause(inner)) {
      return inner.reasons.filter(Cause.isFailReason).some((r) => isRetryableSqlError(r.error))
    }
  }
  return false
}

const COMMIT_RETRY_TIMES = 5
const COMMIT_RETRY_BASE_MS = 5

const decodeSerializedEvent = (event: SerializedEvent): Payload => {
  const definition = Durable.get(event.type)
  if (!definition?.durable) {
    throw new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` })
  }
  return {
    id: event.id,
    type: definition.type,
    durable: { aggregateID: event.aggregateID, seq: event.seq, version: definition.durable.version },
    data: Schema.decodeUnknownSync(definition.data)(event.data),
  }
}

export const readAggregate = Effect.fn("EventV2.readAggregate")(function* <A>(
  db: Database.Interface["db"],
  input: {
    readonly aggregateID: string
    readonly after?: number
    readonly limit: number
    /** Validate the complete raw aggregate before paging. Projection readers may opt into this strict path. */
    readonly strict?: boolean
    readonly manifest: {
      readonly definitions: ReadonlyMap<string, Definition>
      readonly schema: Schema.Decoder<A, never>
    }
  },
) {
  const after = input.after ?? -1
  if (input.strict) {
    const rows = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, input.aggregateID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    const decode = Schema.decodeUnknownSync(input.manifest.schema, {
      errors: "all",
      onExcessProperty: "error",
      propertyOrder: "original",
    })
    const events = rows.map((event, expectedSequence) => {
      if (event.seq !== expectedSequence) {
        throw new InvalidDurableEventError({
          type: event.type,
          message: `Durable aggregate history is not contiguous; expected sequence ${expectedSequence}, got ${event.seq}`,
        })
      }
      const definition = input.manifest.definitions.get(event.type)
      if (!definition?.durable) {
        throw new InvalidDurableEventError({
          type: event.type,
          message: `Unknown durable event type ${event.type} exists in the aggregate manifest`,
        })
      }
      try {
        return decode({
          id: event.id,
          type: definition.type,
          durable: {
            aggregateID: event.aggregate_id,
            seq: event.seq,
            version: definition.durable.version,
          },
          data: event.data,
        })
      } catch {
        throw new InvalidDurableEventError({
          type: event.type,
          message: `Durable event ${event.type} failed strict schema decoding`,
        })
      }
    })
    const start = Math.max(0, after + 1)
    const available = events.slice(start)
    const page = available.slice(0, input.limit)
    return {
      events: page,
      hasMore: page.length < available.length,
    }
  }

  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.aggregateID),
        gt(EventTable.seq, after),
        inArray(EventTable.type, Array.from(input.manifest.definitions.keys())),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const page = rows.slice(0, input.limit)
  const decode = Schema.decodeUnknownSync(input.manifest.schema)
  const events = page.map((event) =>
    decode({
      id: event.id,
      type: input.manifest.definitions.get(event.type)?.type ?? event.type,
      durable: {
        aggregateID: event.aggregate_id,
        seq: event.seq,
        version: input.manifest.definitions.get(event.type)?.durable?.version,
      },
      data: event.data,
    }),
  )
  return {
    events,
    hasMore: rows.length > input.limit,
  }
})

export class SubscriberOverflowError extends Schema.TaggedErrorClass<SubscriberOverflowError>()(
  "EventV2.SubscriberOverflow",
  { capacity: Schema.Int },
) {}

export const define = Event.define
export const versionedType = Event.versionedType

export interface PublishOptions {
  readonly id?: ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  /** Commit only while the durable aggregate remains at this sequence. */
  readonly expectedSequence?: number
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export interface Interface {
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>
  readonly subscribe: <D extends Definition>(definition: D) => Stream.Stream<Payload<D>>
  readonly all: () => Stream.Stream<Payload>
  readonly durable: (input: { readonly aggregateID: string; readonly after?: number }) => Stream.Stream<Payload>
  /** Read the last committed durable event without opening an unbounded stream.
   * Optional for lightweight test/adaptor implementations; the built-in
   * EventV2 layer always provides it. */
  readonly latest?: (aggregateID: string) => Effect.Effect<SerializedEvent | undefined>
  /** Read committed serialized durable rows for bounded projection recovery. */
  readonly readSerialized?: (input: {
    readonly aggregateIDs: ReadonlyArray<string>
  }) => Effect.Effect<ReadonlyArray<SerializedEvent>>
  /** @deprecated Use `all()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  readonly replay: (
    event: SerializedEvent,
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<void>
  readonly replayAll: (
    events: SerializedEvent[],
    options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
  ) => Effect.Effect<string | undefined>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/Event") {}

export const allBounded = (events: Interface, capacity: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(capacity)
    const unsubscribe = yield* events.listen((event) =>
      Queue.offer(queue, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Effect.void : Queue.fail(queue, new SubscriberOverflowError({ capacity })).pipe(Effect.asVoid),
        ),
      ),
    )
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid))
    return Stream.fromQueue(queue)
  })

export interface LayerOptions {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
}

export const layerWith = (options?: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const pubsub = {
        all: yield* PubSub.unbounded<Payload>(),
        durable: new Map<string, Set<PubSub.PubSub<void>>>(),
        typed: new Map<string, PubSub.PubSub<Payload>>(),
      }
      const projectors = new Map<string, Subscriber[]>()
      // TODO: Bind durable projectors to exact type+version before supporting incompatible historical payloads.
      const listeners = new Array<Subscriber>()
      const { db } = yield* Database.Service

      const getOrCreate = (definition: Definition) =>
        Effect.gen(function* () {
          const existing = pubsub.typed.get(definition.type)
          if (existing) return existing
          const created = yield* PubSub.unbounded<Payload>()
          pubsub.typed.set(definition.type, created)
          return created
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* PubSub.shutdown(pubsub.all)
          yield* Effect.forEach(
            pubsub.durable.values(),
            (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
            { discard: true },
          )
          yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
        }),
      )

      function commitDurableEvent(
        definition: Definition,
        event: Payload,
        input?: {
          readonly seq: number
          readonly aggregateID: string
          readonly ownerID?: string
          readonly strictOwner?: boolean
        },
        commit?: (seq: number) => Effect.Effect<void>,
        expectedSequence?: number,
      ) {
        return Effect.gen(function* () {
          const durable = definition?.durable
          if (durable) {
            const aggregateID = (event.data as Record<string, unknown>)[durable.aggregate]
            if (typeof aggregateID !== "string") {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Expected string aggregate field ${durable.aggregate}`,
                }),
              )
            } else {
              if (input && input.aggregateID !== aggregateID) {
                yield* Effect.die(
                  new InvalidDurableEventError({
                    type: event.type,
                    message: `Aggregate mismatch: expected ${input.aggregateID}, got ${aggregateID}`,
                  }),
                )
              }
              const list = projectors.get(event.type) ?? []
              const commitOnce = Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* db
                    .transaction(
                      (tx) =>
                        commitDurableEventInTransaction({
                          transaction: tx,
                          definition,
                          event,
                          replay: input,
                          expectedSequence,
                          beforeInsert: (committed, seq) =>
                            Effect.gen(function* () {
                              for (const projector of list) yield* projector(committed)
                              if (commit) yield* commit(seq)
                            }),
                        }),
                      { behavior: "immediate" },
                    )
                    .pipe(Effect.orDie)
                  if (committed?.inserted) {
                    yield* Effect.forEach(
                      pubsub.durable.get(committed.aggregateID) ?? [],
                      (wake) => PubSub.publish(wake, undefined),
                      { discard: true },
                    )
                  }
                  return committed?.inserted ? committed : undefined
                }),
              )
              // Retry transient database conflicts (unique-index races on the
              // event sequence, deadlocks, serialization failures). The entire
              // transaction is idempotent: seq is recalculated from the latest
              // committed value on each attempt.
              for (let attempt = 0; ; attempt++) {
                const exit = yield* Effect.exit(commitOnce)
                if (exit._tag === "Success") return exit.value
                const cause = exit.cause
                const retryable = cause.reasons.filter(Cause.isDieReason).some((r) => isRetryableCommitDefect(r.defect))
                if (!retryable || attempt >= COMMIT_RETRY_TIMES) {
                  if (retryable) {
                    yield* Effect.logWarning("Event commit conflict exhausted retries", {
                      aggregateID,
                      attempts: attempt + 1,
                    })
                  } else {
                    // Surface the underlying error for diagnosis of persistent failures.
                    const detail = cause.reasons
                      .filter(Cause.isDieReason)
                      .map((r) => {
                        const d = r.defect as Record<string, unknown>
                        if (d && typeof d === "object" && "cause" in d && Cause.isCause(d.cause)) {
                          const inner = d.cause.reasons.filter(Cause.isFailReason).map((f) => String(f.error))
                          return `${d._tag ?? "defect"}: ${inner.join(", ")}`
                        }
                        return String(d)
                      })
                      .join("; ")
                    yield* Effect.logError("Event commit failed (non-retryable)", {
                      aggregateID,
                      detail,
                    })
                  }
                  return yield* Effect.failCause(cause)
                }
                // Exponential backoff with jitter: base * 2^attempt ± 50%
                const base = COMMIT_RETRY_BASE_MS * 2 ** attempt
                const jitter = base * (0.5 + Math.random())
                yield* Effect.sleep(`${Math.round(jitter)} millis`)
              }
            }
          }
        })
      }

      function publishEvent<D extends Definition>(
        definition: D,
        event: Payload<D>,
        commit?: PublishOptions["commit"],
        expectedSequence?: number,
      ) {
        return Effect.gen(function* () {
          if (!definition?.durable && commit)
            return yield* Effect.die(
              new InvalidDurableEventError({
                type: event.type,
                message: "Local commit hooks require a durable event",
              }),
            )
          if (definition?.durable) {
            const committed = yield* commitDurableEvent(
              definition,
              event as Payload,
              undefined,
              commit,
              expectedSequence,
            )
            if (committed) {
              event = {
                ...event,
                durable: {
                  aggregateID: committed.aggregateID,
                  seq: committed.seq,
                  version: definition.durable.version,
                },
              }
              yield* notify(event as Payload, true)
              return event
            }
          }
          yield* notify(event as Payload, false)
          return event
        })
      }

      const observe = (event: Payload, observer: (event: Payload) => Effect.Effect<void>) =>
        Effect.suspend(() => observer(event)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
          ),
        )

      function notify(event: Payload, isolateListeners: boolean) {
        return Effect.gen(function* () {
          yield* Effect.forEach(
            listeners,
            (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
            { discard: true },
          )
          const typed = pubsub.typed.get(event.type)
          if (typed) yield* PubSub.publish(typed, event)
          yield* PubSub.publish(pubsub.all, event)
        })
      }

      function publish<D extends Definition>(definition: D, data: Data<D>, options?: PublishOptions) {
        return Effect.gen(function* () {
          const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
          const location =
            options?.location ??
            (serviceLocation
              ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
              : undefined)
          return yield* publishEvent(
            definition,
            {
              id: options?.id ?? ID.create(),
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Payload<D>,
            options?.commit,
            options?.expectedSequence,
          )
        })
      }

      function replay(
        event: SerializedEvent,
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const definition = Durable.get(event.type)
          if (!definition?.durable) {
            yield* Effect.die(
              new InvalidDurableEventError({ type: event.type, message: `Unknown durable event type ${event.type}` }),
            )
          } else {
            const payload = {
              id: event.id,
              type: definition.type,
              data: Schema.decodeUnknownSync(definition.data)(event.data),
            } as Payload
            const committed = yield* commitDurableEvent(definition, payload, {
              seq: event.seq,
              aggregateID: event.aggregateID,
              ownerID: options?.ownerID,
              strictOwner: options?.strictOwner,
            })
            if (committed && options?.publish) {
              yield* notify(
                {
                  ...payload,
                  durable: {
                    aggregateID: committed.aggregateID,
                    seq: committed.seq,
                    version: definition.durable.version,
                  },
                },
                true,
              )
            }
          }
        })
      }

      function replayAll(
        events: SerializedEvent[],
        options?: { readonly publish?: boolean; readonly ownerID?: string; readonly strictOwner?: boolean },
      ) {
        return Effect.gen(function* () {
          const source = events[0]?.aggregateID
          if (!source) return undefined
          if (events.some((event) => event.aggregateID !== source)) {
            yield* Effect.die(
              new InvalidDurableEventError({
                type: events[0]?.type ?? "unknown",
                message: "Replay events must belong to the same aggregate",
              }),
            )
          }
          const start = events[0]?.seq ?? 0
          for (const [index, event] of events.entries()) {
            const seq = start + index
            if (event.seq !== seq) {
              yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `Replay sequence mismatch at index ${index}: expected ${seq}, got ${event.seq}`,
                }),
              )
            }
          }
          for (const event of events) {
            yield* replay(event, options)
          }
          return source
        })
      }

      function remove(aggregateID: string) {
        return db
          .transaction(() =>
            Effect.gen(function* () {
              yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
              yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
            }),
          )
          .pipe(Effect.orDie)
      }

      function claim(aggregateID: string, ownerID: string) {
        return db
          .update(EventSequenceTable)
          .set({ owner_id: ownerID })
          .where(eq(EventSequenceTable.aggregate_id, aggregateID))
          .run()
          .pipe(Effect.orDie)
      }

      const subscribe = <D extends Definition>(definition: D): Stream.Stream<Payload<D>> =>
        Stream.unwrap(getOrCreate(definition).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))).pipe(
          Stream.map((event) => event as Payload<D>),
        )

      const streamAll = (): Stream.Stream<Payload> => Stream.fromPubSub(pubsub.all)

      const readAfter = (aggregateID: string, after: number) =>
        (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
          Effect.andThen(
            db
              .select()
              .from(EventTable)
              .where(and(eq(EventTable.aggregate_id, aggregateID), gt(EventTable.seq, after)))
              .orderBy(asc(EventTable.seq))
              .all(),
          ),
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((event) =>
              decodeSerializedEvent({
                id: event.id,
                aggregateID: event.aggregate_id,
                seq: event.seq,
                type: event.type,
                data: event.data,
              }),
            ),
          ),
        )

      const subscribeDurable = (aggregateID: string) =>
        Effect.gen(function* () {
          const wake = yield* PubSub.sliding<void>(1)
          const subscription = yield* PubSub.subscribe(wake)
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const wakes = pubsub.durable.get(aggregateID) ?? new Set()
              wakes.add(wake)
              pubsub.durable.set(aggregateID, wakes)
            }),
            () =>
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID)
                wakes?.delete(wake)
                if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
              }).pipe(Effect.andThen(PubSub.shutdown(wake))),
          )
          return subscription
        })

      const durable = (input: { readonly aggregateID: string; readonly after?: number }): Stream.Stream<Payload> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const wakes = yield* subscribeDurable(input.aggregateID)
            let sequence = input.after ?? -1
            const read = Effect.suspend(() => readAfter(input.aggregateID, sequence)).pipe(
              Effect.tap((events) =>
                Effect.sync(() => {
                  sequence = events.at(-1)?.durable?.seq ?? sequence
                }),
              ),
            )
            const historical = yield* read
            const live = Stream.fromSubscription(wakes).pipe(
              Stream.mapEffect(() => read),
              Stream.flattenIterable,
            )
            return Stream.concat(Stream.fromIterable(historical), live)
          }),
        )

      const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
        Effect.sync(() => {
          listeners.push(listener)
          return Effect.sync(() => {
            const index = listeners.indexOf(listener)
            if (index >= 0) listeners.splice(index, 1)
          })
        })

      const project = <D extends Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
        Effect.sync(() => {
          const list = projectors.get(definition.type) ?? []
          list.push((event) => projector(event as Payload<D>))
          projectors.set(definition.type, list)
        })

      return Service.of({
        publish,
        subscribe,
        all: streamAll,
        durable,
        latest: (aggregateID: string) => latest(db, aggregateID),
        readSerialized: (input) => readSerialized(db, input),
        listen,
        project,
        replay,
        replayAll,
        remove,
        claim,
      })
    }),
  )

const layer = layerWith()
export const node = makeGlobalNode({ service: Service, layer: layer, deps: [Database.node] })
