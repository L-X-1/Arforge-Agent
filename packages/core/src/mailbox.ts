export * as MailboxV2 from "./mailbox"

import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Mailbox } from "@arforge-ai/schema/mailbox"
import { TaskGraph } from "@arforge-ai/schema/task-graph"
import { Team } from "@arforge-ai/schema/team"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { EventSequenceTable } from "./event/sql"
import { redact } from "./redact"
import { DurableRun } from "./runtime/durable-run"
import { TaskGraphV2 } from "./task-graph"
import { TaskGraphTable } from "./task-graph/sql"
import { canonicalHash } from "./util/canonical-hash"
import { MailboxMessageTable, MailboxReceiptTable } from "./mailbox/sql"
import { TeamMemberTable, TeamTable } from "./team/sql"
import { TeamV2 } from "./team"

export const MessageID = Mailbox.MessageID
export type MessageID = Mailbox.MessageID
export const ReceiptID = Mailbox.ReceiptID
export type ReceiptID = Mailbox.ReceiptID
export const ProtocolVersion = Mailbox.ProtocolVersion
export const IdempotencyKey = Mailbox.IdempotencyKey
export type IdempotencyKey = Mailbox.IdempotencyKey
export const Kind = Mailbox.Kind
export type Kind = Mailbox.Kind
export const MessageStatus = Mailbox.MessageStatus
export type MessageStatus = Mailbox.MessageStatus
export const AckStatus = Mailbox.AckStatus
export type AckStatus = Mailbox.AckStatus
export const Payload = Mailbox.Payload
export type Payload = Mailbox.Payload
export const Summary = Mailbox.Summary
export type Summary = Mailbox.Summary
export const Text = Mailbox.Text
export type Text = Mailbox.Text
export const Reason = Mailbox.Reason
export type Reason = Mailbox.Reason
export const Message = Mailbox.Message
export type Message = Mailbox.Message
export const Receipt = Mailbox.Receipt
export type Receipt = Mailbox.Receipt
export const Delivery = Mailbox.Delivery
export type Delivery = Mailbox.Delivery
export const Inbox = Mailbox.Inbox
export type Inbox = Mailbox.Inbox
export const Event = Mailbox.Event

const ClosedRuns = new Set<AgentRuntime.RunStatus>(["completed", "failed", "cancelled"])
const ClosedTasks = new Set<TaskGraph.Status>(["completed", "cancelled"])
const MaximumInbox = 100
const Lead = Team.MemberName.make("lead")

export class InvalidBindingError extends Schema.TaggedErrorClass<InvalidBindingError>()("Mailbox.InvalidBindingError", {
  teamID: Team.ID,
  runID: AgentRuntime.RunID,
  taskID: AgentRuntime.TaskID,
  reason: Schema.String,
}) {}

export class MessageConflictError extends Schema.TaggedErrorClass<MessageConflictError>()(
  "Mailbox.MessageConflictError",
  { messageID: MessageID, reason: Schema.String },
) {}

export class ReceiptConflictError extends Schema.TaggedErrorClass<ReceiptConflictError>()(
  "Mailbox.ReceiptConflictError",
  { receiptID: ReceiptID, reason: Schema.String },
) {}

export class MessageNotFoundError extends Schema.TaggedErrorClass<MessageNotFoundError>()(
  "Mailbox.MessageNotFoundError",
  { messageID: MessageID },
) {}

export class MemberNotFoundError extends Schema.TaggedErrorClass<MemberNotFoundError>()("Mailbox.MemberNotFoundError", {
  teamID: Team.ID,
  member: Schema.String,
}) {}

export class MemberInactiveError extends Schema.TaggedErrorClass<MemberInactiveError>()("Mailbox.MemberInactiveError", {
  member: Team.MemberName,
  status: Team.MemberStatus,
}) {}

export class UnauthorizedMailboxActionError extends Schema.TaggedErrorClass<UnauthorizedMailboxActionError>()(
  "Mailbox.UnauthorizedActionError",
  { actor: Team.MemberName, action: Schema.String },
) {}

export class RunClosedError extends Schema.TaggedErrorClass<RunClosedError>()("Mailbox.RunClosedError", {
  runID: AgentRuntime.RunID,
  status: AgentRuntime.RunStatus,
}) {}

