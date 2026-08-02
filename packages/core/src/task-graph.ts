export * as TaskGraphV2 from "./task-graph"

import { and, asc, eq, inArray, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Database } from "./database/database"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { TaskGraphEdgeTable, TaskGraphTable } from "./task-graph/sql"

export const ID = TaskGraph.ID
export type ID = TaskGraph.ID
export const Title = TaskGraph.Title
export type Title = TaskGraph.Title
export const Description = TaskGraph.Description
export type Description = TaskGraph.Description
export const ActiveForm = TaskGraph.ActiveForm
export type ActiveForm = TaskGraph.ActiveForm
export const Owner = TaskGraph.Owner
export type Owner = TaskGraph.Owner
export const Metadata = TaskGraph.Metadata
export type Metadata = TaskGraph.Metadata
export const Status = TaskGraph.Status
export type Status = TaskGraph.Status
export const Info = TaskGraph.Info
export type Info = TaskGraph.Info
export const Page = TaskGraph.Page
export type Page = TaskGraph.Page
export const Event = TaskGraph.Event

const MaximumPerSession = 512
const MaximumRelations = 64
const MaximumMetadataKeys = 32
const MaximumMetadataBytes = 8_192
const Terminal = new Set<Status>(["completed", "cancelled"])

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TaskGraph.NotFoundError", {
  sessionID: SessionSchema.ID,
  taskID: ID,
}) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()("TaskGraph.StaleRevisionError", {
  taskID: ID,
  expectedRevision: Schema.Int,
  actualRevision: Schema.Int,
}) {}

export class NameConflictError extends Schema.TaggedErrorClass<NameConflictError>()("TaskGraph.NameConflictError", {
  sessionID: SessionSchema.ID,
  title: Title,
}) {}

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("TaskGraph.LimitError", {
  sessionID: SessionSchema.ID,
  limit: Schema.Int,
}) {}

