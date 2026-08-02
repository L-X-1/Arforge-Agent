export * as GoalV2 from "./goal"

import { and, asc, desc, eq, inArray, max } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Goal } from "@arforge-ai/schema/goal"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { GoalTable } from "./goal/sql"

export const ID = Goal.ID
export type ID = Goal.ID

export const Objective = Goal.Objective
export type Objective = Goal.Objective

export const Status = Goal.Status
export type Status = Goal.Status

export const Info = Goal.Info
export type Info = Goal.Info

export const Page = Goal.Page
export type Page = Goal.Page

export const Event = Goal.Event

const ActiveStatuses = ["active", "running", "paused", "blocked"] as const satisfies ReadonlyArray<Status>
const TerminalStatuses = ["completed", "cancelled"] as const satisfies ReadonlyArray<Status>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Goal.NotFoundError", {
  sessionID: SessionSchema.ID,
  goalID: ID,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("Goal.InvalidStateError", {
  goalID: ID,
  status: Status,
  action: Schema.String,
}) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()("Goal.StaleRevisionError", {
  goalID: ID,
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
}) {}

export class InvalidQueueError extends Schema.TaggedErrorClass<InvalidQueueError>()("Goal.InvalidQueueError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly objective: Objective
    readonly queue?: boolean
  }) => Effect.Effect<Info>
  readonly list: (input: {
    readonly sessionID: SessionSchema.ID
    readonly includeHistory?: boolean
  }) => Effect.Effect<Page>
  readonly get: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
  }) => Effect.Effect<Info, NotFoundError>
  readonly start: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
    readonly promptID: SessionMessage.ID
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly pause: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly resume: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly block: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
    readonly error: string
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly complete: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly cancel: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly replace: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
    readonly objective: Objective
  }) => Effect.Effect<Info, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly deleteQueued: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goalID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<void, NotFoundError | InvalidStateError | StaleRevisionError>
  readonly reorder: (input: {
    readonly sessionID: SessionSchema.ID
    readonly goals: ReadonlyArray<{ readonly id: ID; readonly revision: number }>
  }) => Effect.Effect<Page, InvalidQueueError | StaleRevisionError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Goal") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const create = Effect.fn("Goal.create")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly objective: Objective
      readonly queue?: boolean
    }) {
      const goal = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const active = yield* tx
              .select({ id: GoalTable.id })
              .from(GoalTable)
              .where(and(eq(GoalTable.session_id, input.sessionID), inArray(GoalTable.status, ActiveStatuses)))
              .get()
            const status: Status = input.queue === true || active ? "queued" : "active"
            const queuePosition =
              status === "queued"
                ? ((yield* tx
                    .select({ value: max(GoalTable.queue_position) })
                    .from(GoalTable)
                    .where(and(eq(GoalTable.session_id, input.sessionID), eq(GoalTable.status, "queued")))
                    .get())?.value ?? 0) + 1
                : 0
            const stored = yield* tx
              .insert(GoalTable)
              .values({
                id: ID.create(),
                session_id: input.sessionID,
                objective: input.objective,
                status,
                queue_position: queuePosition,
              })
              .returning()
              .get()
            if (!stored) return yield* Effect.die("Failed to persist goal")
            return fromRow(stored)
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.Created, { sessionID: input.sessionID, goal })
      return goal
    })

    const list = Effect.fn("Goal.list")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly includeHistory?: boolean
    }) {
      const rows = yield* db
        .select()
        .from(GoalTable)
        .where(
          input.includeHistory === false
            ? and(eq(GoalTable.session_id, input.sessionID), inArray(GoalTable.status, [...ActiveStatuses, "queued"]))
            : eq(GoalTable.session_id, input.sessionID),
        )
        .orderBy(asc(GoalTable.queue_position), desc(GoalTable.time_updated), asc(GoalTable.id))
        .all()
        .pipe(Effect.orDie)
      return toPage(rows.map(fromRow))
    })

    const get = Effect.fn("Goal.get")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly goalID: ID
    }) {
      const row = yield* db
        .select()
        .from(GoalTable)
        .where(and(eq(GoalTable.id, input.goalID), eq(GoalTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new NotFoundError(input)
      return fromRow(row)
    })

    const update = Effect.fn("Goal.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly goalID: ID
      readonly expectedRevision: number
      readonly action: string
      readonly allowed: ReadonlyArray<Status>
      readonly set: Partial<typeof GoalTable.$inferInsert>
      readonly activateNext?: boolean
    }) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(GoalTable)
              .where(and(eq(GoalTable.id, input.goalID), eq(GoalTable.session_id, input.sessionID)))
              .get()
            if (!current) return yield* new NotFoundError(input)
            if (current.revision !== input.expectedRevision)
              return yield* new StaleRevisionError({
                goalID: input.goalID,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision,
              })
            if (!input.allowed.includes(current.status))
              return yield* new InvalidStateError({
                goalID: input.goalID,
                status: current.status,
                action: input.action,
              })
            const updated = yield* tx
              .update(GoalTable)
              .set({ ...input.set, revision: current.revision + 1, time_updated: Date.now() })
              .where(and(eq(GoalTable.id, input.goalID), eq(GoalTable.revision, input.expectedRevision)))
              .returning()
              .get()
            if (!updated)
              return yield* new StaleRevisionError({
                goalID: input.goalID,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision + 1,
              })
            if (!input.activateNext) return { goal: fromRow(updated), activated: undefined }
            const next = yield* tx
              .select()
              .from(GoalTable)
              .where(and(eq(GoalTable.session_id, input.sessionID), eq(GoalTable.status, "queued")))
              .orderBy(asc(GoalTable.queue_position), asc(GoalTable.time_created), asc(GoalTable.id))
              .get()
            if (!next) return { goal: fromRow(updated), activated: undefined }
            const activated = yield* tx
              .update(GoalTable)
              .set({
                status: "active",
                queue_position: 0,
                revision: next.revision + 1,
                last_error: "",
                time_updated: Date.now(),
              })
              .where(and(eq(GoalTable.id, next.id), eq(GoalTable.revision, next.revision)))
              .returning()
              .get()
            if (!activated) return yield* Effect.die("Failed to activate the next queued goal")
            return { goal: fromRow(updated), activated: fromRow(activated) }
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.Updated, { sessionID: input.sessionID, goal: result.goal })
      if (result.activated)
        yield* events.publish(Event.Updated, { sessionID: input.sessionID, goal: result.activated })
      return result.goal
    })

    const start: Interface["start"] = (input) =>
      update({
        ...input,
        action: "start",
        allowed: ["active", "blocked"],
        set: {
          status: "running",
          prompt_id: input.promptID,
          last_error: "",
          time_started: Date.now(),
          time_finished: null,
        },
      })

    const pause: Interface["pause"] = (input) =>
      update({
        ...input,
        action: "pause",
        allowed: ["active", "running", "blocked"],
        set: { status: "paused", time_finished: Date.now() },
      })

    const resume: Interface["resume"] = (input) =>
      update({
        ...input,
        action: "resume",
        allowed: ["paused", "blocked"],
        set: { status: "active", prompt_id: null, last_error: "", time_finished: null },
      })

    const block: Interface["block"] = (input) =>
      update({
        ...input,
        action: "block",
        allowed: ["active", "running"],
        set: { status: "blocked", last_error: input.error.slice(0, 1_000), time_finished: Date.now() },
      })

    const complete: Interface["complete"] = (input) =>
      update({
        ...input,
        action: "complete",
        allowed: ["active", "running"],
        set: { status: "completed", queue_position: 0, last_error: "", time_finished: Date.now() },
        activateNext: true,
      })

    const cancel: Interface["cancel"] = (input) =>
      update({
        ...input,
        action: "cancel",
        allowed: [...ActiveStatuses, "queued"],
        set: { status: "cancelled", queue_position: 0, time_finished: Date.now() },
        activateNext: true,
      })

    const replace: Interface["replace"] = (input) =>
      update({
        ...input,
        action: "replace",
        allowed: ["active", "queued", "paused", "blocked"],
        set: { objective: input.objective, last_error: "" },
      })

    const deleteQueued = Effect.fn("Goal.deleteQueued")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly goalID: ID
      readonly expectedRevision: number
    }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(GoalTable)
              .where(and(eq(GoalTable.id, input.goalID), eq(GoalTable.session_id, input.sessionID)))
              .get()
            if (!current) return yield* new NotFoundError(input)
            if (current.revision !== input.expectedRevision)
              return yield* new StaleRevisionError({
                goalID: input.goalID,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision,
              })
            if (current.status !== "queued")
              return yield* new InvalidStateError({
                goalID: input.goalID,
                status: current.status,
                action: "delete",
              })
            yield* tx.delete(GoalTable).where(eq(GoalTable.id, input.goalID)).run()
            const queued = yield* tx
              .select()
              .from(GoalTable)
              .where(and(eq(GoalTable.session_id, input.sessionID), eq(GoalTable.status, "queued")))
              .orderBy(asc(GoalTable.queue_position), asc(GoalTable.time_created), asc(GoalTable.id))
              .all()
            yield* Effect.forEach(
              queued,
              (goal, position) =>
                tx
                  .update(GoalTable)
                  .set({ queue_position: position + 1 })
                  .where(eq(GoalTable.id, goal.id))
                  .run(),
              { discard: true },
            )
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.Deleted, { sessionID: input.sessionID, goalID: input.goalID })
    })

    const reorder = Effect.fn("Goal.reorder")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly goals: ReadonlyArray<{ readonly id: ID; readonly revision: number }>
    }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const queued = yield* tx
              .select()
              .from(GoalTable)
              .where(and(eq(GoalTable.session_id, input.sessionID), eq(GoalTable.status, "queued")))
              .orderBy(asc(GoalTable.queue_position), asc(GoalTable.time_created), asc(GoalTable.id))
              .all()
            const requested = new Set(input.goals.map((goal) => goal.id))
            if (
              requested.size !== input.goals.length ||
              queued.length !== input.goals.length ||
              queued.some((goal) => !requested.has(goal.id))
            )
              return yield* new InvalidQueueError({
                message: "goals must contain every queued goal exactly once",
              })
            const byID = new Map(queued.map((goal) => [goal.id, goal]))
            yield* Effect.forEach(
              input.goals,
              (goal, position) => {
                const current = byID.get(goal.id)!
                if (current.revision !== goal.revision)
                  return Effect.fail(
                    new StaleRevisionError({
                      goalID: goal.id,
                      expectedRevision: goal.revision,
                      actualRevision: current.revision,
                    }),
                  )
                return tx
                  .update(GoalTable)
                  .set({
                    queue_position: position + 1,
                    revision: current.revision + 1,
                    time_updated: Date.now(),
                  })
                  .where(and(eq(GoalTable.id, goal.id), eq(GoalTable.revision, goal.revision)))
                  .run()
                  .pipe(Effect.orDie)
              },
              { discard: true },
            )
          }),
        )
        .pipe(databaseOrDie)
      return yield* list({ sessionID: input.sessionID, includeHistory: false })
    })

    return Service.of({
      create,
      list,
      get,
      start,
      pause,
      resume,
      block,
      complete,
      cancel,
      replace,
      deleteQueued,
      reorder,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, EventV2.node] })

