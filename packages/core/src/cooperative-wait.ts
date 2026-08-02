export * as CooperativeWaitV2 from "./cooperative-wait"

import { CooperativeWait } from "@arforge-ai/schema/wait"
import { Context, DateTime, Deferred, Duration, Effect, Layer, Schema } from "effect"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"

export const ID = CooperativeWait.ID
export type ID = CooperativeWait.ID
export const Reason = CooperativeWait.Reason
export type Reason = CooperativeWait.Reason
export const Info = CooperativeWait.Info
export type Info = CooperativeWait.Info
export const Status = CooperativeWait.Status
export type Status = CooperativeWait.Status
export const Result = CooperativeWait.Result
export type Result = CooperativeWait.Result
export const Event = CooperativeWait.Event

export const MIN_WAIT_SECONDS = 0.05
export const MAX_WAIT_SECONDS = 300
export const MIN_CHECK_IN_SECONDS = 0.05
export const MAX_CHECK_IN_SECONDS = 60
export const MAX_CHECK_INS = 120
const POLL_SECONDS = 0.05

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()(
  "CooperativeWait.InvalidInputError",
  { message: Schema.String },
) {}

export class ActiveWaitError extends Schema.TaggedErrorClass<ActiveWaitError>()(
  "CooperativeWait.ActiveWaitError",
  { sessionID: SessionSchema.ID },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("CooperativeWait.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class StaleIDError extends Schema.TaggedErrorClass<StaleIDError>()("CooperativeWait.StaleIDError", {
  sessionID: SessionSchema.ID,
  waitID: ID,
}) {}

export interface WaitInput {
  readonly sessionID: SessionSchema.ID
  readonly durationSeconds: number
  readonly checkInInterval?: number
  readonly reason?: string
  /** Internal monotonic deadline used by run hosts; omitted for ordinary tool waits. */
  readonly deadlineMonotonic?: number
}