export class TaskClosedError extends Schema.TaggedErrorClass<TaskClosedError>()("Mailbox.TaskClosedError", {
  taskID: AgentRuntime.TaskID,
  status: TaskGraph.Status,
}) {}

export class PayloadRejectedError extends Schema.TaggedErrorClass<PayloadRejectedError>()("Mailbox.PayloadRejectedError", {
  reason: Schema.String,
}) {}

type DomainError =
  | InvalidBindingError
  | MessageConflictError
  | ReceiptConflictError
  | MessageNotFoundError
  | MemberNotFoundError
  | MemberInactiveError
  | UnauthorizedMailboxActionError
  | RunClosedError
  | TaskClosedError
  | PayloadRejectedError

export interface Interface {
  readonly send: (input: {
    readonly teamID: Team.ID
    readonly runID: AgentRuntime.RunID
    readonly taskID: AgentRuntime.TaskID
    readonly sender: Team.MemberName
    readonly recipient: Team.MemberName
    readonly idempotencyKey: IdempotencyKey
    readonly kind: Kind
    readonly payload: Payload
  }) => Effect.Effect<Mailbox.Message, DomainError>
  readonly list: (input: {
    readonly teamID: Team.ID
    readonly runID: AgentRuntime.RunID
    readonly taskID: AgentRuntime.TaskID
    readonly recipient: Team.MemberName
    readonly afterSequence?: number
    readonly limit?: number
  }) => Effect.Effect<Mailbox.Inbox, DomainError>
  readonly acknowledge: (input: {
    readonly messageID: MessageID
    readonly recipient: Team.MemberName
    readonly status: "accepted" | "rejected"
    readonly reason?: Mailbox.Reason
  }) => Effect.Effect<Mailbox.Receipt, DomainError>
  readonly inspect: (input: {
    readonly messageID: MessageID
    readonly actor: Team.MemberName
  }) => Effect.Effect<Mailbox.Delivery, DomainError>
  readonly cancel: (input: {
    readonly messageID: MessageID
    readonly actor: Team.MemberName
    readonly reason?: Mailbox.Reason
  }) => Effect.Effect<Mailbox.Message, DomainError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Mailbox") {}

type MemberRow = typeof TeamMemberTable.$inferSelect
type MessageRow = typeof MailboxMessageTable.$inferSelect
type ReceiptRow = typeof MailboxReceiptTable.$inferSelect

type BindingInput = {
  readonly teamID: Team.ID
  readonly runID: AgentRuntime.RunID
  readonly taskID: AgentRuntime.TaskID
  readonly actor?: Team.MemberName
  readonly requireOpen: boolean
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const events = yield* EventV2.Service
    const teams = yield* TeamV2.Service
    const tasks = yield* TaskGraphV2.Service
    const durableRuns = yield* DurableRun.Service

    const validateBinding = Effect.fn("Mailbox.validateBinding")(function* (input: BindingInput) {
      const team = yield* db
        .select()
        .from(TeamTable)
        .where(eq(TeamTable.id, input.teamID))
        .get()
        .pipe(Effect.orDie)
      if (!team)
        return yield* invalidBinding(input, "The team does not exist.")

      const snapshot = yield* durableRuns.load(input.runID).pipe(
        Effect.mapError(() => invalidBindingError(input, "The durable run does not exist or cannot be reconstructed.")),
      )
      if (!("sessionID" in snapshot.run))
        return yield* invalidBinding(input, "A control-plane run cannot own an agent mailbox.")
      const run = snapshot.run
      if (run.sessionID !== team.session_id)
        return yield* invalidBinding(input, "The team and run belong to different sessions.")
      if (input.requireOpen && ClosedRuns.has(run.status))
        return yield* new RunClosedError({ runID: input.runID, status: run.status })

      const teamInfo = yield* teams.get(team.session_id).pipe(
        Effect.mapError(() => invalidBindingError(input, "The team projection cannot be loaded.")),
      )
      if (teamInfo.id !== input.teamID)
        return yield* invalidBinding(input, "The session has a different team binding.")

      const task = yield* tasks
        .get({ sessionID: run.sessionID, taskID: input.taskID })
        .pipe(Effect.mapError(() => invalidBindingError(input, "The task does not belong to the run session.")))
      if (input.requireOpen && ClosedTasks.has(task.status))
        return yield* new TaskClosedError({ taskID: input.taskID, status: task.status })

      const members = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, input.teamID))
        .all()
        .pipe(Effect.orDie)
      const actor = input.actor === undefined ? undefined : findMember(members, input.actor)
      if (input.actor !== undefined && !actor)
        return yield* new MemberNotFoundError({ teamID: input.teamID, member: input.actor })
      if (actor && actor.status !== "active")
        return yield* new MemberInactiveError({ member: actor.name, status: actor.status })
      return { team, run, task, members, actor }
    })

    const send = Effect.fn("Mailbox.send")(function* (input: {
      readonly teamID: Team.ID
      readonly runID: AgentRuntime.RunID
      readonly taskID: AgentRuntime.TaskID
      readonly sender: Team.MemberName
      readonly recipient: Team.MemberName
      readonly idempotencyKey: IdempotencyKey
      readonly kind: Kind
      readonly payload: Payload
    }) {
      const payload = yield* normalizePayload(input.payload)
      const idempotencyKey = yield* normalizeIdempotencyKey(input.idempotencyKey)
      const binding = yield* validateBinding({
        teamID: input.teamID,
        runID: input.runID,
        taskID: input.taskID,
        actor: input.sender,
        requireOpen: false,
      })
      const sender = binding.actor!
      if (input.recipient === "*")
        return yield* new UnauthorizedMailboxActionError({ actor: sender.name, action: "broadcast a mailbox message" })
      const recipient = findMember(binding.members, input.recipient)
      if (!recipient) return yield* new MemberNotFoundError({ teamID: input.teamID, member: input.recipient })
      if (sender.name_key === recipient.name_key)
        return yield* new UnauthorizedMailboxActionError({ actor: sender.name, action: "send a message to itself" })

      const digest = canonicalDigest({
        version: 1,
        teamID: input.teamID,
        runID: input.runID,
        taskID: input.taskID,
        sender: sender.name,
        recipient: recipient.name,
        idempotencyKey,
        kind: input.kind,
        payload,
      })
      const identityDigest = canonicalDigest({
        version: 1,
        teamID: input.teamID,
        runID: input.runID,
        taskID: input.taskID,
        sender: sender.name,
        recipient: recipient.name,
        idempotencyKey,
      })
      const messageID = Mailbox.MessageID.make(`mbx_${identityDigest.slice(0, 32)}`)
      const now = Date.now()
      const persisted = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* tx
            .select()
            .from(MailboxMessageTable)
            .where(eq(MailboxMessageTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            if (existing.digest !== digest)
              return yield* new MessageConflictError({
                messageID,
                reason: "The idempotency key was reused with a different payload.",
              })
            return { row: existing, created: false }
          }

          yield* lockRunOpen(
            tx,
            {
              teamID: input.teamID,
              runID: input.runID,
              taskID: input.taskID,
              run: binding.run,
            },
            durableRuns.load,
          )
          yield* lockTaskOpen(tx, input.teamID, input.runID, binding.run.sessionID, input.taskID)
          const lockedMembers = yield* lockMembersActive(tx, input.teamID, [sender.name, recipient.name])
          const senderCurrent = lockedMembers.get(sender.name_key)!
          const recipientCurrent = lockedMembers.get(recipient.name_key)!

          const next = yield* tx
            .update(TeamTable)
            .set({
              next_sequence: sql`${TeamTable.next_sequence} + 1`,
              revision: sql`${TeamTable.revision} + 1`,
              time_updated: now,
            })
            .where(eq(TeamTable.id, input.teamID))
            .returning({ nextSequence: TeamTable.next_sequence })
            .get()
            .pipe(Effect.orDie)
          if (!next) return yield* Effect.die("Failed to reserve a mailbox sequence")

          const inserted = yield* tx
            .insert(MailboxMessageTable)
            .values({
              id: messageID,
              protocol_version: 1,
              team_id: input.teamID,
              run_id: input.runID,
              task_id: input.taskID,
              sender: senderCurrent.name,
              recipient: recipientCurrent.name,
              sequence: next.nextSequence - 1,
              idempotency_key: idempotencyKey,
              kind: input.kind,
              summary: payload.summary,
              message: payload.text,
              artifact_refs: payload.artifactRefs,
              evidence_refs: payload.evidenceRefs,
              digest,
              status: "queued",
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (inserted) return { row: inserted, created: true }

          const raced = yield* tx
            .select()
            .from(MailboxMessageTable)
            .where(eq(MailboxMessageTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
          if (!raced) return yield* Effect.die("Mailbox idempotency conflict did not leave a row")
          if (raced.digest !== digest)
            return yield* new MessageConflictError({
              messageID,
              reason: "The idempotency key was reused with a different payload.",
            })
          return { row: raced, created: false }
        }),
      ).pipe(databaseOrDie)
      const message = toMessage(persisted.row)
      if (persisted.created) yield* events.publish(Event.MessageSent, { message })
      return message
    })

    const list = Effect.fn("Mailbox.list")(function* (input: {
      readonly teamID: Team.ID
      readonly runID: AgentRuntime.RunID
      readonly taskID: AgentRuntime.TaskID
      readonly recipient: Team.MemberName
      readonly afterSequence?: number
      readonly limit?: number
    }) {
      const binding = yield* validateBinding({ ...input, actor: input.recipient, requireOpen: true })
      const after = Math.max(0, Math.trunc(input.afterSequence ?? 0))
      const limit = Math.max(1, Math.min(MaximumInbox, Math.trunc(input.limit ?? 50)))
      const rows = yield* db
        .select()
        .from(MailboxMessageTable)
        .where(
          and(
            eq(MailboxMessageTable.team_id, input.teamID),
            eq(MailboxMessageTable.run_id, input.runID),
            eq(MailboxMessageTable.task_id, input.taskID),
            eq(MailboxMessageTable.recipient, binding.actor!.name),
            gt(MailboxMessageTable.sequence, after),
          ),
        )
        .orderBy(asc(MailboxMessageTable.sequence))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map(toMessage)
      return Mailbox.Inbox.make({
        teamID: input.teamID,
        runID: input.runID,
        taskID: input.taskID,
        recipient: binding.actor!.name,
        messages,
        count: messages.length,
        lastSequence: messages.at(-1)?.sequence ?? after,
      })
    })

    const acknowledge = Effect.fn("Mailbox.acknowledge")(function* (input: {
      readonly messageID: MessageID
      readonly recipient: Team.MemberName
      readonly status: "accepted" | "rejected"
      readonly reason?: Mailbox.Reason
    }) {
      const message = yield* findMessage(db, input.messageID)
      const binding = yield* validateBinding({
        teamID: message.team_id,
        runID: message.run_id,
        taskID: message.task_id,
        actor: input.recipient,
        requireOpen: false,
      })
      if (binding.actor!.name_key !== message.recipient.toLowerCase())
        return yield* new UnauthorizedMailboxActionError({
          actor: binding.actor!.name,
          action: "acknowledge a message addressed to another member",
        })
      const reason = normalizeReason(input.reason)
      const receiptID = Mailbox.ReceiptID.make(
        `mbr_${canonicalDigest({ version: 1, messageID: input.messageID, recipient: message.recipient }).slice(0, 32)}`,
      )
      const now = Date.now()
      const persisted = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* findReceipt(tx, message.id, message.recipient)
          if (existing) {
            if (
              existing.message_digest !== message.digest ||
              existing.status !== input.status ||
              existing.reason !== reason
            )
              return yield* new ReceiptConflictError({
                receiptID: existing.id,
                reason: "The acknowledgement was reused with different status or reason.",
              })
            return { row: existing, created: false }
          }
          const current = yield* tx
            .select()
            .from(MailboxMessageTable)
            .where(eq(MailboxMessageTable.id, message.id))
            .get()
            .pipe(Effect.orDie)
          if (!current) return yield* new MessageNotFoundError({ messageID: input.messageID })
          yield* lockRunOpen(
            tx,
            {
              teamID: current.team_id,
              runID: current.run_id,
              taskID: current.task_id,
              run: binding.run,
            },
            durableRuns.load,
          )
          yield* lockTaskOpen(tx, current.team_id, current.run_id, binding.run.sessionID, current.task_id)
          yield* lockMemberActive(tx, current.team_id, current.recipient)
          if (current.status !== "queued")
            return yield* new MessageConflictError({
              messageID: input.messageID,
              reason: `The message is already ${current.status}.`,
            })
          const updated = yield* tx
            .update(MailboxMessageTable)
            .set({ status: input.status === "accepted" ? "acknowledged" : "rejected", time_updated: now })
            .where(and(eq(MailboxMessageTable.id, current.id), eq(MailboxMessageTable.status, "queued")))
            .returning({ id: MailboxMessageTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* new MessageConflictError({
              messageID: input.messageID,
              reason: "The message changed while it was being acknowledged.",
            })
          const inserted = yield* tx
            .insert(MailboxReceiptTable)
            .values({
              id: receiptID,
              protocol_version: 1,
              message_id: current.id,
              team_id: current.team_id,
              run_id: current.run_id,
              task_id: current.task_id,
              recipient: current.recipient,
              status: input.status,
              message_digest: current.digest,
              reason,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (inserted) return { row: inserted, created: true }
          const raced = yield* findReceipt(tx, current.id, current.recipient)
          if (!raced) return yield* Effect.die("Mailbox receipt conflict did not leave a row")
          if (raced.message_digest !== current.digest || raced.status !== input.status || raced.reason !== reason)
            return yield* new ReceiptConflictError({
              receiptID: raced.id,
              reason: "The acknowledgement was reused with different status or reason.",
            })
          return { row: raced, created: false }
        }),
      ).pipe(databaseOrDie)
      const receipt = toReceipt(persisted.row)
      if (persisted.created) yield* events.publish(Event.Acknowledged, { receipt })
      return receipt
    })

    const inspect = Effect.fn("Mailbox.inspect")(function* (input: {
      readonly messageID: MessageID
      readonly actor: Team.MemberName
    }) {
      const row = yield* findMessage(db, input.messageID)
      const binding = yield* validateBinding({
        teamID: row.team_id,
        runID: row.run_id,
        taskID: row.task_id,
        actor: input.actor,
        requireOpen: false,
      })
      const actor = binding.actor!
      if (
        actor.name_key !== row.sender.toLowerCase() &&
        actor.name_key !== row.recipient.toLowerCase() &&
        actor.name_key !== Lead.toLowerCase()
      )
        return yield* new UnauthorizedMailboxActionError({
          actor: actor.name,
          action: "inspect a message belonging to other members",
        })
      const receipt = yield* findReceipt(db, row.id, row.recipient)
      return Mailbox.Delivery.make({
        message: toMessage(row),
        receipt: receipt ? toReceipt(receipt) : undefined,
      })
    })

    const cancel = Effect.fn("Mailbox.cancel")(function* (input: {
      readonly messageID: MessageID
      readonly actor: Team.MemberName
      readonly reason?: Mailbox.Reason
    }) {
      const message = yield* findMessage(db, input.messageID)
      const binding = yield* validateBinding({
        teamID: message.team_id,
        runID: message.run_id,
        taskID: message.task_id,
        actor: input.actor,
        requireOpen: false,
      })
      const actor = binding.actor!
      if (actor.name_key !== message.sender.toLowerCase() && actor.name_key !== Lead.toLowerCase())
        return yield* new UnauthorizedMailboxActionError({ actor: actor.name, action: "cancel another member's message" })
      const reason = normalizeReason(input.reason) || Mailbox.Reason.make("Cancelled")
      const now = Date.now()
      const persisted = yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const current = yield* tx
            .select()
            .from(MailboxMessageTable)
            .where(eq(MailboxMessageTable.id, message.id))
            .get()
            .pipe(Effect.orDie)
          if (!current) return yield* new MessageNotFoundError({ messageID: input.messageID })
          yield* lockMemberActive(tx, current.team_id, actor.name)
          if (current.status === "cancelled") {
            if (current.cancel_reason !== reason)
              return yield* new MessageConflictError({ messageID: input.messageID, reason: "The cancellation reason differs." })
            return { row: current, created: false }
          }
          if (current.status !== "queued")
            return yield* new MessageConflictError({
              messageID: input.messageID,
              reason: `The message is already ${current.status}.`,
            })
          const existingReceipt = yield* findReceipt(tx, current.id, current.recipient)
          if (existingReceipt)
            return yield* new ReceiptConflictError({
              receiptID: existingReceipt.id,
              reason: "The message already has a non-cancellation receipt.",
            })
          const updated = yield* tx
            .update(MailboxMessageTable)
            .set({ status: "cancelled", cancel_reason: reason, time_updated: now })
            .where(and(eq(MailboxMessageTable.id, current.id), eq(MailboxMessageTable.status, "queued")))
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* new MessageConflictError({
              messageID: input.messageID,
              reason: "The message changed while it was being cancelled.",
            })
          const receiptID = Mailbox.ReceiptID.make(
            `mbr_${canonicalDigest({ version: 1, messageID: current.id, recipient: current.recipient }).slice(0, 32)}`,
          )
          const receipt = yield* tx
            .insert(MailboxReceiptTable)
            .values({
              id: receiptID,
              protocol_version: 1,
              message_id: current.id,
              team_id: current.team_id,
              run_id: current.run_id,
              task_id: current.task_id,
              recipient: current.recipient,
              status: "cancelled",
              message_digest: current.digest,
              reason,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .returning({ id: MailboxReceiptTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!receipt) return yield* Effect.die("Failed to persist mailbox cancellation receipt")
          return { row: updated, created: true }
        }),
      ).pipe(databaseOrDie)
      const result = toMessage(persisted.row)
      if (persisted.created) yield* events.publish(Event.Cancelled, { message: result })
      return result
    })

    return Service.of({ send, list, acknowledge, inspect, cancel })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, TeamV2.node, TaskGraphV2.node, DurableRun.node],
})