export class InvalidDependencyError extends Schema.TaggedErrorClass<InvalidDependencyError>()(
  "TaskGraph.InvalidDependencyError",
  {
    taskID: ID,
    relatedTaskID: ID.pipe(Schema.optional),
    message: Schema.String,
  },
) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("TaskGraph.InvalidStateError", {
  taskID: ID,
  status: Status,
  action: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedErrorClass<BlockedError>()("TaskGraph.BlockedError", {
  taskID: ID,
  blockers: Schema.Array(ID),
}) {}

export class OwnerConflictError extends Schema.TaggedErrorClass<OwnerConflictError>()("TaskGraph.OwnerConflictError", {
  taskID: ID,
  owner: Owner,
  conflictingTaskID: ID,
}) {}

export class MetadataLimitError extends Schema.TaggedErrorClass<MetadataLimitError>()("TaskGraph.MetadataLimitError", {
  message: Schema.String,
}) {}

export class MutationRejectedError extends Schema.TaggedErrorClass<MutationRejectedError>()(
  "TaskGraph.MutationRejectedError",
  {
    event: Schema.Literals(["task_created", "task_completed"]),
    message: Schema.String,
  },
) {}

type MutationError =
  | BlockedError
  | InvalidDependencyError
  | InvalidStateError
  | LimitError
  | MetadataLimitError
  | MutationRejectedError
  | NameConflictError
  | NotFoundError
  | OwnerConflictError
  | StaleRevisionError

export interface GuardInterface {
  readonly beforeCreate: (input: {
    readonly sessionID: SessionSchema.ID
    readonly title: Title
  }) => Effect.Effect<void, MutationRejectedError>
  readonly beforeComplete: (task: Info) => Effect.Effect<void, MutationRejectedError>
}

export class Guard extends Context.Service<Guard, GuardInterface>()("@arforge/v2/TaskGraphGuard") {}

export const guardLayer = Layer.succeed(
  Guard,
  Guard.of({
    beforeCreate: () => Effect.void,
    beforeComplete: () => Effect.void,
  }),
)

export const guardNode = makeGlobalNode({ service: Guard, layer: guardLayer, deps: [] })

export interface Interface {
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly title: Title
    readonly description?: Description
    readonly activeForm?: ActiveForm
    readonly metadata?: Metadata
    readonly blockedBy?: ReadonlyArray<ID>
  }) => Effect.Effect<Info, MutationError>
  readonly list: (input: {
    readonly sessionID: SessionSchema.ID
    readonly status?: Status
    readonly owner?: Owner
    readonly search?: string
  }) => Effect.Effect<Page>
  readonly get: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
  }) => Effect.Effect<Info, NotFoundError>
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
    readonly title?: Title
    readonly description?: Description
    readonly activeForm?: ActiveForm
    readonly metadata?: Metadata
    readonly blocks?: ReadonlyArray<ID>
    readonly blockedBy?: ReadonlyArray<ID>
  }) => Effect.Effect<Info, MutationError>
  readonly claim: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
    readonly owner: Owner
  }) => Effect.Effect<Info, MutationError>
  readonly release: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
    readonly owner: Owner
  }) => Effect.Effect<Info, MutationError>
  readonly complete: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, MutationError>
  readonly cancel: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, MutationError>
  readonly delete: (input: {
    readonly sessionID: SessionSchema.ID
    readonly taskID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<void, NotFoundError | StaleRevisionError>
  readonly clear: (input: {
    readonly sessionID: SessionSchema.ID
    readonly terminalOnly?: boolean
  }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/TaskGraph") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const events = yield* EventV2.Service
    const guard = yield* Guard

    const load = Effect.fn("TaskGraph.load")(function* (sessionID: SessionSchema.ID) {
      const [tasks, edges] = yield* Effect.all([
        db
          .select()
          .from(TaskGraphTable)
          .where(eq(TaskGraphTable.session_id, sessionID))
          .orderBy(asc(TaskGraphTable.time_created), asc(TaskGraphTable.id))
          .all()
          .pipe(Effect.orDie),
        db
          .select()
          .from(TaskGraphEdgeTable)
          .where(eq(TaskGraphEdgeTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ])
      return assemble(tasks, edges)
    })

    const get = Effect.fn("TaskGraph.get")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
    }) {
      const task = (yield* load(input.sessionID)).find((item) => item.id === input.taskID)
      if (!task) return yield* new NotFoundError(input)
      return task
    })

    const list = Effect.fn("TaskGraph.list")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly status?: Status
      readonly owner?: Owner
      readonly search?: string
    }) {
      const conditions = [eq(TaskGraphTable.session_id, input.sessionID)]
      if (input.status) conditions.push(eq(TaskGraphTable.status, input.status))
      if (input.owner) conditions.push(eq(TaskGraphTable.owner, input.owner))
      if (input.search?.trim()) {
        const query = input.search.trim()
        conditions.push(
          or(
            sql`instr(lower(${TaskGraphTable.title}), lower(${query})) > 0`,
            sql`instr(lower(${TaskGraphTable.description}), lower(${query})) > 0`,
            sql`instr(lower(${TaskGraphTable.active_form}), lower(${query})) > 0`,
          )!,
        )
      }
      const rows = yield* db
        .select()
        .from(TaskGraphTable)
        .where(and(...conditions))
        .orderBy(asc(TaskGraphTable.time_created), asc(TaskGraphTable.id))
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) return Page.make({ items: [], total: 0 })
      const ids = rows.map((row) => row.id)
      const edges = yield* db
        .select()
        .from(TaskGraphEdgeTable)
        .where(
          and(
            eq(TaskGraphEdgeTable.session_id, input.sessionID),
            or(inArray(TaskGraphEdgeTable.blocker_id, ids), inArray(TaskGraphEdgeTable.blocked_id, ids)),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const statuses = new Map(
        (yield* db
          .select({ id: TaskGraphTable.id, status: TaskGraphTable.status })
          .from(TaskGraphTable)
          .where(eq(TaskGraphTable.session_id, input.sessionID))
          .all()
          .pipe(Effect.orDie)).map((row) => [row.id, row.status]),
      )
      const items = assemble(rows, edges, statuses)
      return Page.make({ items, total: items.length })
    })

    const create = Effect.fn("TaskGraph.create")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly title: Title
      readonly description?: Description
      readonly activeForm?: ActiveForm
      readonly metadata?: Metadata
      readonly blockedBy?: ReadonlyArray<ID>
    }) {
      const metadata = yield* prepareMetadata(input.metadata ?? Metadata.make({}))
      const title = Title.make(redact(input.title))
      const description = Description.make(redact(input.description ?? ""))
      const activeForm = ActiveForm.make(redact(input.activeForm ?? ""))
      const blockedBy = unique(input.blockedBy ?? [])
      if (blockedBy.length > MaximumRelations)
        return yield* new InvalidDependencyError({
          taskID: ID.create(),
          message: `A task may have at most ${MaximumRelations} blockers.`,
        })
      yield* guard.beforeCreate({ sessionID: input.sessionID, title })
      const id = ID.create()
      const stored = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const all = yield* tx
              .select({ id: TaskGraphTable.id })
              .from(TaskGraphTable)
              .where(eq(TaskGraphTable.session_id, input.sessionID))
              .all()
            if (all.length >= MaximumPerSession)
              return yield* new LimitError({ sessionID: input.sessionID, limit: MaximumPerSession })
            if (blockedBy.some((taskID) => !all.some((task) => task.id === taskID)))
              return yield* new InvalidDependencyError({
                taskID: id,
                relatedTaskID: blockedBy.find((taskID) => !all.some((task) => task.id === taskID)),
                message: "Every blocker must belong to the same session.",
              })
            const conflict = yield* tx
              .select({ id: TaskGraphTable.id })
              .from(TaskGraphTable)
              .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.title, title)))
              .get()
            if (conflict) return yield* new NameConflictError({ sessionID: input.sessionID, title })
            const row = yield* tx
              .insert(TaskGraphTable)
              .values({
                id,
                session_id: input.sessionID,
                title,
                description,
                active_form: activeForm,
                metadata,
              })
              .returning()
              .get()
            if (!row) return yield* Effect.die("Failed to persist task")
            if (blockedBy.length)
              yield* tx
                .insert(TaskGraphEdgeTable)
                .values(blockedBy.map((blockerID) => ({ session_id: input.sessionID, blocker_id: blockerID, blocked_id: id })))
                .run()
            return row
          }),
        )
        .pipe(databaseOrDie)
      const task = yield* get({ sessionID: input.sessionID, taskID: stored.id })
      yield* events.publish(Event.Created, { sessionID: input.sessionID, task })
      return task
    })

    const update = Effect.fn("TaskGraph.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
      readonly title?: Title
      readonly description?: Description
      readonly activeForm?: ActiveForm
      readonly metadata?: Metadata
      readonly blocks?: ReadonlyArray<ID>
      readonly blockedBy?: ReadonlyArray<ID>
    }) {
      const metadata = input.metadata === undefined ? undefined : yield* prepareMetadata(input.metadata)
      const title = input.title === undefined ? undefined : Title.make(redact(input.title))
      const description = input.description === undefined ? undefined : Description.make(redact(input.description))
      const activeForm = input.activeForm === undefined ? undefined : ActiveForm.make(redact(input.activeForm))
      const blocks = input.blocks === undefined ? undefined : unique(input.blocks)
      const blockedBy = input.blockedBy === undefined ? undefined : unique(input.blockedBy)
      if ((blocks?.length ?? 0) > MaximumRelations || (blockedBy?.length ?? 0) > MaximumRelations)
        return yield* new InvalidDependencyError({
          taskID: input.taskID,
          message: `A task may have at most ${MaximumRelations} incoming or outgoing relations.`,
        })
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(TaskGraphTable)
              .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.id, input.taskID)))
              .get()
            if (!current) return yield* new NotFoundError(input)
            yield* assertRevision(current, input.expectedRevision)
            if (Terminal.has(current.status))
              return yield* new InvalidStateError({ taskID: input.taskID, status: current.status, action: "update" })
            if (title !== undefined && title !== current.title) {
              const conflict = yield* tx
                .select({ id: TaskGraphTable.id })
                .from(TaskGraphTable)
                .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.title, title)))
                .get()
              if (conflict) return yield* new NameConflictError({ sessionID: input.sessionID, title })
            }

            const tasks = yield* tx
              .select({ id: TaskGraphTable.id })
              .from(TaskGraphTable)
              .where(eq(TaskGraphTable.session_id, input.sessionID))
              .all()
            const taskIDs = new Set(tasks.map((task) => task.id))
            const requested = [...(blocks ?? []), ...(blockedBy ?? [])]
            const invalid = requested.find((taskID) => taskID === input.taskID || !taskIDs.has(taskID))
            if (invalid)
              return yield* new InvalidDependencyError({
                taskID: input.taskID,
                relatedTaskID: invalid,
                message: invalid === input.taskID ? "A task cannot depend on itself." : "Related tasks must belong to the same session.",
              })

            if (blocks !== undefined || blockedBy !== undefined) {
              const edges = yield* tx
                .select()
                .from(TaskGraphEdgeTable)
                .where(eq(TaskGraphEdgeTable.session_id, input.sessionID))
                .all()
              const retained = edges.filter(
                (edge) =>
                  (blocks === undefined || edge.blocker_id !== input.taskID) &&
                  (blockedBy === undefined || edge.blocked_id !== input.taskID),
              )
              const proposed = [
                ...retained.map((edge) => [edge.blocker_id, edge.blocked_id] as const),
                ...(blocks ?? edges.filter((edge) => edge.blocker_id === input.taskID).map((edge) => edge.blocked_id)).map(
                  (blockedID) => [input.taskID, blockedID] as const,
                ),
                ...(blockedBy ?? edges.filter((edge) => edge.blocked_id === input.taskID).map((edge) => edge.blocker_id)).map(
                  (blockerID) => [blockerID, input.taskID] as const,
                ),
              ]
              const cycle = findCycle(taskIDs, proposed)
              if (cycle)
                return yield* new InvalidDependencyError({
                  taskID: input.taskID,
                  relatedTaskID: cycle,
                  message: "Task dependency cycles are not allowed.",
                })
              if (blocks !== undefined)
                yield* tx.delete(TaskGraphEdgeTable).where(eq(TaskGraphEdgeTable.blocker_id, input.taskID)).run()
              if (blockedBy !== undefined)
                yield* tx.delete(TaskGraphEdgeTable).where(eq(TaskGraphEdgeTable.blocked_id, input.taskID)).run()
              const inserts = [
                ...(blocks ?? []).map((blockedID) => ({
                  session_id: input.sessionID,
                  blocker_id: input.taskID,
                  blocked_id: blockedID,
                })),
                ...(blockedBy ?? []).map((blockerID) => ({
                  session_id: input.sessionID,
                  blocker_id: blockerID,
                  blocked_id: input.taskID,
                })),
              ]
              if (inserts.length) yield* tx.insert(TaskGraphEdgeTable).values(inserts).onConflictDoNothing().run()
            }

            const updated = yield* tx
              .update(TaskGraphTable)
              .set({
                title,
                description,
                active_form: activeForm,
                metadata,
                revision: current.revision + 1,
                time_updated: Date.now(),
              })
              .where(and(eq(TaskGraphTable.id, input.taskID), eq(TaskGraphTable.revision, input.expectedRevision)))
              .returning()
              .get()
            if (!updated)
              return yield* new StaleRevisionError({
                taskID: input.taskID,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision + 1,
              })
            return updated
          }),
        )
        .pipe(databaseOrDie)
      const task = yield* get({ sessionID: input.sessionID, taskID: row.id })
      yield* events.publish(Event.Updated, { sessionID: input.sessionID, task })
      return task
    })

    const claim = Effect.fn("TaskGraph.claim")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
      readonly owner: Owner
    }) {
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(TaskGraphTable)
              .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.id, input.taskID)))
              .get()
            if (!current) return yield* new NotFoundError(input)
            yield* assertRevision(current, input.expectedRevision)
            if (Terminal.has(current.status))
              return yield* new InvalidStateError({ taskID: input.taskID, status: current.status, action: "claim" })
            if (current.owner && current.owner !== input.owner)
              return yield* new OwnerConflictError({
                taskID: input.taskID,
                owner: input.owner,
                conflictingTaskID: input.taskID,
              })
            const blockers = yield* tx
              .select({ id: TaskGraphTable.id })
              .from(TaskGraphEdgeTable)
              .innerJoin(TaskGraphTable, eq(TaskGraphTable.id, TaskGraphEdgeTable.blocker_id))
              .where(
                and(
                  eq(TaskGraphEdgeTable.session_id, input.sessionID),
                  eq(TaskGraphEdgeTable.blocked_id, input.taskID),
                  inArray(TaskGraphTable.status, ["pending", "in_progress", "cancelled"]),
                ),
              )
              .all()
            if (blockers.length) return yield* new BlockedError({ taskID: input.taskID, blockers: blockers.map((item) => item.id) })
            const owned = yield* tx
              .select({ id: TaskGraphTable.id })
              .from(TaskGraphTable)
              .where(
                and(
                  eq(TaskGraphTable.session_id, input.sessionID),
                  eq(TaskGraphTable.owner, input.owner),
                  eq(TaskGraphTable.status, "in_progress"),
                ),
              )
              .get()
            if (owned && owned.id !== input.taskID)
              return yield* new OwnerConflictError({
                taskID: input.taskID,
                owner: input.owner,
                conflictingTaskID: owned.id,
              })
            const updated = yield* tx
              .update(TaskGraphTable)
              .set({
                owner: input.owner,
                status: "in_progress",
                revision: current.revision + 1,
                time_updated: Date.now(),
              })
              .where(and(eq(TaskGraphTable.id, current.id), eq(TaskGraphTable.revision, input.expectedRevision)))
              .returning()
              .get()
            if (!updated)
              return yield* new StaleRevisionError({
                taskID: current.id,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision + 1,
              })
            return updated
          }),
        )
        .pipe(databaseOrDie)
      return yield* publishUpdated(row, input.sessionID, get, events)
    })

    const release = Effect.fn("TaskGraph.release")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
      readonly owner: Owner
    }) {
      const current = yield* findRow(db, input)
      yield* assertRevision(current, input.expectedRevision)
      if (current.status !== "in_progress" || current.owner !== input.owner)
        return yield* new InvalidStateError({ taskID: input.taskID, status: current.status, action: "release this owner" })
      const row = yield* updateRow(db, current, input.expectedRevision, { owner: null, status: "pending" }).pipe(Effect.orDie)
      return yield* publishUpdated(row, input.sessionID, get, events)
    })

    const complete = Effect.fn("TaskGraph.complete")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
    }) {
      const current = yield* get(input)
      yield* assertInfoRevision(current, input.expectedRevision)
      if (Terminal.has(current.status))
        return yield* new InvalidStateError({ taskID: input.taskID, status: current.status, action: "complete" })
      yield* guard.beforeComplete(current)
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const fresh = yield* tx
              .select()
              .from(TaskGraphTable)
              .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.id, input.taskID)))
              .get()
            if (!fresh) return yield* new NotFoundError(input)
            yield* assertRevision(fresh, input.expectedRevision)
            const updated = yield* tx
              .update(TaskGraphTable)
              .set({
                status: "completed",
                time_completed: Date.now(),
                revision: fresh.revision + 1,
                time_updated: Date.now(),
              })
              .where(and(eq(TaskGraphTable.id, fresh.id), eq(TaskGraphTable.revision, input.expectedRevision)))
              .returning()
              .get()
            if (!updated)
              return yield* new StaleRevisionError({
                taskID: fresh.id,
                expectedRevision: input.expectedRevision,
                actualRevision: fresh.revision + 1,
              })
            return updated
          }),
        )
        .pipe(databaseOrDie)
      return yield* publishUpdated(row, input.sessionID, get, events)
    })

    const cancel = Effect.fn("TaskGraph.cancel")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
    }) {
      const current = yield* findRow(db, input)
      yield* assertRevision(current, input.expectedRevision)
      if (Terminal.has(current.status))
        return yield* new InvalidStateError({ taskID: input.taskID, status: current.status, action: "cancel" })
      const row = yield* updateRow(db, current, input.expectedRevision, {
        status: "cancelled",
        owner: null,
        time_completed: Date.now(),
      }).pipe(Effect.orDie)
      return yield* publishUpdated(row, input.sessionID, get, events)
    })

    const remove = Effect.fn("TaskGraph.delete")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly taskID: ID
      readonly expectedRevision: number
    }) {
      const current = yield* findRow(db, input)
      yield* assertRevision(current, input.expectedRevision)
      const deleted = yield* db
        .delete(TaskGraphTable)
        .where(
          and(
            eq(TaskGraphTable.session_id, input.sessionID),
            eq(TaskGraphTable.id, input.taskID),
            eq(TaskGraphTable.revision, input.expectedRevision),
          ),
        )
        .returning({ id: TaskGraphTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!deleted)
        return yield* new StaleRevisionError({
          taskID: input.taskID,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision + 1,
        })
      yield* events.publish(Event.Deleted, { sessionID: input.sessionID, taskID: input.taskID })
    })

    const clear = Effect.fn("TaskGraph.clear")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly terminalOnly?: boolean
    }) {
      const deleted = yield* db
        .delete(TaskGraphTable)
        .where(
          input.terminalOnly === false
            ? eq(TaskGraphTable.session_id, input.sessionID)
            : and(
                eq(TaskGraphTable.session_id, input.sessionID),
                inArray(TaskGraphTable.status, ["completed", "cancelled"]),
              ),
        )
        .returning({ id: TaskGraphTable.id })
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        deleted,
        (task) => events.publish(Event.Deleted, { sessionID: input.sessionID, taskID: task.id }),
        { discard: true },
      )
      return deleted.length
    })

    return Service.of({ create, list, get, update, claim, release, complete, cancel, delete: remove, clear })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, guardNode],
})