export interface Interface {
  readonly active: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly wake: (input: { readonly sessionID: SessionSchema.ID; readonly waitID: ID }) => Effect.Effect<
    Info & { readonly wakeRequested: true },
    NotFoundError | StaleIDError
  >
  readonly wait: (input: WaitInput) => Effect.Effect<Result, InvalidInputError | ActiveWaitError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/CooperativeWait") {}
class GlobalService extends Context.Service<GlobalService, Interface>()("@arforge/v2/CooperativeWaitGlobal") {}

type ActiveRecord = {
  readonly id: ID
  readonly sessionID: SessionSchema.ID
  readonly reason: Reason
  readonly durationSeconds: number
  readonly checkInInterval: number
  readonly startedMonotonic: number
  readonly startedAt: DateTime.Utc
  readonly wake: Deferred.Deferred<"woken">
  checkInCount: number
}

const globalLayer = Layer.effect(
  GlobalService,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const activeWaits = new Map<SessionSchema.ID, ActiveRecord>()

    const snapshot = (record: ActiveRecord, now = performance.now()): Info => {
      const elapsed = Math.max(0, (now - record.startedMonotonic) / 1_000)
      return {
        waitID: record.id,
        sessionID: record.sessionID,
        reason: record.reason,
        durationSeconds: record.durationSeconds,
        checkInInterval: record.checkInInterval,
        startedAt: record.startedAt,
        elapsedSeconds: rounded(elapsed),
        remainingSeconds: rounded(Math.max(0, record.durationSeconds - elapsed)),
        checkInCount: record.checkInCount,
      }
    }

    const publish = <D extends EventV2.Definition>(definition: D, data: EventV2.Data<D>) =>
      events.publish(definition, data).pipe(Effect.ignore)

    const active: Interface["active"] = (sessionID) =>
      Effect.sync(() => {
        const record = activeWaits.get(sessionID)
        return record && snapshot(record)
      })

    const wake: Interface["wake"] = Effect.fn("CooperativeWait.wake")(function* (input) {
      const record = activeWaits.get(input.sessionID)
      if (!record) return yield* new NotFoundError({ sessionID: input.sessionID })
      if (record.id !== input.waitID)
        return yield* new StaleIDError({ sessionID: input.sessionID, waitID: input.waitID })
      const info = snapshot(record)
      yield* Deferred.succeed(record.wake, "woken")
      return { ...info, wakeRequested: true as const }
    })

    const wait: Interface["wait"] = Effect.fn("CooperativeWait.wait")(function* (input) {
      const interval = input.checkInInterval ?? 30
      if (
        !Number.isFinite(input.durationSeconds) ||
        input.durationSeconds < MIN_WAIT_SECONDS ||
        input.durationSeconds > MAX_WAIT_SECONDS
      )
        return yield* invalid(`durationSeconds must be between ${MIN_WAIT_SECONDS} and ${MAX_WAIT_SECONDS}`)
      if (!Number.isFinite(interval) || interval < MIN_CHECK_IN_SECONDS || interval > MAX_CHECK_IN_SECONDS)
        return yield* invalid(`checkInInterval must be between ${MIN_CHECK_IN_SECONDS} and ${MAX_CHECK_IN_SECONDS}`)
      if (input.durationSeconds / interval > MAX_CHECK_INS)
        return yield* invalid(`wait would exceed the maximum of ${MAX_CHECK_INS} check-ins`)
      const reasonText = (input.reason ?? "").trim().replace(/\s+/g, " ")
      if (reasonText.length > 200) return yield* invalid("reason must be at most 200 characters")
      if (activeWaits.has(input.sessionID)) return yield* new ActiveWaitError({ sessionID: input.sessionID })

      const startedMonotonic = performance.now()
      const record: ActiveRecord = {
        id: ID.create(),
        sessionID: input.sessionID,
        reason: Reason.make(reasonText),
        durationSeconds: input.durationSeconds,
        checkInInterval: interval,
        startedMonotonic,
        startedAt: DateTime.makeUnsafe(Date.now()),
        wake: yield* Deferred.make<"woken">(),
        checkInCount: 0,
      }
      activeWaits.set(input.sessionID, record)
      yield* publish(Event.Started, { wait: snapshot(record, startedMonotonic) })

      let nextCheckIn = startedMonotonic + interval * 1_000
      const loop: Effect.Effect<"completed" | "woken" | "timed_out"> = Effect.suspend(() => {
        const now = performance.now()
        if (input.deadlineMonotonic !== undefined && now >= input.deadlineMonotonic)
          return Effect.succeed("timed_out")
        if (now - startedMonotonic >= input.durationSeconds * 1_000) return Effect.succeed("completed")
        const remaining = input.durationSeconds * 1_000 - (now - startedMonotonic)
        const untilCheckIn = Math.max(0, nextCheckIn - now)
        const untilDeadline =
          input.deadlineMonotonic === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(0, input.deadlineMonotonic - now)
        const delay = Math.max(1, Math.min(POLL_SECONDS * 1_000, remaining, untilCheckIn, untilDeadline))
        return Effect.raceFirst(
          Deferred.await(record.wake),
          Effect.sleep(Duration.millis(delay)).pipe(Effect.as("tick" as const)),
        ).pipe(
          Effect.flatMap((signal) => {
            if (signal === "woken") return Effect.succeed("woken" as const)
            const checkedAt = performance.now()
            if (checkedAt >= nextCheckIn) {
              record.checkInCount++
              nextCheckIn = checkedAt + interval * 1_000
              return publish(Event.CheckIn, { wait: snapshot(record, checkedAt) }).pipe(Effect.andThen(loop))
            }
            return loop
          }),
        )
      })

      const cancelled = Effect.uninterruptible(
        Effect.sync(() => terminal(record, "cancelled")).pipe(
          Effect.flatMap((result) => publish(Event.Cancelled, { wait: result })),
        ),
      )
      const status = yield* loop.pipe(
        Effect.onInterrupt(() => cancelled),
        Effect.ensuring(
          Effect.sync(() => {
            if (activeWaits.get(input.sessionID) === record) activeWaits.delete(input.sessionID)
          }),
        ),
      )
      const result = terminal(record, status)
      yield* publish(
        status === "completed" ? Event.Completed : status === "woken" ? Event.Woken : Event.TimedOut,
        { wait: result },
      )
      return result
    })

    return GlobalService.of({ active, wake, wait })
  }),
)

const invalid = (message: string) => Effect.fail(new InvalidInputError({ message }))
const rounded = (value: number) => Math.round(value * 1_000) / 1_000
const terminal = (record: ActiveRecord, status: Status): Result => {
  const elapsed = Math.max(0, (performance.now() - record.startedMonotonic) / 1_000)
  return {
    waitID: record.id,
    sessionID: record.sessionID,
    reason: record.reason,
    durationSeconds: record.durationSeconds,
    checkInInterval: record.checkInInterval,
    startedAt: record.startedAt,
    elapsedSeconds: rounded(elapsed),
    remainingSeconds: rounded(Math.max(0, record.durationSeconds - elapsed)),
    checkInCount: record.checkInCount,
    status,
    finishedAt: DateTime.makeUnsafe(Date.now()),
  }
}

const globalNode = makeGlobalNode({ service: GlobalService, layer: globalLayer, deps: [EventV2.node] })
const locationLayer = Layer.effect(Service, GlobalService.use((waits) => Effect.succeed(Service.of(waits))))

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [globalNode],
})
