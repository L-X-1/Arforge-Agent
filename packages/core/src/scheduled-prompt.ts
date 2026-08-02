export * as ScheduledPromptV2 from "./scheduled-prompt"

import { and, asc, count, eq, isNull, lt, lte, or } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schedule, Schema } from "effect"
import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { PromptInput } from "@arforge-ai/schema/prompt-input"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SessionV2 } from "./session"
import { ScheduledPromptTable } from "./session/sql"
import { CronSchedule } from "./scheduled-prompt/cron"
import { PositiveInt } from "./schema"

export const ID = ScheduledPrompt.ID
export type ID = ScheduledPrompt.ID
export const Name = ScheduledPrompt.Name
export type Name = ScheduledPrompt.Name
export const Cron = ScheduledPrompt.Cron
export type Cron = ScheduledPrompt.Cron
export const Prompt = ScheduledPrompt.Prompt
export type Prompt = ScheduledPrompt.Prompt
export const Status = ScheduledPrompt.Status
export type Status = ScheduledPrompt.Status
export const Info = ScheduledPrompt.Info
export type Info = ScheduledPrompt.Info
export const InvalidCronError = CronSchedule.InvalidCronError
export type InvalidCronError = CronSchedule.InvalidCronError

const Lifetime = 7 * 24 * 60 * 60 * 1_000
const LeaseDuration = 30_000
const MaximumPerSession = 64

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ScheduledPrompt.NotFoundError", {
  sessionID: SessionV2.ID,
  scheduleID: ID,
}) {}

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("ScheduledPrompt.LimitError", {
  sessionID: SessionV2.ID,
  limit: PositiveInt,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()(
  "ScheduledPrompt.InvalidStateError",
  {
    scheduleID: ID,
    status: Status,
    action: Schema.String,
  },
) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
  "ScheduledPrompt.StaleRevisionError",
  {
    scheduleID: ID,
    expectedRevision: PositiveInt,
    actualRevision: PositiveInt,
  },
) {}

export class NameConflictError extends Schema.TaggedErrorClass<NameConflictError>()(
  "ScheduledPrompt.NameConflictError",
  {
    sessionID: SessionV2.ID,
    name: Name,
  },
) {}

export interface Interface {
  readonly create: (input: {
    readonly sessionID: SessionV2.ID
    readonly name: Name
    readonly cron: Cron
    readonly prompt: Prompt
    readonly recurring?: boolean
    readonly durable?: boolean
  }) => Effect.Effect<Info, InvalidCronError | LimitError | NameConflictError | SessionV2.NotFoundError>
  readonly list: (sessionID: SessionV2.ID) => Effect.Effect<ReadonlyArray<Info>, SessionV2.NotFoundError>
  readonly get: (input: {
    readonly sessionID: SessionV2.ID
    readonly scheduleID: ID
  }) => Effect.Effect<Info, NotFoundError | SessionV2.NotFoundError>
  readonly update: (input: {
    readonly sessionID: SessionV2.ID
    readonly scheduleID: ID
    readonly expectedRevision: number
    readonly name?: Name
    readonly cron?: Cron
    readonly prompt?: Prompt
    readonly enabled?: boolean
    readonly recurring?: boolean
  }) => Effect.Effect<
    Info,
    | InvalidCronError
    | InvalidStateError
    | NameConflictError
    | NotFoundError
    | SessionV2.NotFoundError
    | StaleRevisionError
  >
  readonly delete: (input: {
    readonly sessionID: SessionV2.ID
    readonly scheduleID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<void, NotFoundError | SessionV2.NotFoundError | StaleRevisionError>
  readonly runMissed: (input: {
    readonly sessionID: SessionV2.ID
    readonly scheduleID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<
    Info,
    | InvalidCronError
    | InvalidStateError
    | NotFoundError
    | SessionV2.BusyError
    | SessionV2.NotFoundError
    | SessionV2.PromptConflictError
    | StaleRevisionError
  >
  readonly run: (input: {
    readonly sessionID: SessionV2.ID
    readonly scheduleID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<
    Info,
    | InvalidCronError
    | InvalidStateError
    | NotFoundError
    | SessionV2.BusyError
    | SessionV2.NotFoundError
    | SessionV2.PromptConflictError
    | StaleRevisionError
  >
  readonly tick: (now?: number) => Effect.Effect<void>
  readonly recover: (now?: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ScheduledPrompt") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const sessions = yield* SessionV2.Service
    const owner = `${process.pid}:${crypto.randomUUID()}`

    const lookup = Effect.fn("ScheduledPrompt.lookup")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
    }) {
      const row = yield* db
        .select()
        .from(ScheduledPromptTable)
        .where(and(eq(ScheduledPromptTable.id, input.scheduleID), eq(ScheduledPromptTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError(input)
      return row
    })

    const get = Effect.fn("ScheduledPrompt.get")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
    }) {
      yield* sessions.get(input.sessionID)
      return fromRow(yield* lookup(input))
    })

    const list = Effect.fn("ScheduledPrompt.list")(function* (sessionID: SessionV2.ID) {
      yield* sessions.get(sessionID)
      const rows = yield* db
        .select()
        .from(ScheduledPromptTable)
        .where(eq(ScheduledPromptTable.session_id, sessionID))
        .orderBy(asc(ScheduledPromptTable.time_created), asc(ScheduledPromptTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const create = Effect.fn("ScheduledPrompt.create")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly name: Name
      readonly cron: Cron
      readonly prompt: Prompt
      readonly recurring?: boolean
      readonly durable?: boolean
    }) {
      yield* sessions.get(input.sessionID)
      const now = Date.now()
      const id = ID.create()
      const nextRun = yield* nextRunEffect(input.cron, now, id, now + Lifetime)
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select({ id: ScheduledPromptTable.id })
              .from(ScheduledPromptTable)
              .where(
                and(eq(ScheduledPromptTable.session_id, input.sessionID), eq(ScheduledPromptTable.name, input.name)),
              )
              .get()
            if (existing) return yield* new NameConflictError({ sessionID: input.sessionID, name: input.name })
            const total = yield* tx
              .select({ value: count() })
              .from(ScheduledPromptTable)
              .where(eq(ScheduledPromptTable.session_id, input.sessionID))
              .get()
            if ((total?.value ?? 0) >= MaximumPerSession)
              return yield* new LimitError({ sessionID: input.sessionID, limit: MaximumPerSession })
            const stored = yield* tx
              .insert(ScheduledPromptTable)
              .values({
                id,
                session_id: input.sessionID,
                name: input.name,
                cron: input.cron,
                prompt: input.prompt,
                recurring: input.recurring === true,
                durable: input.durable !== false,
                next_run: nextRun,
                expires: now + Lifetime,
              })
              .returning()
              .get()
            if (!stored) return yield* Effect.die("Failed to persist scheduled prompt")
            return stored
          }),
        )
        .pipe(databaseOrDie)
      return fromRow(row)
    })

    const update = Effect.fn("ScheduledPrompt.update")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
      readonly expectedRevision: number
      readonly name?: Name
      readonly cron?: Cron
      readonly prompt?: Prompt
      readonly enabled?: boolean
      readonly recurring?: boolean
    }) {
      yield* sessions.get(input.sessionID)
      const current = yield* lookup(input)
      if (current.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          scheduleID: input.scheduleID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      if (current.status === "running" || current.status === "completed" || current.status === "expired")
        return yield* new InvalidStateError({
          scheduleID: input.scheduleID,
          status: current.status,
          action: "update",
        })
      if (input.name !== undefined && input.name !== current.name) {
        const conflict = yield* db
          .select({ id: ScheduledPromptTable.id })
          .from(ScheduledPromptTable)
          .where(and(eq(ScheduledPromptTable.session_id, input.sessionID), eq(ScheduledPromptTable.name, input.name)))
          .get()
          .pipe(Effect.orDie)
        if (conflict) return yield* new NameConflictError({ sessionID: input.sessionID, name: input.name })
      }
      const now = Date.now()
      const cron = input.cron ?? current.cron
      const nextRun =
        input.cron === undefined
          ? current.next_run
          : yield* nextRunEffect(Cron.make(cron), now, current.id, current.expires)
      const enabled = input.enabled ?? current.enabled
      const updated = yield* db
        .update(ScheduledPromptTable)
        .set({
          name: input.name,
          cron: input.cron,
          prompt: input.prompt,
          enabled,
          recurring: input.recurring,
          status: enabled ? "scheduled" : current.status,
          next_run: enabled ? nextRun : current.next_run,
          last_error: "",
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(ScheduledPromptTable.id, input.scheduleID),
            eq(ScheduledPromptTable.session_id, input.sessionID),
            eq(ScheduledPromptTable.revision, input.expectedRevision),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated)
        return yield* new StaleRevisionError({
          scheduleID: input.scheduleID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision + 1,
        })
      return fromRow(updated)
    })

    const remove = Effect.fn("ScheduledPrompt.delete")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
      readonly expectedRevision: number
    }) {
      yield* sessions.get(input.sessionID)
      const current = yield* lookup(input)
      if (current.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          scheduleID: input.scheduleID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      const deleted = yield* db
        .delete(ScheduledPromptTable)
        .where(
          and(
            eq(ScheduledPromptTable.id, input.scheduleID),
            eq(ScheduledPromptTable.session_id, input.sessionID),
            eq(ScheduledPromptTable.revision, input.expectedRevision),
          ),
        )
        .returning({ id: ScheduledPromptTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!deleted)
        return yield* new StaleRevisionError({
          scheduleID: input.scheduleID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision + 1,
        })
    })

    const dispatch = Effect.fn("ScheduledPrompt.dispatch")(function* (
      row: typeof ScheduledPromptTable.$inferSelect,
      mode: "due" | "missed" | "explicit",
      now = Date.now(),
    ) {
      if ((yield* sessions.active).has(row.session_id))
        return yield* new SessionV2.BusyError({ sessionID: row.session_id, operation: "run scheduled prompt" })
      if (!row.enabled && mode !== "explicit")
        return yield* new InvalidStateError({ scheduleID: row.id, status: row.status, action: mode })
      if (mode === "missed" && row.status !== "missed")
        return yield* new InvalidStateError({ scheduleID: row.id, status: row.status, action: "run missed" })
      if (mode !== "missed" && !["scheduled", "failed"].includes(row.status))
        return yield* new InvalidStateError({ scheduleID: row.id, status: row.status, action: "run" })

      yield* sessions.prompt({
        id: SessionMessage.ID.make(`msg_scheduled_${row.id}_${row.revision}`),
        sessionID: row.session_id,
        prompt: PromptInput.Prompt.make({ text: row.prompt }),
        delivery: "queue",
      })
      const next =
        row.recurring && now < row.expires
          ? yield* nextRunEffect(Cron.make(row.cron), now, row.id, row.expires)
          : undefined
      const status: Status = next === undefined ? "completed" : "scheduled"
      const updated = yield* db
        .update(ScheduledPromptTable)
        .set({
          status,
          next_run: next ?? null,
          last_run: now,
          last_error: "",
          lease_owner: null,
          lease_until: null,
          revision: row.revision + 1,
        })
        .where(and(eq(ScheduledPromptTable.id, row.id), eq(ScheduledPromptTable.revision, row.revision)))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated)
        return yield* new StaleRevisionError({
          scheduleID: row.id,
          expectedRevision: row.revision,
          actualRevision: row.revision + 1,
        })
      return fromRow(updated)
    })

    const tryClaim = Effect.fn("ScheduledPrompt.tryClaim")(function* (
      row: typeof ScheduledPromptTable.$inferSelect,
      now = Date.now(),
    ) {
      return yield* db
        .update(ScheduledPromptTable)
        .set({ status: "running", lease_owner: owner, lease_until: now + LeaseDuration })
        .where(
          and(
            eq(ScheduledPromptTable.id, row.id),
            eq(ScheduledPromptTable.revision, row.revision),
            eq(ScheduledPromptTable.status, row.status),
            or(isNull(ScheduledPromptTable.lease_until), lt(ScheduledPromptTable.lease_until, now)),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
    })

    const restoreClaim = Effect.fn("ScheduledPrompt.restoreClaim")(function* (
      row: typeof ScheduledPromptTable.$inferSelect,
      error: unknown,
    ) {
      const status: Status = error instanceof SessionV2.BusyError ? row.status : "failed"
      yield* db
        .update(ScheduledPromptTable)
        .set({
          status,
          lease_owner: null,
          lease_until: null,
          last_error: publicError(error),
        })
        .where(
          and(
            eq(ScheduledPromptTable.id, row.id),
            eq(ScheduledPromptTable.revision, row.revision),
            eq(ScheduledPromptTable.status, "running"),
            eq(ScheduledPromptTable.lease_owner, owner),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const runClaimed = Effect.fn("ScheduledPrompt.runClaimed")(function* (
      row: typeof ScheduledPromptTable.$inferSelect,
      mode: "missed" | "explicit",
    ) {
      const claimed = yield* tryClaim(row)
      if (!claimed)
        return yield* new InvalidStateError({
          scheduleID: row.id,
          status: row.status,
          action: `${mode} concurrently`,
        })
      return yield* dispatch({ ...claimed, status: row.status }, mode).pipe(
        Effect.catch((error) => restoreClaim(row, error).pipe(Effect.andThen(Effect.fail(error)))),
      )
    })

    const runMissed = Effect.fn("ScheduledPrompt.runMissed")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
      readonly expectedRevision: number
    }) {
      yield* sessions.get(input.sessionID)
      const row = yield* lookup(input)
      if (row.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          scheduleID: row.id,
          expectedRevision: input.expectedRevision,
          actualRevision: row.revision,
        })
      // Reject an inapplicable missed-run request before acquiring the lease.
      // Otherwise the claim is restored as `failed`, even though no execution
      // was attempted, and a conflict response silently corrupts schedule state.
      if (row.status !== "missed")
        return yield* new InvalidStateError({
          scheduleID: row.id,
          status: row.status,
          action: "run missed",
        })
      return yield* runClaimed(row, "missed")
    })

    const run = Effect.fn("ScheduledPrompt.run")(function* (input: {
      readonly sessionID: SessionV2.ID
      readonly scheduleID: ID
      readonly expectedRevision: number
    }) {
      yield* sessions.get(input.sessionID)
      const row = yield* lookup(input)
      if (row.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          scheduleID: row.id,
          expectedRevision: input.expectedRevision,
          actualRevision: row.revision,
        })
      return yield* runClaimed(row, "explicit")
    })

    const recover = Effect.fn("ScheduledPrompt.recover")(function* (now = Date.now()) {
      yield* db.delete(ScheduledPromptTable).where(eq(ScheduledPromptTable.durable, false)).run().pipe(Effect.orDie)
      yield* db
        .update(ScheduledPromptTable)
        .set({ status: "scheduled", lease_owner: null, lease_until: null })
        .where(
          and(
            eq(ScheduledPromptTable.status, "running"),
            or(isNull(ScheduledPromptTable.lease_until), lte(ScheduledPromptTable.lease_until, now)),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(ScheduledPromptTable)
        .set({ status: "expired", enabled: false, next_run: null, lease_owner: null, lease_until: null })
        .where(lte(ScheduledPromptTable.expires, now))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(ScheduledPromptTable)
        .set({ status: "missed", lease_owner: null, lease_until: null })
        .where(
          and(
            eq(ScheduledPromptTable.recurring, false),
            eq(ScheduledPromptTable.status, "scheduled"),
            lte(ScheduledPromptTable.next_run, now),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const tick = Effect.fn("ScheduledPrompt.tick")(function* (now = Date.now()) {
      const due = yield* db
        .select()
        .from(ScheduledPromptTable)
        .where(
          and(
            eq(ScheduledPromptTable.enabled, true),
            eq(ScheduledPromptTable.status, "scheduled"),
            lte(ScheduledPromptTable.next_run, now),
            or(isNull(ScheduledPromptTable.lease_until), lt(ScheduledPromptTable.lease_until, now)),
          ),
        )
        .orderBy(asc(ScheduledPromptTable.next_run), asc(ScheduledPromptTable.id))
        .limit(32)
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        due,
        (candidate) =>
          Effect.gen(function* () {
            const claimed = yield* tryClaim(candidate, now)
            if (!claimed) return
            const runnable = { ...claimed, status: "scheduled" as const }
            yield* dispatch(runnable, "due", now).pipe(Effect.catch((error) => restoreClaim(candidate, error)))
          }),
        { concurrency: 4, discard: true },
      )
    })

    const service = Service.of({ create, list, get, update, delete: remove, runMissed, run, tick, recover })
    yield* recover()
    yield* tick().pipe(
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.catchCause((cause) => Effect.logError("scheduled prompt dispatcher stopped", { cause })),
      Effect.forkScoped({ startImmediately: true }),
    )
    return service
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node],
})

function fromRow(row: typeof ScheduledPromptTable.$inferSelect): Info {
  return Info.make({
    id: row.id,
    sessionID: row.session_id,
    name: row.name,
    cron: row.cron,
    prompt: row.prompt,
    recurring: row.recurring,
    durable: row.durable,
    enabled: row.enabled,
    status: row.status,
    revision: row.revision,
    lastError: row.last_error,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      nextRun: row.next_run === null ? undefined : DateTime.makeUnsafe(row.next_run),
      lastRun: row.last_run === null ? undefined : DateTime.makeUnsafe(row.last_run),
      expires: DateTime.makeUnsafe(row.expires),
    },
  })
}

function jitter(id: ID) {
  let hash = 2166136261
  for (const character of id) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 30_000
}

function nextRunEffect(expression: Cron, after: number, id: ID, expires: number) {
  return Effect.try({
    try: () => {
      const base = CronSchedule.next(expression, after, expires)
      const value = base + jitter(id)
      if (value > expires)
        throw new CronSchedule.InvalidCronError({
          expression,
          message: "Cron occurrence plus deterministic jitter exceeds the schedule lifetime.",
        })
      return value
    },
    catch: (error) =>
      error instanceof CronSchedule.InvalidCronError
        ? error
        : new CronSchedule.InvalidCronError({ expression, message: "Invalid cron expression." }),
  })
}

type DomainError = InvalidCronError | LimitError | NameConflictError | NotFoundError | StaleRevisionError

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return [
    "ScheduledPrompt.InvalidCronError",
    "ScheduledPrompt.LimitError",
    "ScheduledPrompt.NameConflictError",
    "ScheduledPrompt.NotFoundError",
    "ScheduledPrompt.StaleRevisionError",
  ].includes(String(error._tag))
}

function publicError(error: unknown) {
  if (typeof error === "object" && error !== null && "_tag" in error) return String(error._tag).slice(0, 160)
  return "Scheduled prompt dispatch failed"
}
