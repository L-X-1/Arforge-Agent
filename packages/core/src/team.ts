export * as TeamV2 from "./team"

import { Team } from "@arforge-ai/schema/team"
import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "./agent"
import { Database } from "./database/database"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { SessionSchema } from "./session/schema"
import { TeamMemberTable, TeamMessageTable, TeamShutdownTable, TeamTable } from "./team/sql"

export const ID = Team.ID
export type ID = Team.ID
export const MessageID = Team.MessageID
export type MessageID = Team.MessageID
export const ShutdownID = Team.ShutdownID
export type ShutdownID = Team.ShutdownID
export const Name = Team.Name
export type Name = Team.Name
export const Description = Team.Description
export type Description = Team.Description
export const MemberName = Team.MemberName
export type MemberName = Team.MemberName
export const CollaboratorName = Team.CollaboratorName
export type CollaboratorName = Team.CollaboratorName
export const MemberStatus = Team.MemberStatus
export type MemberStatus = Team.MemberStatus
export const MessageKind = Team.MessageKind
export type MessageKind = Team.MessageKind
export const Summary = Team.Summary
export type Summary = Team.Summary
export const MessageText = Team.MessageText
export type MessageText = Team.MessageText
export const ShutdownReason = Team.ShutdownReason
export type ShutdownReason = Team.ShutdownReason
export const Member = Team.Member
export type Member = Team.Member
export const Info = Team.Info
export type Info = Team.Info
export const Message = Team.Message
export type Message = Team.Message
export const Inbox = Team.Inbox
export type Inbox = Team.Inbox
export const Shutdown = Team.Shutdown
export type Shutdown = Team.Shutdown
export const Event = Team.Event

const MaximumMembers = 8
const MaximumMessages = 500
const MaximumShutdowns = 64
const PublicMessageKinds = new Set<MessageKind>(["info", "request", "result", "alert"])
const Lead = MemberName.make("lead")

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Team.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class ExistsError extends Schema.TaggedErrorClass<ExistsError>()("Team.ExistsError", {
  sessionID: SessionSchema.ID,
}) {}

export class MemberNotFoundError extends Schema.TaggedErrorClass<MemberNotFoundError>()("Team.MemberNotFoundError", {
  sessionID: SessionSchema.ID,
  member: Schema.String,
}) {}

export class MemberExistsError extends Schema.TaggedErrorClass<MemberExistsError>()("Team.MemberExistsError", {
  member: MemberName,
}) {}

export class RoleInUseError extends Schema.TaggedErrorClass<RoleInUseError>()("Team.RoleInUseError", {
  agentID: AgentV2.ID,
}) {}

export class InvalidRoleError extends Schema.TaggedErrorClass<InvalidRoleError>()("Team.InvalidRoleError", {
  agentID: AgentV2.ID,
}) {}

export class LimitError extends Schema.TaggedErrorClass<LimitError>()("Team.LimitError", {
  sessionID: SessionSchema.ID,
  limit: Schema.Int,
}) {}

export class AccessDeniedError extends Schema.TaggedErrorClass<AccessDeniedError>()("Team.AccessDeniedError", {
  actor: Schema.String,
  action: Schema.String,
}) {}

export class InvalidRecipientError extends Schema.TaggedErrorClass<InvalidRecipientError>()(
  "Team.InvalidRecipientError",
  {
    recipient: Schema.String,
    message: Schema.String,
  },
) {}

export class MemberStoppedError extends Schema.TaggedErrorClass<MemberStoppedError>()("Team.MemberStoppedError", {
  member: MemberName,
}) {}

export class InvalidStateError extends Schema.TaggedErrorClass<InvalidStateError>()("Team.InvalidStateError", {
  member: MemberName.pipe(Schema.optional),
  action: Schema.String,
  message: Schema.String,
}) {}

export class ShutdownNotFoundError extends Schema.TaggedErrorClass<ShutdownNotFoundError>()(
  "Team.ShutdownNotFoundError",
  {
    shutdownID: ShutdownID,
  },
) {}

