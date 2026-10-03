export * as PersonalJobV2 from "./personal-job"

import { PersonalJob } from "@arforge-ai/schema/personal-job"
import { Credential } from "@arforge-ai/schema/credential"
import { SessionMessage } from "@arforge-ai/schema/session-message"
import { Event as SchemaEvent } from "@arforge-ai/schema/event"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { EventTable } from "./event/sql"
import { LOCAL_TENANT_ID, LOCAL_USER_ID } from "./identity/sql"
import { ScheduledPromptTable, SessionTable } from "./session/sql"
import { CronSchedule } from "./scheduled-prompt/cron"
import { canonicalHash } from "./util/canonical-hash"
import { DurableRun } from "./runtime/durable-run"
import { SessionStore } from "./session/store"
import { readExecutionWith, storedResult, resultDigest } from "./personal-job-result"

export const ID = PersonalJob.ID
export type ID = PersonalJob.ID
export const NotificationID = PersonalJob.NotificationID
export type NotificationID = PersonalJob.NotificationID
export const Status = PersonalJob.Status
export type Status = PersonalJob.Status
export const Info = PersonalJob.Info
export type Info = PersonalJob.Info
export const Event = PersonalJob.Event

const Durable = {
  definitions: SchemaEvent.durable(PersonalJob.Event.Definitions),
  schema: PersonalJob.DurableEvent,
} as const

const terminal = new Set<Status>(["completed", "failed", "cancelled"])
const maximumNotifications = 32
const maximumList = 500
const quietSearchLimit = 2 * 24 * 60
const defaultExecutionLeaseTtlMs = 60_000
const maximumExecutionLeaseTtlMs = 24 * 60 * 60 * 1_000

export const occurrenceDigest = (info: Pick<Info, "id" | "sessionID" | "prompt">, messageID: SessionMessage.ID) =>
  canonicalHash({ version: 1, jobID: info.id, sessionID: info.sessionID, prompt: info.prompt, messageID })

const makeOccurrence = (info: Info, revision: number): PersonalJob.Occurrence => {
  const messageID = SessionMessage.ID.make(`msg_personal_job_${info.id}_${revision}`)
  const digest = occurrenceDigest(info, messageID)
  if (!digest) throw new Error("Personal job occurrence must be canonically hashable")
  return PersonalJob.Occurrence.make({ version: 1, messageID, digest })
}

const budgetExhaustionReason = (budget: PersonalJob.Budget) => {
  if (budget.attemptsUsed >= budget.maxAttempts) return "maximum attempts exhausted"
  if (budget.durationMsUsed >= budget.maxDurationMs) return "maximum duration exhausted"
  // A zero cost limit is useful for free/local models. It permits a run that
  // settles at zero, while any positive settled charge exhausts the job.
  if (
    budget.costMicrosUsed > budget.maxCostMicros ||
    (budget.maxCostMicros > 0 && budget.costMicrosUsed >= budget.maxCostMicros)
  )
    return "maximum cost exhausted"
  return undefined
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PersonalJob.NotFoundError", {
  jobID: ID,
}) {}