function findMember(rows: ReadonlyArray<MemberRow>, name: string) {
  return rows.find((member) => member.name_key === name.toLowerCase())
}

function findMessage(db: Database.Interface["db"], messageID: MessageID) {
  return db
    .select()
    .from(MailboxMessageTable)
    .where(eq(MailboxMessageTable.id, messageID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((row) => (row ? Effect.succeed(row) : new MessageNotFoundError({ messageID }))),
    )
}

function findReceipt(
  db: Pick<Database.Interface["db"], "select">,
  messageID: Mailbox.MessageID,
  recipient: Team.MemberName,
) {
  return db
    .select()
    .from(MailboxReceiptTable)
    .where(and(eq(MailboxReceiptTable.message_id, messageID), eq(MailboxReceiptTable.recipient, recipient)))
    .get()
    .pipe(Effect.orDie)
}

function lockRunOpen(
  db: Pick<Database.Interface["db"], "update">,
  input: Pick<BindingInput, "teamID" | "runID" | "taskID"> & { readonly run: AgentRuntime.SessionRun },
  loadRun: DurableRun.Interface["load"],
) {
  return Effect.gen(function* () {
    const sequence = yield* db
      .update(EventSequenceTable)
      .set({ seq: sql`${EventSequenceTable.seq}` })
      .where(eq(EventSequenceTable.aggregate_id, input.run.id))
      .returning({ seq: EventSequenceTable.seq })
      .get()
      .pipe(Effect.orDie)
    if (!sequence)
      return yield* invalidBinding(input, "The durable run sequence disappeared during the mailbox transaction.")

    // The no-op update serializes against durable event appends. Reconstruct
    // through DurableRun itself so unknown tails or corrupt history fail closed
    // instead of duplicating a weaker status projection in the mailbox.
    const snapshot = yield* loadRun(input.run.id).pipe(
      Effect.mapError(() => invalidBindingError(input, "The locked durable run history failed strict reconstruction.")),
    )
    if (
      snapshot.lastSequence !== sequence.seq ||
      !("sessionID" in snapshot.run) ||
      snapshot.run.id !== input.run.id ||
      snapshot.run.sessionID !== input.run.sessionID
    )
      return yield* invalidBinding(input, "The locked durable run no longer matches the mailbox binding.")
    if (ClosedRuns.has(snapshot.run.status))
      return yield* new RunClosedError({ runID: input.run.id, status: snapshot.run.status })
    return yield* Effect.void
  })
}

function lockTaskOpen(
  db: Pick<Database.Interface["db"], "update">,
  teamID: Team.ID,
  runID: AgentRuntime.RunID,
  sessionID: AgentRuntime.SessionRun["sessionID"],
  taskID: AgentRuntime.TaskID,
) {
  return Effect.gen(function* () {
    const task = yield* db
      .update(TaskGraphTable)
      .set({ revision: sql`${TaskGraphTable.revision}` })
      .where(and(eq(TaskGraphTable.session_id, sessionID), eq(TaskGraphTable.id, taskID)))
      .returning({ status: TaskGraphTable.status })
      .get()
      .pipe(Effect.orDie)
    if (!task)
      return yield* new InvalidBindingError({
        teamID,
        runID,
        taskID,
        reason: "The task binding disappeared during the mailbox transaction.",
      })
    if (ClosedTasks.has(task.status)) return yield* new TaskClosedError({ taskID, status: task.status })
    return yield* Effect.void
  })
}

function lockMemberActive(
  db: Pick<Database.Interface["db"], "update">,
  teamID: Team.ID,
  member: Team.MemberName,
) {
  return Effect.gen(function* () {
    const row = yield* db
      .update(TeamMemberTable)
      .set({ revision: sql`${TeamMemberTable.revision}` })
      .where(and(eq(TeamMemberTable.team_id, teamID), eq(TeamMemberTable.name_key, member.toLowerCase())))
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new MemberNotFoundError({ teamID, member })
    if (row.status !== "active") return yield* new MemberInactiveError({ member: row.name, status: row.status })
    return row
  })
}

function lockMembersActive(
  db: Pick<Database.Interface["db"], "update">,
  teamID: Team.ID,
  members: ReadonlyArray<Team.MemberName>,
) {
  return Effect.forEach(
    [...members].sort((left, right) => {
      const leftKey = left.toLowerCase()
      const rightKey = right.toLowerCase()
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
    }),
    (member) => lockMemberActive(db, teamID, member),
    { concurrency: 1 },
  ).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.name_key, row]))))
}