type MutationError =
  | AccessDeniedError
  | ExistsError
  | InvalidRecipientError
  | InvalidRoleError
  | InvalidStateError
  | LimitError
  | MemberExistsError
  | MemberNotFoundError
  | MemberStoppedError
  | NotFoundError
  | RoleInUseError
  | ShutdownNotFoundError

export interface Interface {
  readonly hasTeam: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly create: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name: Name
    readonly description?: Description
  }) => Effect.Effect<Info, ExistsError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info, NotFoundError>
  readonly addMember: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name: CollaboratorName
    readonly agentID: AgentV2.ID
    readonly actor?: MemberName
  }) => Effect.Effect<
    Member,
    AccessDeniedError | InvalidRoleError | LimitError | MemberExistsError | NotFoundError | RoleInUseError
  >
  readonly resolveActor: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agentID: AgentV2.ID
  }) => Effect.Effect<MemberName, AccessDeniedError | NotFoundError>
  readonly sendMessage: (input: {
    readonly sessionID: SessionSchema.ID
    readonly recipient: string
    readonly message: MessageText
    readonly summary?: Summary
    readonly kind?: "info" | "request" | "result" | "alert"
    readonly actor?: MemberName
  }) => Effect.Effect<
    Message,
    InvalidRecipientError | MemberNotFoundError | MemberStoppedError | NotFoundError
  >
  readonly listMessages: (input: {
    readonly sessionID: SessionSchema.ID
    readonly actor?: MemberName
    readonly afterSequence?: number
    readonly limit?: number
  }) => Effect.Effect<Inbox, MemberNotFoundError | NotFoundError>
  readonly requestShutdown: (input: {
    readonly sessionID: SessionSchema.ID
    readonly member: CollaboratorName
    readonly reason?: ShutdownReason
    readonly actor?: MemberName
  }) => Effect.Effect<
    Shutdown,
    AccessDeniedError | InvalidStateError | MemberNotFoundError | MemberStoppedError | NotFoundError
  >
  readonly respondShutdown: (input: {
    readonly sessionID: SessionSchema.ID
    readonly shutdownID: ShutdownID
    readonly approve: boolean
    readonly reason?: ShutdownReason
    readonly actor: MemberName
  }) => Effect.Effect<
    Shutdown,
    AccessDeniedError | InvalidStateError | MemberNotFoundError | NotFoundError | ShutdownNotFoundError
  >
  readonly removeMember: (input: {
    readonly sessionID: SessionSchema.ID
    readonly member: CollaboratorName
    readonly actor?: MemberName
  }) => Effect.Effect<Member, AccessDeniedError | InvalidStateError | MemberNotFoundError | NotFoundError>
  readonly delete: (input: {
    readonly sessionID: SessionSchema.ID
    readonly actor?: MemberName
  }) => Effect.Effect<ID, AccessDeniedError | InvalidStateError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@arforge/v2/Team") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const agents = yield* AgentV2.Service
    const events = yield* EventV2.Service

    const hasTeam = Effect.fn("Team.hasTeam")(function* (sessionID: SessionSchema.ID) {
      return Boolean(
        yield* db
          .select({ id: TeamTable.id })
          .from(TeamTable)
          .where(eq(TeamTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      )
    })

    const get = Effect.fn("Team.get")(function* (sessionID: SessionSchema.ID) {
      const team = yield* db
        .select()
        .from(TeamTable)
        .where(eq(TeamTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!team) return yield* new NotFoundError({ sessionID })
      return yield* assembleInfo(db, team)
    })

    const create = Effect.fn("Team.create")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly name: Name
      readonly description?: Description
    }) {
      const id = ID.create()
      const now = Date.now()
      const name = Name.make(redact(input.name))
      const description = Description.make(redact(input.description ?? ""))
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existing = yield* tx
              .select({ id: TeamTable.id })
              .from(TeamTable)
              .where(eq(TeamTable.session_id, input.sessionID))
              .get()
            if (existing) return yield* new ExistsError({ sessionID: input.sessionID })
            yield* tx
              .insert(TeamTable)
              .values({ id, session_id: input.sessionID, name, description, time_created: now, time_updated: now })
              .run()
            yield* tx
              .insert(TeamMemberTable)
              .values({
                team_id: id,
                name_key: "lead",
                name: Lead,
                agent_id: AgentV2.defaultID,
                time_joined: now,
                time_updated: now,
              })
              .run()
          }),
        )
        .pipe(databaseOrDie)
      const team = yield* get(input.sessionID).pipe(Effect.orDie)
      yield* events.publish(Event.Created, { sessionID: input.sessionID, team })
      return team
    })

    const addMember = Effect.fn("Team.addMember")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly name: CollaboratorName
      readonly agentID: AgentV2.ID
      readonly actor?: MemberName
    }) {
      yield* requireLead(input.actor ?? Lead, "add member")
      const role = yield* agents.get(input.agentID)
      if (!role || role.mode !== "subagent") return yield* new InvalidRoleError({ agentID: input.agentID })
      const name = CollaboratorName.make(input.name)
      const key = name.toLowerCase()
      const now = Date.now()
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const members = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, team.id)).all()
            if (members.length - 1 >= MaximumMembers)
              return yield* new LimitError({ sessionID: input.sessionID, limit: MaximumMembers })
            if (members.some((member) => member.name_key === key))
              return yield* new MemberExistsError({ member: MemberName.make(name) })
            if (members.some((member) => member.agent_id === input.agentID))
              return yield* new RoleInUseError({ agentID: input.agentID })
            const inserted = yield* tx
              .insert(TeamMemberTable)
              .values({
                team_id: team.id,
                name_key: key,
                name: MemberName.make(name),
                agent_id: input.agentID,
                time_joined: now,
                time_updated: now,
              })
              .returning()
              .get()
            if (!inserted) return yield* Effect.die("Failed to persist team member")
            yield* touchTeam(tx, team.id)
            return inserted
          }),
        )
        .pipe(databaseOrDie)
      yield* publishUpdated(input.sessionID, get, events)
      return memberInfo(row)
    })

    const resolveActor = Effect.fn("Team.resolveActor")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly agentID: AgentV2.ID
    }) {
      const role = yield* agents.get(input.agentID)
      if (role?.mode !== "subagent") {
        if (role || input.agentID === AgentV2.defaultID) return Lead
        return yield* new AccessDeniedError({ actor: input.agentID, action: "resolve team actor" })
      }
      const team = yield* findTeamRow(db, input.sessionID)
      const member = yield* db
        .select()
        .from(TeamMemberTable)
        .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.agent_id, input.agentID)))
        .get()
        .pipe(Effect.orDie)
      if (!member)
        return yield* new AccessDeniedError({
          actor: input.agentID,
          action: "access a team without a registered member",
        })
      return member.name
    })

    const sendMessage = Effect.fn("Team.sendMessage")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly recipient: string
      readonly message: MessageText
      readonly summary?: Summary
      readonly kind?: "info" | "request" | "result" | "alert"
      readonly actor?: MemberName
    }) {
      const actor = input.actor ?? Lead
      const kind = input.kind ?? "info"
      if (!PublicMessageKinds.has(kind))
        return yield* new InvalidRecipientError({ recipient: input.recipient, message: "Invalid public message kind." })
      const message = MessageText.make(redact(input.message))
      const summary = Summary.make(redact(input.summary?.trim() || message.split(/\r?\n/, 1)[0]!.slice(0, 160)))
      const persisted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const members = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, team.id)).all()
            const sender = findMember(members, actor)
            if (!sender) return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: actor })
            if (sender.status === "stopped") return yield* new MemberStoppedError({ member: sender.name })
            let recipient = input.recipient
            let recipients: MemberName[]
            if (recipient === "*") {
              recipients = members
                .filter((member) => member.name_key !== sender.name_key && member.status !== "stopped")
                .map((member) => member.name)
            } else {
              const target = findMember(members, recipient)
              if (!target)
                return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: input.recipient })
              if (target.name_key === sender.name_key)
                return yield* new InvalidRecipientError({
                  recipient: input.recipient,
                  message: "A team member cannot send a direct message to itself.",
                })
              if (target.status === "stopped") return yield* new MemberStoppedError({ member: target.name })
              recipient = target.name
              recipients = [target.name]
            }
            return yield* appendMessage(tx, {
              team,
              sender: sender.name,
              recipient,
              recipients,
              kind,
              summary,
              message,
            })
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.MessageSent, { sessionID: input.sessionID, message: persisted })
      return persisted
    })

    const listMessages = Effect.fn("Team.listMessages")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly actor?: MemberName
      readonly afterSequence?: number
      readonly limit?: number
    }) {
      const actor = input.actor ?? Lead
      const after = Math.max(0, Math.trunc(input.afterSequence ?? 0))
      const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)))
      const team = yield* findTeamRow(db, input.sessionID)
      const members = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, team.id))
        .all()
        .pipe(Effect.orDie)
      const member = findMember(members, actor)
      if (!member) return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: actor })
      const rows = yield* db
        .select()
        .from(TeamMessageTable)
        .where(and(eq(TeamMessageTable.team_id, team.id), gt(TeamMessageTable.sequence, after)))
        .orderBy(asc(TeamMessageTable.sequence))
        .all()
        .pipe(Effect.orDie)
      const messages = rows
        .filter(
          (row) =>
            row.recipient.toLowerCase() === member.name_key ||
            (row.recipient === "*" && row.recipients.some((recipient) => recipient.toLowerCase() === member.name_key)),
        )
        .slice(0, limit)
        .map(messageInfo)
      return Inbox.make({
        teamID: team.id,
        member: member.name,
        messages,
        count: messages.length,
        lastSequence: messages.at(-1)?.sequence ?? after,
      })
    })

    const requestShutdown = Effect.fn("Team.requestShutdown")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly member: CollaboratorName
      readonly reason?: ShutdownReason
      readonly actor?: MemberName
    }) {
      yield* requireLead(input.actor ?? Lead, "request shutdown")
      const reason = ShutdownReason.make(redact(input.reason ?? ""))
      const persisted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const members = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, team.id)).all()
            const member = findMember(members, input.member)
            if (!member) return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: input.member })
            if (member.status === "stopped") return yield* new MemberStoppedError({ member: member.name })
            if (member.status === "shutdown_requested")
              return yield* new InvalidStateError({
                member: member.name,
                action: "request shutdown",
                message: "Shutdown is already pending for this member.",
              })
            const decided = yield* tx
              .select({ id: TeamShutdownTable.id })
              .from(TeamShutdownTable)
              .where(and(eq(TeamShutdownTable.team_id, team.id), ne(TeamShutdownTable.status, "pending")))
              .orderBy(asc(TeamShutdownTable.time_requested))
              .all()
            if (decided.length >= MaximumShutdowns)
              yield* tx
                .delete(TeamShutdownTable)
                .where(inArray(TeamShutdownTable.id, decided.slice(0, decided.length - MaximumShutdowns + 1).map((row) => row.id)))
                .run()
            const id = ShutdownID.create()
            const now = Date.now()
            const shutdown = yield* tx
              .insert(TeamShutdownTable)
              .values({
                id,
                team_id: team.id,
                member_key: member.name_key,
                member: member.name,
                reason,
                time_requested: now,
              })
              .returning()
              .get()
            if (!shutdown) return yield* Effect.die("Failed to persist shutdown request")
            yield* tx
              .update(TeamMemberTable)
              .set({
                status: "shutdown_requested",
                revision: member.revision + 1,
                time_updated: now,
              })
              .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.name_key, member.name_key)))
              .run()
            const message = yield* appendMessage(tx, {
              team,
              sender: Lead,
              recipient: member.name,
              recipients: [member.name],
              kind: "shutdown_request",
              summary: Summary.make(`Shutdown requested for ${member.name}`),
              message: MessageText.make(reason || "Shutdown requested."),
              shutdownID: id,
            })
            return { shutdown, message }
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.MessageSent, { sessionID: input.sessionID, message: persisted.message })
      yield* publishUpdated(input.sessionID, get, events)
      return shutdownInfo(persisted.shutdown)
    })

    const respondShutdown = Effect.fn("Team.respondShutdown")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly shutdownID: ShutdownID
      readonly approve: boolean
      readonly reason?: ShutdownReason
      readonly actor: MemberName
    }) {
      const reason = ShutdownReason.make(redact(input.reason ?? ""))
      if (!input.approve && !reason)
        return yield* new InvalidStateError({
          member: input.actor,
          action: "reject shutdown",
          message: "A rejection requires a reason.",
        })
      const persisted = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const member = yield* tx
              .select()
              .from(TeamMemberTable)
              .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.name_key, input.actor.toLowerCase())))
              .get()
            if (!member) return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: input.actor })
            const shutdown = yield* tx
              .select()
              .from(TeamShutdownTable)
              .where(and(eq(TeamShutdownTable.team_id, team.id), eq(TeamShutdownTable.id, input.shutdownID)))
              .get()
            if (!shutdown) return yield* new ShutdownNotFoundError({ shutdownID: input.shutdownID })
            if (shutdown.status !== "pending")
              return yield* new InvalidStateError({
                member: member.name,
                action: "respond to shutdown",
                message: "Shutdown request was already decided.",
              })
            if (shutdown.member_key !== member.name_key)
              return yield* new AccessDeniedError({ actor: member.name, action: "respond to another member's shutdown" })
            const now = Date.now()
            const updated = yield* tx
              .update(TeamShutdownTable)
              .set({
                status: input.approve ? "approved" : "rejected",
                response_reason: reason,
                revision: shutdown.revision + 1,
                time_responded: now,
              })
              .where(eq(TeamShutdownTable.id, shutdown.id))
              .returning()
              .get()
            if (!updated) return yield* Effect.die("Failed to persist shutdown response")
            yield* tx
              .update(TeamMemberTable)
              .set({
                status: input.approve ? "stopped" : "active",
                revision: member.revision + 1,
                time_updated: now,
              })
              .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.name_key, member.name_key)))
              .run()
            const message = yield* appendMessage(tx, {
              team,
              sender: member.name,
              recipient: Lead,
              recipients: [Lead],
              kind: "shutdown_response",
              summary: Summary.make(`Shutdown ${input.approve ? "approved" : "rejected"} by ${member.name}`),
              message: MessageText.make(reason || (input.approve ? "Shutdown approved." : "Shutdown rejected.")),
              shutdownID: shutdown.id,
              approve: input.approve,
            })
            return { shutdown: updated, message }
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.MessageSent, { sessionID: input.sessionID, message: persisted.message })
      yield* publishUpdated(input.sessionID, get, events)
      return shutdownInfo(persisted.shutdown)
    })

    const removeMember = Effect.fn("Team.removeMember")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly member: CollaboratorName
      readonly actor?: MemberName
    }) {
      yield* requireLead(input.actor ?? Lead, "remove member")
      const removed = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const member = yield* tx
              .select()
              .from(TeamMemberTable)
              .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.name_key, input.member.toLowerCase())))
              .get()
            if (!member) return yield* new MemberNotFoundError({ sessionID: input.sessionID, member: input.member })
            if (member.status !== "stopped")
              return yield* new InvalidStateError({
                member: member.name,
                action: "remove member",
                message: "Request and receive shutdown approval before removing a member.",
              })
            yield* tx
              .delete(TeamMemberTable)
              .where(and(eq(TeamMemberTable.team_id, team.id), eq(TeamMemberTable.name_key, member.name_key)))
              .run()
            yield* tx
              .delete(TeamShutdownTable)
              .where(and(eq(TeamShutdownTable.team_id, team.id), eq(TeamShutdownTable.member_key, member.name_key)))
              .run()
            yield* touchTeam(tx, team.id)
            return member
          }),
        )
        .pipe(databaseOrDie)
      yield* publishUpdated(input.sessionID, get, events)
      return memberInfo(removed)
    })

    const remove = Effect.fn("Team.delete")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly actor?: MemberName
    }) {
      yield* requireLead(input.actor ?? Lead, "delete team")
      const id = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const team = yield* findTeamRow(tx, input.sessionID)
            const active = yield* tx
              .select({ name: TeamMemberTable.name })
              .from(TeamMemberTable)
              .where(
                and(
                  eq(TeamMemberTable.team_id, team.id),
                  ne(TeamMemberTable.name_key, "lead"),
                  ne(TeamMemberTable.status, "stopped"),
                ),
              )
              .all()
            if (active.length)
              return yield* new InvalidStateError({
                action: "delete team",
                message: `Active members remain: ${active.map((member) => member.name).join(", ")}`,
              })
            yield* tx.delete(TeamTable).where(eq(TeamTable.id, team.id)).run()
            return team.id
          }),
        )
        .pipe(databaseOrDie)
      yield* events.publish(Event.Deleted, { sessionID: input.sessionID, teamID: id })
      return id
    })

    return Service.of({
      hasTeam,
      create,
      get,
      addMember,
      resolveActor,
      sendMessage,
      listMessages,
      requestShutdown,
      respondShutdown,
      removeMember,
      delete: remove,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, AgentV2.node, EventV2.node],
})