function assemble(
  rows: ReadonlyArray<typeof TaskGraphTable.$inferSelect>,
  edges: ReadonlyArray<typeof TaskGraphEdgeTable.$inferSelect>,
  knownStatuses?: ReadonlyMap<ID, Status>,
) {
  const statuses = knownStatuses ?? new Map(rows.map((row) => [row.id, row.status]))
  return rows.map((row) => {
    const blocks = edges.filter((edge) => edge.blocker_id === row.id).map((edge) => edge.blocked_id)
    const blockedBy = edges.filter((edge) => edge.blocked_id === row.id).map((edge) => edge.blocker_id)
    return Info.make({
      id: row.id,
      sessionID: row.session_id,
      title: row.title,
      description: row.description,
      activeForm: row.active_form,
      status: row.status,
      owner: row.owner ?? undefined,
      metadata: row.metadata,
      blocks,
      blockedBy,
      unresolvedBlockers: blockedBy.filter((id) => statuses.get(id) !== "completed").length,
      revision: row.revision,
      time: {
        created: DateTime.makeUnsafe(row.time_created),
        updated: DateTime.makeUnsafe(row.time_updated),
        completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
      },
    })
  })
}

function findRow(
  db: Database.Interface["db"],
  input: { readonly sessionID: SessionSchema.ID; readonly taskID: ID },
) {
  return db
    .select()
    .from(TaskGraphTable)
    .where(and(eq(TaskGraphTable.session_id, input.sessionID), eq(TaskGraphTable.id, input.taskID)))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : new NotFoundError(input))),
    )
}