export class IdempotencyConflictError extends Schema.TaggedErrorClass<IdempotencyConflictError>()(
  "PersonalJob.IdempotencyConflictError",
  { idempotencyKey: PersonalJob.IdempotencyKey, reason: Schema.String },
) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
  "PersonalJob.StaleRevisionError",
  {
    jobID: ID,
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("PersonalJob.InvalidStateError", {
  jobID: ID,
  status: Status,
  action: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedErrorClass<InvalidInputError>()("PersonalJob.InvalidInputError", {
  message: Schema.String,
}) {}

export class CredentialScopeError extends Schema.TaggedErrorClass<CredentialScopeError>()(
  "PersonalJob.CredentialScopeError",
  { missing: Schema.Array(Credential.ID) },
) {}

export class ApprovalError extends Schema.TaggedErrorClass<ApprovalError>()("PersonalJob.ApprovalError", {
  jobID: ID,
  state: PersonalJob.ApprovalState,
  action: Schema.String,
}) {}

export class ScheduleNotDueError extends Schema.TaggedErrorClass<ScheduleNotDueError>()(
  "PersonalJob.ScheduleNotDueError",
  { jobID: ID, nextRunAt: Schema.Number },
) {}

export class BudgetExhaustedError extends Schema.TaggedErrorClass<BudgetExhaustedError>()(
  "PersonalJob.BudgetExhaustedError",
  { jobID: ID, reason: Schema.String },
) {}

export class RetentionActiveError extends Schema.TaggedErrorClass<RetentionActiveError>()(
  "PersonalJob.RetentionActiveError",
  { jobID: ID, retainUntil: Schema.Number },
) {}

export class CorruptHistoryError extends Schema.TaggedErrorClass<CorruptHistoryError>()(
  "PersonalJob.CorruptHistoryError",
  { jobID: ID, reason: Schema.String },
) {}

export type ResultInput = Omit<PersonalJob.Result, "recordedAt">

export type CreateInput = {
  readonly idempotencyKey: PersonalJob.IdempotencyKey
  readonly sessionID: Info["sessionID"]
  readonly title: PersonalJob.Title
  readonly prompt: PersonalJob.Prompt
  readonly schedule: PersonalJob.Schedule
  readonly credentialIDs?: ReadonlyArray<Credential.ID>
  readonly budget: PersonalJob.BudgetLimits
  readonly approvalPolicy: PersonalJob.ApprovalPolicy
  readonly quietHours?: PersonalJob.QuietHours
  readonly notificationPolicy?: PersonalJob.NotificationPolicy
  readonly retainUntil?: DateTime.Utc
}

type Ownership = { readonly tenantID: string; readonly userID: string }
type Snapshot = { readonly info?: Info; readonly lastSequence: number; readonly deleted: boolean }

export type DomainError =
  | NotFoundError
  | IdempotencyConflictError
  | StaleRevisionError
  | InvalidStateError
  | InvalidInputError
  | CredentialScopeError
  | ApprovalError
  | ScheduleNotDueError
  | BudgetExhaustedError
  | RetentionActiveError
  | CorruptHistoryError

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, DomainError>
  readonly list: (input?: {
    readonly sessionID?: Info["sessionID"]
    readonly status?: Status
  }) => Effect.Effect<ReadonlyArray<Info>, DomainError>
  readonly get: (jobID: ID) => Effect.Effect<Info, DomainError>
  readonly approve: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, DomainError>
  readonly reject: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly reason?: string
  }) => Effect.Effect<Info, DomainError>
  readonly start: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly now?: number
    /** Trusted manual execution may run before the next scheduled occurrence. */
    readonly allowEarly?: boolean
  }) => Effect.Effect<Info, DomainError>
  /** Refreshes the durable execution fence without changing user-visible status. */
  readonly heartbeat: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly now?: number
  }) => Effect.Effect<Info, DomainError>
  readonly pause: (input: { readonly jobID: ID; readonly expectedRevision: number }) => Effect.Effect<Info, DomainError>
  readonly resume: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, DomainError>
  readonly cancel: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly reason?: string
  }) => Effect.Effect<Info, DomainError>
  readonly recordResult: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly result: ResultInput
  }) => Effect.Effect<Info, DomainError>
  /** Reconcile only the original persisted execution; accepts no caller-supplied result or new attempt. */
  readonly reconcileResult: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, DomainError>
  /** Advances due recurring jobs; execution itself remains owned by a trusted runner. */
  readonly tick: (input?: {
    readonly now?: number
    readonly limit?: number
    readonly sessionID?: Info["sessionID"]
  }) => Effect.Effect<number, DomainError>
  /** Requeues running jobs whose worker lease has expired after a process crash. */
  readonly recover: (input?: {
    readonly now?: number
    readonly staleAfterMs?: number
    readonly limit?: number
    readonly sessionID?: Info["sessionID"]
  }) => Effect.Effect<number, DomainError>
  readonly notifications: (jobID: ID) => Effect.Effect<ReadonlyArray<PersonalJob.Notification>, DomainError>
  readonly markNotificationRead: (input: {
    readonly jobID: ID
    readonly notificationID: PersonalJob.NotificationID
    readonly expectedRevision: number
  }) => Effect.Effect<Info, DomainError>
  /** Logical deletion preserves the durable audit stream while removing the user-visible job. */
  readonly delete: (input: {
    readonly jobID: ID
    readonly expectedRevision: number
    readonly now?: number
  }) => Effect.Effect<void, DomainError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/PersonalJob") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const events = yield* EventV2.Service
    const runs = yield* DurableRun.Service
    const messages = yield* SessionStore.Service

    const ownership = Effect.fn("PersonalJob.ownership")(function* () {
      const principal = yield* Database.CurrentPrincipal
      return {
        tenantID: principal?.tenantID ?? LOCAL_TENANT_ID,
        userID: principal?.userID ?? LOCAL_USER_ID,
      } satisfies Ownership
    })

    const sessionExists = Effect.fn("PersonalJob.sessionExists")(function* (
      sessionID: Info["sessionID"],
      owner: Ownership,
    ) {
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          and(
            eq(SessionTable.id, sessionID),
            eq(SessionTable.tenant_id, owner.tenantID),
            eq(SessionTable.owner_user_id, owner.userID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new InvalidInputError({ message: "The session does not belong to the current owner." })
    })

    const validateCredentials = Effect.fn("PersonalJob.validateCredentials")(function* (
      credentialIDs: ReadonlyArray<Credential.ID>,
      owner: Ownership,
    ) {
      const unique = new Set(credentialIDs)
      if (unique.size !== credentialIDs.length)
        return yield* new InvalidInputError({ message: "credentialIDs must not contain duplicates." })
      if (credentialIDs.length === 0) return
      const rows = yield* db
        .select({ id: CredentialTable.id })
        .from(CredentialTable)
        .where(
          and(
            eq(CredentialTable.tenant_id, owner.tenantID),
            eq(CredentialTable.owner_user_id, owner.userID),
            inArray(CredentialTable.id, [...credentialIDs]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const found = new Set(rows.map((row) => row.id))
      const missing = credentialIDs.filter((id) => !found.has(id))
      if (missing.length > 0) return yield* new CredentialScopeError({ missing })
    })

    const validateSchedule = Effect.fn("PersonalJob.validateSchedule")(function* (
      schedule: PersonalJob.Schedule,
      now: number,
      owner: Ownership,
      sessionID: Info["sessionID"],
    ) {
      const nextRunAt = DateTime.toEpochMillis(schedule.nextRunAt)
      if (!Number.isSafeInteger(nextRunAt))
        return yield* new InvalidInputError({ message: "schedule.nextRunAt must be a safe epoch millisecond." })
      if (schedule.kind === "once" && schedule.cron !== undefined)
        return yield* new InvalidInputError({ message: "A one-shot schedule cannot include cron." })
      if (schedule.kind === "cron") {
        if (schedule.cron === undefined)
          return yield* new InvalidInputError({ message: "A recurring schedule requires cron." })
        yield* Effect.try({
          try: () => CronSchedule.parse(schedule.cron!),
          catch: () => new InvalidInputError({ message: "schedule.cron is invalid." }),
        })
      }
      if (schedule.timezone.length === 0) return yield* new InvalidInputError({ message: "timezone is required." })
      yield* Effect.try({
        try: () => new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format(new Date(now)),
        catch: () => new InvalidInputError({ message: "schedule.timezone is invalid." }),
      })
      if (schedule.scheduledPromptID !== undefined) {
        const linked = yield* db
          .select({ id: ScheduledPromptTable.id })
          .from(ScheduledPromptTable)
          .where(
            and(
              eq(ScheduledPromptTable.id, schedule.scheduledPromptID),
              eq(ScheduledPromptTable.session_id, sessionID),
              eq(ScheduledPromptTable.tenant_id, owner.tenantID),
              eq(ScheduledPromptTable.owner_user_id, owner.userID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!linked) return yield* new InvalidInputError({ message: "scheduledPromptID is not owned by this session." })
      }
    })

    const validatePolicy = Effect.fn("PersonalJob.validatePolicy")(function* (
      input: Pick<CreateInput, "budget" | "approvalPolicy" | "quietHours" | "notificationPolicy">,
    ) {
      if (!Number.isSafeInteger(input.budget.maxAttempts) || input.budget.maxAttempts <= 0)
        return yield* new InvalidInputError({ message: "budget.maxAttempts must be a positive integer." })
      if (!Number.isSafeInteger(input.budget.maxDurationMs) || input.budget.maxDurationMs <= 0)
        return yield* new InvalidInputError({ message: "budget.maxDurationMs must be a positive integer." })
      if (!Number.isSafeInteger(input.budget.maxCostMicros) || input.budget.maxCostMicros < 0)
        return yield* new InvalidInputError({ message: "budget.maxCostMicros must be non-negative." })
      if (input.approvalPolicy.rationale.length > 1_000)
        return yield* new InvalidInputError({ message: "approvalPolicy.rationale is too long." })
      if (input.quietHours) {
        if (
          !Number.isSafeInteger(input.quietHours.startMinute) ||
          !Number.isSafeInteger(input.quietHours.endMinute) ||
          input.quietHours.startMinute < 0 ||
          input.quietHours.startMinute > 1_439 ||
          input.quietHours.endMinute < 0 ||
          input.quietHours.endMinute > 1_439 ||
          input.quietHours.startMinute === input.quietHours.endMinute
        )
          return yield* new InvalidInputError({ message: "quietHours must define two different minutes in a day." })
        yield* Effect.try({
          try: () => new Intl.DateTimeFormat("en-US", { timeZone: input.quietHours!.timezone }).format(new Date()),
          catch: () => new InvalidInputError({ message: "quietHours.timezone is invalid." }),
        })
      }
      const notificationEvents = input.notificationPolicy?.events ?? []
      if (new Set(notificationEvents).size !== notificationEvents.length)
        return yield* new InvalidInputError({ message: "notificationPolicy.events must not contain duplicates." })
    })

    const readOwned = Effect.fn("PersonalJob.readOwned")(function* (jobID: ID, owner: Ownership) {
      const owned = yield* db
        .select({ aggregateID: EventTable.aggregate_id })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, jobID),
            eq(EventTable.tenant_id, owner.tenantID),
            eq(EventTable.owner_user_id, owner.userID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!owned) return { info: undefined, lastSequence: -1, deleted: false } satisfies Snapshot

      const history = yield* EventV2.readAggregate(db, {
        aggregateID: jobID,
        limit: maximumList * 4,
        strict: true,
        manifest: Durable,
      }).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof EventV2.InvalidDurableEventError
            ? Effect.fail(new CorruptHistoryError({ jobID, reason: defect.message }))
            : Effect.die(defect),
        ),
      )
      let info: Info | undefined
      let deleted = false
      let lastSequence = -1
      for (const event of history.events) {
        const sequence = event.durable?.seq
        if (sequence === undefined) return yield* new CorruptHistoryError({ jobID, reason: "Missing event sequence." })
        if (sequence !== lastSequence + 1)
          return yield* new CorruptHistoryError({ jobID, reason: "Personal job history is not contiguous." })
        lastSequence = sequence
        if (event.type === PersonalJob.Event.Created.type) {
          if (sequence !== 0 || info !== undefined || deleted || event.data.jobID !== jobID)
            return yield* new CorruptHistoryError({ jobID, reason: "Invalid created event in personal job history." })
          if (event.data.job.id !== jobID || event.data.jobID !== event.data.job.id)
            return yield* new CorruptHistoryError({
              jobID,
              reason: "Created event identity does not match the aggregate.",
            })
          if (event.data.job.occurrence !== undefined)
            return yield* new CorruptHistoryError({
              jobID,
              reason: "Created job cannot contain an execution occurrence.",
            })
          info = event.data.job
          continue
        }
        if (event.type === PersonalJob.Event.Changed.type) {
          if (info === undefined || deleted || event.data.jobID !== jobID || event.data.job.id !== jobID)
            return yield* new CorruptHistoryError({ jobID, reason: "Invalid changed event in personal job history." })
          if (event.data.job.revision !== info.revision + 1)
            return yield* new CorruptHistoryError({ jobID, reason: "Personal job revisions are not contiguous." })
          const next = event.data.job
          if (
            (info.occurrence !== undefined || next.occurrence !== undefined) &&
            (next.sessionID !== info.sessionID ||
              next.prompt !== info.prompt ||
              next.admissionDigest !== info.admissionDigest)
          )
            return yield* new CorruptHistoryError({
              jobID,
              reason: "Personal job occurrence owner or original input changed.",
            })
          if (
            next.occurrence !== undefined &&
            next.occurrence.digest !== occurrenceDigest(next, next.occurrence.messageID)
          )
            return yield* new CorruptHistoryError({ jobID, reason: "Personal job occurrence input binding changed." })
          if (!isDeepStrictEqual(info.occurrence, next.occurrence)) {
            const firstStart =
              info.occurrence === undefined &&
              info.budget.attemptsUsed === 0 &&
              info.status === "queued" &&
              next.status === "running" &&
              event.data.reason === "start"
            const nextCycle =
              (info.status === "completed" || info.status === "failed") &&
              info.schedule.kind === "cron" &&
              (next.status === "queued" || next.status === "awaiting_approval") &&
              event.data.reason === "advance recurring schedule"
            if ((!firstStart && !nextCycle) || !isDeepStrictEqual(next.occurrence, makeOccurrence(next, next.revision)))
              return yield* new CorruptHistoryError({
                jobID,
                reason: "Personal job occurrence changed outside admission.",
              })
          }
          info = event.data.job
          continue
        }
        if (event.type === PersonalJob.Event.Deleted.type) {
          if (info === undefined || deleted || event.data.jobID !== jobID)
            return yield* new CorruptHistoryError({ jobID, reason: "Invalid deleted event in personal job history." })
          deleted = true
          info = undefined
          continue
        }
        return yield* new CorruptHistoryError({
          jobID,
          reason: "Unknown personal job event in the personal job history.",
        })
      }
      if (history.hasMore)
        return yield* new CorruptHistoryError({
          jobID,
          reason: "Personal job history exceeds the bounded recovery page.",
        })
      return { info, lastSequence, deleted } satisfies Snapshot
    })

    const notificationAvailableAt = (now: number, quietHours: PersonalJob.QuietHours | undefined) => {
      if (!quietHours || !isQuiet(now, quietHours)) return now
      for (let minute = 1; minute <= quietSearchLimit; minute++) {
        const candidate = now + minute * 60_000
        if (!isQuiet(candidate, quietHours)) return candidate
      }
      return now + quietSearchLimit * 60_000
    }

    const addNotification = (
      info: Info,
      kind: PersonalJob.NotificationKind,
      now: number,
      title: string,
      body: string,
    ): Info => {
      if (info.notificationPolicy.mode === "none" || !info.notificationPolicy.events.includes(kind)) return info
      const digest = canonicalHash({ jobID: info.id, revision: info.revision + 1, kind })
      if (!digest) return info
      if (
        info.notifications.some((notification) => notification.id === PersonalJob.NotificationID.make(`pjn_${digest}`))
      )
        return info
      const notification = PersonalJob.Notification.make({
        id: PersonalJob.NotificationID.make(`pjn_${digest}`),
        jobID: info.id,
        kind,
        title,
        body,
        availableAt: DateTime.makeUnsafe(notificationAvailableAt(now, info.quietHours)),
      })
      return {
        ...info,
        notifications: [...info.notifications, notification].slice(-maximumNotifications),
      }
    }

    const persistChanged = Effect.fn("PersonalJob.persistChanged")(function* (
      snapshot: Snapshot,
      next: Info,
      reason: string,
      validateCommit?: () => Effect.Effect<void>,
    ) {
      if (snapshot.info === undefined) return yield* new NotFoundError({ jobID: next.id })
      const owner = yield* ownership()
      const id = EventV2.ID.make(`evt_${next.id}_${next.revision}`)
      return yield* events
        .publish(
          PersonalJob.Event.Changed,
          {
            jobID: next.id,
            job: next,
            reason,
            changedAt: next.time.updated,
          },
          { id, expectedSequence: snapshot.lastSequence, commit: validateCommit },
        )
        .pipe(
          Effect.as(next),
          Effect.catchDefect((defect) => {
            if (
              !(defect instanceof EventV2.AggregateSequenceConflictError) &&
              !(defect instanceof EventV2.InvalidDurableEventError)
            )
              return Effect.die(defect)
            return readOwned(next.id, owner).pipe(
              Effect.flatMap((latest) => {
                if (latest.info && isDeepStrictEqual(latest.info, next)) return Effect.succeed(latest.info)
                return Effect.fail(
                  new StaleRevisionError({
                    jobID: next.id,
                    expectedRevision: snapshot.info!.revision,
                    actualRevision: latest.info?.revision ?? snapshot.info!.revision + 1,
                  }),
                )
              }),
            )
          }),
        )
    })

    const mutate = Effect.fn("PersonalJob.mutate")(function* (input: {
      readonly jobID: ID
      readonly expectedRevision: number
      readonly action: string
      readonly now?: number
      readonly build: (info: Info, now: number) => Effect.Effect<Info, DomainError>
      readonly validateCommit?: (before: Info, next: Info) => Effect.Effect<void>
    }) {
      const owner = yield* ownership()
      const snapshot = yield* readOwned(input.jobID, owner)
      if (snapshot.info === undefined) return yield* new NotFoundError({ jobID: input.jobID })
      if (snapshot.info.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          jobID: input.jobID,
          expectedRevision: input.expectedRevision,
          actualRevision: snapshot.info.revision,
        })
      const now = input.now ?? Date.now()
      const next = yield* input.build(snapshot.info, now)
      if (isDeepStrictEqual(next, snapshot.info)) return snapshot.info
      return yield* persistChanged(
        snapshot,
        next,
        input.action,
        input.validateCommit ? () => input.validateCommit!(snapshot.info!, next) : undefined,
      )
    })

    const get: Interface["get"] = Effect.fn("PersonalJob.get")(function* (jobID) {
      const snapshot = yield* readOwned(jobID, yield* ownership())
      if (snapshot.info === undefined) return yield* new NotFoundError({ jobID })
      return snapshot.info
    })

    const create: Interface["create"] = Effect.fn("PersonalJob.create")(function* (input) {
      const owner = yield* ownership()
      yield* sessionExists(input.sessionID, owner)
      yield* validateCredentials(input.credentialIDs ?? [], owner)
      yield* validatePolicy(input)
      const now = Date.now()
      yield* validateSchedule(input.schedule, now, owner, input.sessionID)
      const canonicalInput = canonicalHash({
        version: 1,
        sessionID: input.sessionID,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        prompt: input.prompt,
        schedule: {
          kind: input.schedule.kind,
          label: input.schedule.label,
          cron: input.schedule.cron ?? null,
          nextRunAt: DateTime.toEpochMillis(input.schedule.nextRunAt),
          timezone: input.schedule.timezone,
          scheduledPromptID: input.schedule.scheduledPromptID ?? null,
        },
        credentialIDs: [...(input.credentialIDs ?? [])],
        budget: input.budget,
        approvalPolicy: input.approvalPolicy,
        quietHours: input.quietHours ?? null,
        notificationPolicy: input.notificationPolicy ?? {
          mode: "in_app",
          events: ["approval_required", "completed", "failed", "cancelled"],
        },
        retainUntil: input.retainUntil === undefined ? null : DateTime.toEpochMillis(input.retainUntil),
      })
      if (!canonicalInput) return yield* new InvalidInputError({ message: "Job input is not canonically hashable." })
      const identity = canonicalHash({ version: 1, sessionID: input.sessionID, idempotencyKey: input.idempotencyKey })
      if (!identity) return yield* new InvalidInputError({ message: "Job identity is not canonically hashable." })
      const jobID = PersonalJob.ID.make(`pjob_${identity.slice(0, 32)}`)
      const existing = yield* readOwned(jobID, owner)
      if (existing.info) {
        if (existing.info.admissionDigest !== canonicalInput)
          return yield* new IdempotencyConflictError({
            idempotencyKey: input.idempotencyKey,
            reason: "The idempotency key was reused with a different job contract.",
          })
        return existing.info
      }
      if (existing.deleted)
        return yield* new IdempotencyConflictError({
          idempotencyKey: input.idempotencyKey,
          reason: "A deleted personal job identity cannot be recreated with the same idempotency key.",
        })
      const approvalRequired = input.approvalPolicy.mode !== "automatic"
      const notificationPolicy =
        input.notificationPolicy ??
        PersonalJob.NotificationPolicy.make({
          mode: "in_app",
          events: ["approval_required", "completed", "failed", "cancelled"],
        })
      const info = PersonalJob.Info.make({
        id: jobID,
        sessionID: input.sessionID,
        title: input.title,
        prompt: input.prompt,
        status: approvalRequired ? "awaiting_approval" : "queued",
        visibility: { mode: "background", label: "后台自动", userVisible: true },
        schedule: input.schedule,
        credentialIDs: [...(input.credentialIDs ?? [])],
        budget: {
          maxAttempts: input.budget.maxAttempts,
          maxDurationMs: input.budget.maxDurationMs,
          maxCostMicros: input.budget.maxCostMicros,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
        },
        approvalPolicy: input.approvalPolicy,
        approvalState: approvalRequired ? "pending" : "not_required",
        execution: undefined,
        ...(input.quietHours === undefined ? {} : { quietHours: input.quietHours }),
        notificationPolicy,
        notifications: [],
        ...(input.retainUntil === undefined ? { retention: {} } : { retention: { retainUntil: input.retainUntil } }),
        admissionDigest: canonicalInput,
        lastError: "",
        revision: 1,
        time: {
          created: DateTime.makeUnsafe(now),
          updated: DateTime.makeUnsafe(now),
        },
      })
      const visible = approvalRequired
        ? addNotification(info, "approval_required", now, "需要审批", "后台自动任务等待人工审批后才能运行。")
        : info
      return yield* events
        .publish(PersonalJob.Event.Created, { jobID, job: visible }, { id: EventV2.ID.make(`evt_${jobID}_created`) })
        .pipe(
          Effect.as(visible),
          Effect.catchDefect((defect) => {
            if (
              !(defect instanceof EventV2.AggregateSequenceConflictError) &&
              !(defect instanceof EventV2.InvalidDurableEventError)
            )
              return Effect.die(defect)
            return readOwned(jobID, owner).pipe(
              Effect.flatMap((raced) => {
                if (raced.info?.admissionDigest === canonicalInput) return Effect.succeed(raced.info)
                return Effect.fail(
                  new IdempotencyConflictError({
                    idempotencyKey: input.idempotencyKey,
                    reason: "A concurrent job already owns this idempotency identity.",
                  }),
                )
              }),
            )
          }),
        )
    })

    const list: Interface["list"] = Effect.fn("PersonalJob.list")(function* (input) {
      const owner = yield* ownership()
      const rows = yield* db
        .select({ aggregateID: EventTable.aggregate_id })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.type, EventV2.versionedType(PersonalJob.Event.Created.type, 1)),
            eq(EventTable.tenant_id, owner.tenantID),
            eq(EventTable.owner_user_id, owner.userID),
          ),
        )
        .orderBy(asc(EventTable.seq), asc(EventTable.aggregate_id))
        .limit(maximumList)
        .all()
        .pipe(Effect.orDie)
      const seen = new Set<string>()
      const jobs: Info[] = []
      for (const row of rows) {
        if (seen.has(row.aggregateID)) continue
        seen.add(row.aggregateID)
        const job = yield* readOwned(PersonalJob.ID.make(row.aggregateID), owner)
        if (job.info && (input?.sessionID === undefined || job.info.sessionID === input.sessionID)) {
          if (input?.status === undefined || job.info.status === input.status) jobs.push(job.info)
        }
      }
      return jobs.toSorted(
        (left, right) => DateTime.toEpochMillis(right.time.created) - DateTime.toEpochMillis(left.time.created),
      )
    })

    const approve: Interface["approve"] = (input) =>
      mutate({
        ...input,
        action: "approve",
        build: (info, now) => {
          if (info.approvalState === "approved") return Effect.succeed(info)
          if (info.approvalState !== "pending" || info.status !== "awaiting_approval")
            return Effect.fail(new ApprovalError({ jobID: info.id, state: info.approvalState, action: "approve" }))
          return Effect.succeed({
            ...addNotification(
              {
                ...info,
                approvalState: "approved",
                status: "queued",
                lastError: "",
                revision: info.revision + 1,
                time: { ...info.time, updated: DateTime.makeUnsafe(now) },
              },
              "started",
              now,
              "已批准",
              "后台自动任务已获批准，等待调度器运行。",
            ),
          })
        },
      })

    const reject: Interface["reject"] = (input) =>
      mutate({
        ...input,
        action: "reject",
        build: (info, now) => {
          if (info.approvalState === "rejected" && info.status === "cancelled") return Effect.succeed(info)
          if (info.approvalState !== "pending" || info.status !== "awaiting_approval")
            return Effect.fail(new ApprovalError({ jobID: info.id, state: info.approvalState, action: "reject" }))
          const next = {
            ...info,
            status: "cancelled" as const,
            approvalState: "rejected" as const,
            lastError: input.reason?.trim() || "User rejected the background job.",
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now), finished: DateTime.makeUnsafe(now) },
          }
          return Effect.succeed(addNotification(next, "cancelled", now, "已拒绝", next.lastError))
        },
      })

    const start: Interface["start"] = (input) =>
      mutate({
        ...input,
        action: "start",
        now: input.now,
        build: (info, now) => {
          if (info.status === "running") return Effect.succeed(info)
          if (info.status !== "queued") {
            if (info.status === "awaiting_approval" && info.approvalPolicy.mode !== "automatic")
              return Effect.fail(new ApprovalError({ jobID: info.id, state: info.approvalState, action: "start" }))
            return Effect.fail(new InvalidStateError({ jobID: info.id, status: info.status, action: "start" }))
          }
          if (info.approvalPolicy.mode !== "automatic" && info.approvalState !== "approved")
            return Effect.fail(new ApprovalError({ jobID: info.id, state: info.approvalState, action: "start" }))
          const nextRunAt = DateTime.toEpochMillis(info.schedule.nextRunAt)
          // A recurring occurrence is durably admitted by `tick` before its
          // schedule advances to the following time. `time.started` also
          // survives pause/recovery, so that admitted occurrence can resume
          // after a crash without being mistaken for an early future run.
          const occurrenceAlreadyAdmitted = info.time.started !== undefined
          if (nextRunAt > now && input.allowEarly !== true && !occurrenceAlreadyAdmitted)
            return Effect.fail(new ScheduleNotDueError({ jobID: info.id, nextRunAt }))
          const exhausted = budgetExhaustionReason(info.budget)
          if (exhausted !== undefined)
            return Effect.fail(new BudgetExhaustedError({ jobID: info.id, reason: exhausted }))
          if (info.occurrence === undefined && info.budget.attemptsUsed > 0)
            return Effect.fail(
              new InvalidInputError({
                message:
                  "This older task has no durable input identity. Reconcile its previous execution before retrying; it will not be submitted again automatically.",
              }),
            )
          const next = {
            ...info,
            status: "running" as const,
            schedule:
              input.allowEarly === true && info.schedule.kind === "once" && nextRunAt > now
                ? { ...info.schedule, nextRunAt: DateTime.makeUnsafe(now) }
                : info.schedule,
            approvalState: info.approvalPolicy.mode === "user_each_run" ? ("pending" as const) : info.approvalState,
            execution: PersonalJob.Execution.make({
              leaseID: `pje_${canonicalHash({ jobID: info.id, revision: info.revision + 1 })!.slice(0, 48)}`,
              heartbeatAt: DateTime.makeUnsafe(now),
            }),
            occurrence: info.occurrence ?? makeOccurrence(info, info.revision + 1),
            budget: { ...info.budget, attemptsUsed: info.budget.attemptsUsed + 1 },
            lastError: "",
            revision: info.revision + 1,
            time: {
              ...info.time,
              updated: DateTime.makeUnsafe(now),
              started: DateTime.makeUnsafe(now),
              finished: undefined,
            },
          }
          return Effect.succeed(addNotification(next, "started", now, "已开始", "后台自动任务已开始运行。"))
        },
      })

    const pause: Interface["pause"] = (input) =>
      mutate({
        ...input,
        action: "pause",
        build: (info, now) => {
          if (info.status === "paused") return Effect.succeed(info)
          if (!["queued", "running"].includes(info.status))
            return Effect.fail(new InvalidStateError({ jobID: info.id, status: info.status, action: "pause" }))
          const next = {
            ...info,
            status: "paused" as const,
            execution: undefined,
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now) },
          }
          return Effect.succeed(addNotification(next, "paused", now, "已暂停", "后台自动任务已暂停，可由用户恢复。"))
        },
      })

    const resume: Interface["resume"] = (input) =>
      mutate({
        ...input,
        action: "resume",
        build: (info, now) => {
          if (info.status !== "paused")
            return Effect.fail(new InvalidStateError({ jobID: info.id, status: info.status, action: "resume" }))
          const waiting = info.approvalPolicy.mode === "user_each_run" && info.time.started !== undefined
          return Effect.succeed({
            ...info,
            status: waiting ? ("awaiting_approval" as const) : ("queued" as const),
            approvalState: waiting ? ("pending" as const) : info.approvalState,
            execution: undefined,
            lastError: "",
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now) },
          })
        },
      })

    const cancel: Interface["cancel"] = (input) =>
      mutate({
        ...input,
        action: "cancel",
        build: (info, now) => {
          if (info.status === "cancelled") return Effect.succeed(info)
          if (info.status === "completed" || info.status === "failed") return Effect.succeed(info)
          const next = {
            ...info,
            status: "cancelled" as const,
            execution: undefined,
            lastError: input.reason?.trim() || "User cancelled the background job.",
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now), finished: DateTime.makeUnsafe(now) },
          }
          return Effect.succeed(addNotification(next, "cancelled", now, "已取消", next.lastError))
        },
      })

    const applyResult = (info: Info, now: number, resultInput: ResultInput): Effect.Effect<Info, DomainError> => {
      const usage = resultInput.usage
      if (
        !usage ||
        !Number.isSafeInteger(usage.durationMs) ||
        usage.durationMs < 0 ||
        !Number.isSafeInteger(usage.costMicros) ||
        usage.costMicros < 0
      )
        return Effect.fail(new InvalidInputError({ message: "result.usage must contain non-negative safe integers." }))
      if (!Array.isArray(resultInput.artifactRefs))
        return Effect.fail(new InvalidInputError({ message: "result.artifactRefs must be an array." }))
      if (resultInput.artifacts !== undefined) {
        const refs = new Set(resultInput.artifactRefs)
        const artifactIDs = resultInput.artifacts.map((artifact) => artifact.id)
        if (new Set(artifactIDs).size !== artifactIDs.length)
          return Effect.fail(new InvalidInputError({ message: "result.artifacts must not contain duplicates." }))
        if (artifactIDs.some((artifactID) => !refs.has(artifactID)))
          return Effect.fail(new InvalidInputError({ message: "result.artifacts must be listed in artifactRefs." }))
      }
      if (resultInput.status !== "completed" && resultInput.status !== "failed")
        return Effect.fail(new InvalidInputError({ message: "result.status is invalid." }))
      if (typeof resultInput.summary !== "string" || resultInput.summary.trim().length === 0)
        return Effect.fail(new InvalidInputError({ message: "result.summary must be non-empty." }))
      if (usage.durationMs > info.budget.maxDurationMs - info.budget.durationMsUsed)
        return Effect.fail(
          new BudgetExhaustedError({ jobID: info.id, reason: "result duration exceeds the job budget" }),
        )
      // A provider can report a billable amount larger than the pre-call
      // estimate. A failed receipt must still close the execution lease;
      // rejecting it here would leave the durable job stuck in `running`.
      // Completed results remain strictly bounded by the configured budget.
      if (
        resultInput.status === "completed" &&
        usage.costMicros > info.budget.maxCostMicros - info.budget.costMicrosUsed
      )
        return Effect.fail(new BudgetExhaustedError({ jobID: info.id, reason: "result cost exceeds the job budget" }))
      let digest: string
      try {
        digest = resultDigest(resultInput)
      } catch {
        return Effect.fail(new InvalidInputError({ message: "result could not be canonically encoded." }))
      }
      if (!digest || digest !== resultInput.digest)
        return Effect.fail(new InvalidInputError({ message: "result.digest does not match the canonical result." }))
      const result = PersonalJob.Result.make({ ...resultInput, recordedAt: DateTime.makeUnsafe(now) })
      const next = {
        ...info,
        status: resultInput.status,
        execution: undefined,
        result,
        budget: {
          ...info.budget,
          durationMsUsed: info.budget.durationMsUsed + usage.durationMs,
          costMicrosUsed: info.budget.costMicrosUsed + usage.costMicros,
        },
        lastError: resultInput.status === "failed" ? resultInput.summary : "",
        revision: info.revision + 1,
        time: { ...info.time, updated: DateTime.makeUnsafe(now), finished: DateTime.makeUnsafe(now) },
      }
      return Effect.succeed(
        addNotification(
          next,
          resultInput.status === "completed" ? "completed" : "failed",
          now,
          resultInput.status === "completed" ? "已完成" : "执行失败",
          resultInput.summary,
        ),
      )
    }

    const recordResult: Interface["recordResult"] = (input) =>
      mutate({
        ...input,
        action: "record result",
        build: (info, now) =>
          info.status !== "running"
            ? Effect.fail(new InvalidStateError({ jobID: info.id, status: info.status, action: "record result" }))
            : applyResult(info, now, input.result),
      })

    const readOriginalResult = (info: Info) =>
      readExecutionWith({ db, runs, messages }, info).pipe(
        Effect.catchDefect(() =>
          Effect.fail(
            new InvalidInputError({
              message:
                "The original PersonalJob execution cannot be verified. Its result and attempts were not changed; reconcile the original run before retrying.",
            }),
          ),
        ),
      )

    const reconcileResult: Interface["reconcileResult"] = (input) =>
      mutate({
        ...input,
        action: "recover recorded result",
        build: (info, now) =>
          Effect.gen(function* () {
            // Recording an already completed fact is not new execution or new
            // approval. A user's pause/cancel remains authoritative.
            if (!["running", "queued", "awaiting_approval"].includes(info.status) || !info.occurrence) return info
            yield* sessionExists(info.sessionID, yield* ownership())
            const stored = yield* readOriginalResult(info)
            if (!stored) return info
            return yield* applyResult(info, now, storedResult(info, stored))
          }),
        validateCommit: (before, next) =>
          Effect.gen(function* () {
            yield* sessionExists(before.sessionID, yield* ownership()).pipe(Effect.orDie)
            const stored = yield* readOriginalResult(before).pipe(Effect.orDie)
            if (
              !stored ||
              !next.result ||
              !isDeepStrictEqual({ ...storedResult(before, stored), recordedAt: next.result.recordedAt }, next.result)
            )
              yield* Effect.die(
                new InvalidInputError({
                  message: "The original PersonalJob result changed before its recovery commit.",
                }),
              )
          }),
      })

    const heartbeat: Interface["heartbeat"] = (input) =>
      mutate({
        ...input,
        action: "heartbeat",
        now: input.now,
        build: (info, now) => {
          if (info.status !== "running")
            return Effect.fail(new InvalidStateError({ jobID: info.id, status: info.status, action: "heartbeat" }))
          if (info.execution === undefined) return Effect.succeed(info)
          return Effect.succeed({
            ...info,
            execution: { ...info.execution, heartbeatAt: DateTime.makeUnsafe(now) },
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now) },
          })
        },
      })

    const tick: Interface["tick"] = Effect.fn("PersonalJob.tick")(function* (input) {
      const now = input?.now ?? Date.now()
      const limit = input?.limit ?? maximumList
      if (!Number.isSafeInteger(limit) || limit <= 0)
        return yield* new InvalidInputError({ message: "tick.limit must be a positive safe integer." })
      const jobs = yield* list({ sessionID: input?.sessionID })
      const dueRecurring = jobs
        .filter(
          (job) =>
            (job.status === "completed" || job.status === "failed") &&
            job.schedule.kind === "cron" &&
            DateTime.toEpochMillis(job.schedule.nextRunAt) <= now,
        )
        .slice(0, Math.min(limit, maximumList))
      let advanced = 0
      for (const job of dueRecurring) {
        const exhausted = budgetExhaustionReason(job.budget)
        if (exhausted !== undefined) {
          yield* mutate({
            jobID: job.id,
            expectedRevision: job.revision,
            action: "stop exhausted recurring schedule",
            now,
            build: (current) => {
              const message = `后台自动任务预算已用尽（${exhausted}），周期调度已停止。`
              const next = {
                ...current,
                status: "cancelled" as const,
                execution: undefined,
                lastError: message,
                revision: current.revision + 1,
                time: { ...current.time, updated: DateTime.makeUnsafe(now), finished: DateTime.makeUnsafe(now) },
              }
              return Effect.succeed(addNotification(next, "budget_exhausted", now, "预算已用尽", message))
            },
          })
          advanced++
          continue
        }
        const cron = job.schedule.cron
        if (cron === undefined) continue
        const nextRunAt = yield* Effect.try({
          try: () => CronSchedule.nextInTimeZone(cron, now, job.schedule.timezone),
          catch: () => new InvalidInputError({ message: "A recurring job has an invalid cron schedule." }),
        })
        const waiting = job.approvalPolicy.mode === "user_each_run"
        yield* mutate({
          jobID: job.id,
          expectedRevision: job.revision,
          action: "advance recurring schedule",
          now,
          build: (current) =>
            Effect.succeed({
              ...current,
              status: waiting ? ("awaiting_approval" as const) : ("queued" as const),
              approvalState: waiting ? ("pending" as const) : current.approvalState,
              schedule: { ...current.schedule, nextRunAt: DateTime.makeUnsafe(nextRunAt) },
              occurrence: makeOccurrence(current, current.revision + 1),
              revision: current.revision + 1,
              lastError: "",
              time: { ...current.time, updated: DateTime.makeUnsafe(now) },
            }),
        })
        advanced++
      }
      return advanced
    })

    const recover: Interface["recover"] = Effect.fn("PersonalJob.recover")(function* (input) {
      const now = input?.now ?? Date.now()
      const staleAfterMs = input?.staleAfterMs ?? defaultExecutionLeaseTtlMs
      const limit = input?.limit ?? maximumList
      if (!Number.isSafeInteger(now) || now < 0)
        return yield* new InvalidInputError({ message: "recover.now must be a non-negative safe integer." })
      if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > maximumExecutionLeaseTtlMs)
        return yield* new InvalidInputError({
          message: `recover.staleAfterMs must be between 1000 and ${maximumExecutionLeaseTtlMs}.`,
        })
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximumList)
        return yield* new InvalidInputError({ message: "recover.limit must be a positive bounded safe integer." })

      const jobs = yield* list({ sessionID: input?.sessionID, status: "running" })
      const stale = jobs
        .filter((job) => {
          const heartbeatAt = job.execution?.heartbeatAt ?? job.time.started ?? job.time.updated
          return now - DateTime.toEpochMillis(heartbeatAt) >= staleAfterMs
        })
        .slice(0, limit)
      let recovered = 0
      for (const job of stale) {
        const reconciled = yield* reconcileResult({ jobID: job.id, expectedRevision: job.revision }).pipe(Effect.exit)
        // Missing/corrupt evidence is not permission to replace an original
        // result with a synthetic exhaustion failure or to repeat execution.
        if (Exit.isFailure(reconciled)) continue
        if (reconciled.value.revision !== job.revision) {
          recovered++
          continue
        }
        const validateUnsettled = () =>
          Effect.gen(function* () {
            // The model may finish after the first read. Recheck under the
            // original event transaction before replacing the job's state.
            if (yield* readOriginalResult(job).pipe(Effect.orDie))
              yield* Effect.die(
                new InvalidInputError({
                  message: "The original task has completed; recover its result before changing its execution state.",
                }),
              )
          })
        if (job.budget.attemptsUsed >= job.budget.maxAttempts) {
          const summary = "后台工作进程已失联，且任务已达到最大尝试次数。"
          const result = {
            status: "failed" as const,
            summary,
            artifactRefs: [],
            usage: { durationMs: 0, costMicros: 0 },
          }
          const digest = canonicalHash(result)
          if (!digest) return yield* new InvalidInputError({ message: "Recovery result is not hashable." })
          const settled = yield* mutate({
            jobID: job.id,
            expectedRevision: job.revision,
            action: "record result",
            build: (current, recordedAt) => applyResult(current, recordedAt, { ...result, digest }),
            validateCommit: validateUnsettled,
          }).pipe(Effect.exit)
          if (Exit.isSuccess(settled)) recovered++
          continue
        }
        const waiting = job.approvalPolicy.mode === "user_each_run"
        const next = yield* mutate({
          jobID: job.id,
          expectedRevision: job.revision,
          action: "recover stale execution",
          now,
          validateCommit: validateUnsettled,
          build: (current) =>
            Effect.succeed({
              ...current,
              status: waiting ? ("awaiting_approval" as const) : ("queued" as const),
              approvalState: waiting ? ("pending" as const) : current.approvalState,
              execution: undefined,
              lastError: "上次后台工作进程已失联，任务已安全重新排队。",
              revision: current.revision + 1,
              time: { ...current.time, updated: DateTime.makeUnsafe(now) },
            }),
        }).pipe(Effect.exit)
        if (Exit.isSuccess(next)) recovered++
      }
      return recovered
    })

    const notifications: Interface["notifications"] = Effect.fn("PersonalJob.notifications")(function* (jobID) {
      const info = yield* get(jobID)
      const now = Date.now()
      return info.notifications.filter(
        (notification) => notification.readAt === undefined && DateTime.toEpochMillis(notification.availableAt) <= now,
      )
    })

    const markNotificationRead: Interface["markNotificationRead"] = (input) =>
      mutate({
        ...input,
        action: "mark notification read",
        build: (info, now) => {
          const current = info.notifications.find((notification) => notification.id === input.notificationID)
          if (!current)
            return Effect.fail(new InvalidInputError({ message: "Notification does not belong to this job." }))
          if (current.readAt !== undefined) return Effect.succeed(info)
          return Effect.succeed({
            ...info,
            notifications: info.notifications.map((notification) =>
              notification.id === input.notificationID
                ? { ...notification, readAt: DateTime.makeUnsafe(now) }
                : notification,
            ),
            revision: info.revision + 1,
            time: { ...info.time, updated: DateTime.makeUnsafe(now) },
          })
        },
      })

    const remove: Interface["delete"] = Effect.fn("PersonalJob.delete")(function* (input) {
      const owner = yield* ownership()
      const snapshot = yield* readOwned(input.jobID, owner)
      if (snapshot.info === undefined) return
      if (snapshot.info.revision !== input.expectedRevision)
        return yield* new StaleRevisionError({
          jobID: input.jobID,
          expectedRevision: input.expectedRevision,
          actualRevision: snapshot.info.revision,
        })
      if (!terminal.has(snapshot.info.status))
        return yield* new InvalidStateError({ jobID: input.jobID, status: snapshot.info.status, action: "delete" })
      const now = input.now ?? Date.now()
      const retainUntil = snapshot.info.retention.retainUntil
      if (retainUntil !== undefined && DateTime.toEpochMillis(retainUntil) > now)
        return yield* new RetentionActiveError({ jobID: input.jobID, retainUntil: DateTime.toEpochMillis(retainUntil) })
      yield* events
        .publish(
          PersonalJob.Event.Deleted,
          { jobID: input.jobID, deletedAt: DateTime.makeUnsafe(now), reason: "user_delete" },
          { id: EventV2.ID.make(`evt_${input.jobID}_deleted`), expectedSequence: snapshot.lastSequence },
        )
        .pipe(
          Effect.catchDefect((defect) => {
            if (
              !(defect instanceof EventV2.AggregateSequenceConflictError) &&
              !(defect instanceof EventV2.InvalidDurableEventError)
            )
              return Effect.die(defect)
            return readOwned(input.jobID, owner).pipe(
              Effect.flatMap((latest) => {
                if (latest.deleted && latest.info === undefined) return Effect.void
                return Effect.fail(
                  new StaleRevisionError({
                    jobID: input.jobID,
                    expectedRevision: input.expectedRevision,
                    actualRevision: latest.info?.revision ?? input.expectedRevision + 1,
                  }),
                )
              }),
            )
          }),
        )
    })

    return Service.of({
      create,
      list,
      get,
      approve,
      reject,
      start,
      heartbeat,
      pause,
      resume,
      cancel,
      recordResult,
      reconcileResult,
      tick,
      recover,
      notifications,
      markNotificationRead,
      delete: remove,
    })
  }),
)

function isQuiet(now: number, quietHours: PersonalJob.QuietHours) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: quietHours.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now))
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? -1)
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? -1)
  if (hour < 0 || minute < 0) return false
  const value = hour * 60 + minute
  return quietHours.startMinute < quietHours.endMinute
    ? value >= quietHours.startMinute && value < quietHours.endMinute
    : value >= quietHours.startMinute || value < quietHours.endMinute
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, DurableRun.globalNode, SessionStore.node],
})