function requireLead(actor: MemberName, action: string) {
  return actor.toLowerCase() === "lead"
    ? Effect.void
    : new AccessDeniedError({ actor, action })
}

function findTeamRow(
  db: Pick<Database.Interface["db"], "select">,
  sessionID: SessionSchema.ID,
) {
  return db
    .select()
    .from(TeamTable)
    .where(eq(TeamTable.session_id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.flatMap((team) => (team ? Effect.succeed(team) : new NotFoundError({ sessionID }))),
    )
}

function findMember(rows: ReadonlyArray<typeof TeamMemberTable.$inferSelect>, name: string) {
  const key = name.toLowerCase()
  return rows.find((member) => member.name_key === key)
}

function touchTeam(db: Pick<Database.Interface["db"], "update">, teamID: ID) {
  return db
    .update(TeamTable)
    .set({
      revision: sql`${TeamTable.revision} + 1`,
      time_updated: Date.now(),
    })
    .where(eq(TeamTable.id, teamID))
    .run()
}

function appendMessage(
  db: Pick<Database.Interface["db"], "delete" | "insert" | "select" | "update">,
  input: {
    readonly team: typeof TeamTable.$inferSelect
    readonly sender: MemberName
    readonly recipient: string
    readonly recipients: ReadonlyArray<MemberName>
    readonly kind: MessageKind
    readonly summary: Summary
    readonly message: MessageText
    readonly shutdownID?: ShutdownID
    readonly approve?: boolean
  },
) {
  return Effect.gen(function* () {
    const next = yield* db
      .update(TeamTable)
      .set({
        next_sequence: sql`${TeamTable.next_sequence} + 1`,
        revision: sql`${TeamTable.revision} + 1`,
        time_updated: Date.now(),
      })
      .where(eq(TeamTable.id, input.team.id))
      .returning({ nextSequence: TeamTable.next_sequence })
      .get()
    if (!next) return yield* Effect.die("Failed to reserve team message sequence")
    const sequence = next.nextSequence - 1
    const row = yield* db
      .insert(TeamMessageTable)
      .values({
        id: MessageID.create(),
        team_id: input.team.id,
        sequence,
        sender: input.sender,
        recipient: input.recipient,
        recipients: input.recipients,
        kind: input.kind,
        summary: input.summary,
        message: input.message,
        shutdown_id: input.shutdownID,
        approve: input.approve,
      })
      .returning()
      .get()
    if (!row) return yield* Effect.die("Failed to persist team message")
    const messages = yield* db
      .select({ id: TeamMessageTable.id })
      .from(TeamMessageTable)
      .where(eq(TeamMessageTable.team_id, input.team.id))
      .orderBy(asc(TeamMessageTable.sequence))
      .all()
    const excess = messages.slice(0, Math.max(0, messages.length - MaximumMessages))
    if (excess.length)
      yield* db.delete(TeamMessageTable).where(inArray(TeamMessageTable.id, excess.map((message) => message.id))).run()
    return messageInfo(row)
  })
}

function assembleInfo(db: Database.Interface["db"], row: typeof TeamTable.$inferSelect) {
  return Effect.gen(function* () {
    const [members, messages, shutdowns] = yield* Effect.all([
      db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.team_id, row.id))
        .orderBy(asc(TeamMemberTable.name_key))
        .all()
        .pipe(Effect.orDie),
      db
        .select({ id: TeamMessageTable.id })
        .from(TeamMessageTable)
        .where(eq(TeamMessageTable.team_id, row.id))
        .all()
        .pipe(Effect.orDie),
      db
        .select({ status: TeamShutdownTable.status })
        .from(TeamShutdownTable)
        .where(eq(TeamShutdownTable.team_id, row.id))
        .all()
        .pipe(Effect.orDie),
    ])
    const ordered = members.sort((left, right) => {
      if (left.name_key === "lead") return -1
      if (right.name_key === "lead") return 1
      return left.name_key.localeCompare(right.name_key)
    })
    return Info.make({
      id: row.id,
      sessionID: row.session_id,
      name: row.name,
      description: row.description,
      revision: row.revision,
      nextSequence: row.next_sequence,
      members: ordered.map(memberInfo),
      memberCount: Math.max(0, ordered.length - 1),
      messageCount: messages.length,
      pendingShutdowns: shutdowns.filter((shutdown) => shutdown.status === "pending").length,
      time: {
        created: DateTime.makeUnsafe(row.time_created),
        updated: DateTime.makeUnsafe(row.time_updated),
      },
    })
  })
}