function assertRevision(row: typeof TaskGraphTable.$inferSelect, expectedRevision: number) {
  return row.revision === expectedRevision
    ? Effect.void
    : new StaleRevisionError({ taskID: row.id, expectedRevision, actualRevision: row.revision })
}

function assertInfoRevision(task: Info, expectedRevision: number) {
  return task.revision === expectedRevision
    ? Effect.void
    : new StaleRevisionError({ taskID: task.id, expectedRevision, actualRevision: task.revision })
}

function updateRow(
  db: Database.Interface["db"],
  current: typeof TaskGraphTable.$inferSelect,
  expectedRevision: number,
  set: Partial<typeof TaskGraphTable.$inferInsert>,
) {
  return db
    .update(TaskGraphTable)
    .set({ ...set, revision: current.revision + 1, time_updated: Date.now() })
    .where(and(eq(TaskGraphTable.id, current.id), eq(TaskGraphTable.revision, expectedRevision)))
    .returning()
    .get()
    .pipe(
      Effect.flatMap((row) =>
        row
          ? Effect.succeed(row)
          : new StaleRevisionError({
              taskID: current.id,
              expectedRevision,
              actualRevision: current.revision + 1,
            }),
      ),
    )
}

function publishUpdated(
  row: typeof TaskGraphTable.$inferSelect,
  sessionID: SessionSchema.ID,
  get: (input: { readonly sessionID: SessionSchema.ID; readonly taskID: ID }) => Effect.Effect<Info, NotFoundError>,
  events: EventV2.Interface,
) {
  return Effect.gen(function* () {
    const task = yield* get({ sessionID, taskID: row.id })
    yield* events.publish(Event.Updated, { sessionID, task })
    return task
  })
}

