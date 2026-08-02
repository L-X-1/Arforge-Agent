export * as ScheduledPromptTriggerAccess from "./trigger-access"

import { ScheduledPrompt } from "@arforge-ai/schema/scheduled-prompt"
import { and, asc, count, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { ScheduledPromptTable, SessionTable } from "../session/sql"
import { CronSchedule } from "./cron"

const Lifetime = 7 * 24 * 60 * 60 * 1_000
const MaximumPerSession = 64

export class AccessError extends Schema.TaggedErrorClass<AccessError>()("ScheduledPrompt.TriggerAccessError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<ScheduledPrompt.Info>, AccessError>
  readonly get: (input: {
    readonly sessionID: SessionSchema.ID
    readonly scheduleID: ScheduledPrompt.ID
  }) => Effect.Effect<ScheduledPrompt.Info, AccessError>
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name: ScheduledPrompt.Name
    readonly cron: ScheduledPrompt.Cron
    readonly prompt: ScheduledPrompt.Prompt
    readonly recurring: boolean
    readonly durable: boolean
    readonly enabled: boolean
  }) => Effect.Effect<ScheduledPrompt.Info, AccessError>
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly scheduleID: ScheduledPrompt.ID
    readonly name?: ScheduledPrompt.Name
    readonly cron?: ScheduledPrompt.Cron
    readonly prompt?: ScheduledPrompt.Prompt
    readonly recurring?: boolean
    readonly enabled?: boolean
  }) => Effect.Effect<ScheduledPrompt.Info, AccessError>
  readonly runRequested: (input: {
    readonly sessionID: SessionSchema.ID
    readonly scheduleID: ScheduledPrompt.ID
  }) => Effect.Effect<ScheduledPrompt.Info, AccessError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/ScheduledPromptTriggerAccess") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database

    const sessionExists = Effect.fn("ScheduledPromptTriggerAccess.sessionExists")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* access("SESSION_NOT_FOUND", "session not found")
    })

    const lookup = Effect.fn("ScheduledPromptTriggerAccess.lookup")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly scheduleID: ScheduledPrompt.ID
    }) {
      yield* sessionExists(input.sessionID)
      const row = yield* db
        .select()
        .from(ScheduledPromptTable)
        .where(and(eq(ScheduledPromptTable.id, input.scheduleID), eq(ScheduledPromptTable.session_id, input.sessionID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* access("TRIGGER_NOT_FOUND", "scheduled prompt not found")
      return row
    })

    const list: Interface["list"] = Effect.fn("ScheduledPromptTriggerAccess.list")(function* (sessionID) {
      yield* sessionExists(sessionID)
      const rows = yield* db
        .select()
        .from(ScheduledPromptTable)
        .where(eq(ScheduledPromptTable.session_id, sessionID))
        .orderBy(asc(ScheduledPromptTable.time_created), asc(ScheduledPromptTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(fromRow)
    })

    const get: Interface["get"] = Effect.fn("ScheduledPromptTriggerAccess.get")(function* (input) {
      return fromRow(yield* lookup(input))
    })

    const create: Interface["create"] = Effect.fn("ScheduledPromptTriggerAccess.create")(function* (input) {
      yield* sessionExists(input.sessionID)
      const now = Date.now()
      const id = ScheduledPrompt.ID.create()
      const expires = now + Lifetime
      const nextRun = yield* nextRunEffect(input.cron, now, id, expires)
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const conflict = yield* tx
              .select({ id: ScheduledPromptTable.id })
              .from(ScheduledPromptTable)
              .where(and(eq(ScheduledPromptTable.session_id, input.sessionID), eq(ScheduledPromptTable.name, input.name)))
              .get()
            if (conflict) return yield* access("NAME_CONFLICT", "scheduled prompt name already exists")
            const total = yield* tx
              .select({ value: count() })
              .from(ScheduledPromptTable)
              .where(eq(ScheduledPromptTable.session_id, input.sessionID))
              .get()
            if ((total?.value ?? 0) >= MaximumPerSession)
              return yield* access("LIMIT_EXCEEDED", `scheduled prompt limit is ${MaximumPerSession}`)
            const inserted = yield* tx
              .insert(ScheduledPromptTable)
              .values({
                id,
                session_id: input.sessionID,
                name: input.name,
                cron: input.cron,
                prompt: input.prompt,
                recurring: input.recurring,
                durable: input.durable,
                enabled: input.enabled,
                status: "scheduled",
                next_run: nextRun,
                expires,
              })
              .returning()
              .get()
            if (!inserted) return yield* access("WRITE_FAILED", "failed to create scheduled prompt")
            return inserted
          }),
        )
        .pipe(databaseOrAccess)
      return fromRow(row)
    })

    const update: Interface["update"] = Effect.fn("ScheduledPromptTriggerAccess.update")(function* (input) {
      const current = yield* lookup(input)
      if (["running", "completed", "expired"].includes(current.status))
        return yield* access("INVALID_STATE", `scheduled prompt cannot be updated while ${current.status}`)
      if (input.name !== undefined && input.name !== current.name) {
        const conflict = yield* db
          .select({ id: ScheduledPromptTable.id })
          .from(ScheduledPromptTable)
          .where(and(eq(ScheduledPromptTable.session_id, input.sessionID), eq(ScheduledPromptTable.name, input.name)))
          .get()
          .pipe(Effect.orDie)
        if (conflict) return yield* access("NAME_CONFLICT", "scheduled prompt name already exists")
      }
      const now = Date.now()
      const enabled = input.enabled ?? current.enabled
      const cron = input.cron ?? current.cron
      const recalculate = input.cron !== undefined || input.recurring !== undefined || input.enabled === true
      const nextRun = recalculate
        ? yield* nextRunEffect(cron, now, current.id, current.expires)
        : current.next_run
      const updated = yield* db
        .update(ScheduledPromptTable)
        .set({
          name: input.name,
          cron: input.cron,
          prompt: input.prompt,
          recurring: input.recurring,
          enabled,
          status: enabled ? "scheduled" : current.status,
          next_run: enabled ? nextRun : current.next_run,
          last_error: "",
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(ScheduledPromptTable.id, input.scheduleID),
            eq(ScheduledPromptTable.session_id, input.sessionID),
            eq(ScheduledPromptTable.revision, current.revision),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return yield* access("STALE_REVISION", "scheduled prompt changed concurrently")
      return fromRow(updated)
    })

    return Service.of({ list, get, create, update, runRequested: get })
  }),
)

const access = (code: string, message: string) => Effect.fail(new AccessError({ code, message }))

function fromRow(row: typeof ScheduledPromptTable.$inferSelect): ScheduledPrompt.Info {
  return ScheduledPrompt.Info.make({
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

function jitter(id: ScheduledPrompt.ID) {
  let hash = 2166136261
  for (const character of id) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 30_000
}

function nextRunEffect(
  expression: ScheduledPrompt.Cron,
  after: number,
  id: ScheduledPrompt.ID,
  expires: number,
) {
  return Effect.try({
    try: () => {
      const value = CronSchedule.next(expression, after, expires) + jitter(id)
      if (value > expires) throw new Error("outside lifetime")
      return value
    },
    catch: () => new AccessError({ code: "INVALID_CRON", message: "invalid cron expression" }),
  })
}

function databaseOrAccess<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, AccessError, R> {
  return effect.pipe(
    Effect.catch((error) => (error instanceof AccessError ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, AccessError, R>
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