function normalizePayload(payload: Payload) {
  return Effect.try({
    try: () =>
      Mailbox.Payload.make({
        summary: redact(payload.summary).trim(),
        text: redact(payload.text).trim(),
        artifactRefs: [...payload.artifactRefs],
        evidenceRefs: [...payload.evidenceRefs],
      }),
    catch: (error) => new PayloadRejectedError({ reason: String(error) }),
  })
}

function normalizeIdempotencyKey(value: IdempotencyKey) {
  return Effect.try({
    try: () => {
      const normalized = value.trim()
      if (redact(normalized) !== normalized) throw new Error("secret-like idempotency keys are not accepted")
      return Mailbox.IdempotencyKey.make(normalized)
    },
    catch: (error) => new PayloadRejectedError({ reason: `Invalid idempotency key: ${String(error)}` }),
  })
}

function normalizeReason(value?: Mailbox.Reason) {
  return Mailbox.Reason.make(redact(value ?? "").trim())
}

function canonicalDigest(value: unknown) {
  const digest = canonicalHash(value)
  if (!digest) throw new Error("Mailbox input is not canonicalizable")
  return digest
}

function invalidBindingError(input: Pick<BindingInput, "teamID" | "runID" | "taskID">, reason: string) {
  return new InvalidBindingError({ teamID: input.teamID, runID: input.runID, taskID: input.taskID, reason })
}