function prepareMetadata(metadata: Metadata) {
  return Effect.gen(function* () {
    const keys = Object.keys(metadata)
    if (keys.length > MaximumMetadataKeys)
      return yield* new MetadataLimitError({ message: `Task metadata may contain at most ${MaximumMetadataKeys} keys.` })
    const redacted = Metadata.make(Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, redact(value, key)])))
    if (new TextEncoder().encode(JSON.stringify(redacted)).byteLength > MaximumMetadataBytes)
      return yield* new MetadataLimitError({ message: `Task metadata may contain at most ${MaximumMetadataBytes} bytes.` })
    return redacted
  })
}

function redact(value: string, key = "") {
  if (/(?:api[_-]?key|authorization|credential|password|secret|token)/i.test(key)) return "[REDACTED]"
  return value
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]")
}

function unique(ids: ReadonlyArray<ID>) {
  return [...new Set(ids)]
}

function findCycle(nodes: ReadonlySet<ID>, edges: ReadonlyArray<readonly [ID, ID]>) {
  const adjacency = new Map<ID, ID[]>()
  for (const node of nodes) adjacency.set(node, [])
  for (const [from, to] of edges) adjacency.get(from)?.push(to)
  const visiting = new Set<ID>()
  const visited = new Set<ID>()
  const walk = (node: ID): ID | undefined => {
    if (visiting.has(node)) return node
    if (visited.has(node)) return
    visiting.add(node)
    for (const target of adjacency.get(node) ?? []) {
      const cycle = walk(target)
      if (cycle) return cycle
    }
    visiting.delete(node)
    visited.add(node)
  }
  for (const node of nodes) {
    const cycle = walk(node)
    if (cycle) return cycle
  }
}

type DomainError = MutationError

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    String(error._tag).startsWith("TaskGraph.")
  )
}