function memberInfo(row: typeof TeamMemberTable.$inferSelect) {
  return Member.make({
    name: row.name,
    agentID: row.agent_id,
    status: row.status,
    revision: row.revision,
    time: {
      joined: DateTime.makeUnsafe(row.time_joined),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  })
}

function messageInfo(row: typeof TeamMessageTable.$inferSelect) {
  return Message.make({
    id: row.id,
    teamID: row.team_id,
    sequence: row.sequence,
    sender: row.sender,
    recipient: row.recipient,
    recipients: row.recipients,
    kind: row.kind,
    summary: row.summary,
    message: row.message,
    shutdownID: row.shutdown_id ?? undefined,
    approve: row.approve ?? undefined,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  })
}

function shutdownInfo(row: typeof TeamShutdownTable.$inferSelect) {
  return Shutdown.make({
    id: row.id,
    teamID: row.team_id,
    member: row.member,
    status: row.status,
    reason: row.reason,
    responseReason: row.response_reason,
    revision: row.revision,
    time: {
      requested: DateTime.makeUnsafe(row.time_requested),
      responded: row.time_responded === null ? undefined : DateTime.makeUnsafe(row.time_responded),
    },
  })
}

function publishUpdated(
  sessionID: SessionSchema.ID,
  get: (sessionID: SessionSchema.ID) => Effect.Effect<Info, NotFoundError>,
  events: EventV2.Interface,
) {
  return get(sessionID).pipe(
    Effect.flatMap((team) => events.publish(Event.Updated, { sessionID, team })),
  )
}

function redact(value: string) {
  return value
    .trim()
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]")
}

type DomainError = MutationError

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  return typeof error === "object" && error !== null && "_tag" in error && String(error._tag).startsWith("Team.")
}