function invalidBinding(input: Pick<BindingInput, "teamID" | "runID" | "taskID">, reason: string) {
  return Effect.fail(invalidBindingError(input, reason))
}

function toMessage(row: MessageRow): Mailbox.Message {
  return Mailbox.Message.make({
    version: row.protocol_version,
    id: row.id,
    teamID: row.team_id,
    runID: row.run_id,
    taskID: row.task_id,
    sender: row.sender,
    recipient: row.recipient,
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    payload: {
      summary: row.summary,
      text: row.message,
      artifactRefs: row.artifact_refs,
      evidenceRefs: row.evidence_refs,
    },
    digest: row.digest,
    status: row.status,
    cancelReason: row.cancel_reason ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  })
}

function toReceipt(row: ReceiptRow): Mailbox.Receipt {
  return Mailbox.Receipt.make({
    version: row.protocol_version,
    id: row.id,
    messageID: row.message_id,
    teamID: row.team_id,
    runID: row.run_id,
    taskID: row.task_id,
    recipient: row.recipient,
    status: row.status,
    messageDigest: row.message_digest,
    reason: row.reason,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  })
}

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))))
}

function isDomainError(error: unknown): error is DomainError {
  return typeof error === "object" && error !== null && "_tag" in error && String(error._tag).startsWith("Mailbox.")
}