function fromRow(row: typeof GoalTable.$inferSelect): Info {
  return Info.make({
    id: row.id,
    sessionID: row.session_id,
    objective: row.objective,
    status: row.status,
    queuePosition: row.queue_position,
    revision: row.revision,
    promptID: row.prompt_id ?? undefined,
    lastError: row.last_error,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      started: row.time_started ? DateTime.makeUnsafe(row.time_started) : undefined,
      finished: row.time_finished ? DateTime.makeUnsafe(row.time_finished) : undefined,
    },
  })
}

function toPage(items: ReadonlyArray<Info>): Page {
  const active = items.find((goal) => ActiveStatuses.includes(goal.status as (typeof ActiveStatuses)[number]))
  return Page.make({
    active,
    queued: items.filter((goal) => goal.status === "queued").sort((a, b) => a.queuePosition - b.queuePosition),
    history: items.filter((goal) => TerminalStatuses.includes(goal.status as (typeof TerminalStatuses)[number])),
    items,
  })
}

type DomainError = NotFoundError | InvalidStateError | StaleRevisionError | InvalidQueueError

function databaseOrDie<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return (
    error._tag === "Goal.NotFoundError" ||
    error._tag === "Goal.InvalidStateError" ||
    error._tag === "Goal.StaleRevisionError" ||
    error._tag === "Goal.InvalidQueueError"
  )
}
