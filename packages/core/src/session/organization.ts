export * as SessionOrganization from "./organization"

import { and, asc, desc, eq, gt, isNull, isNotNull, or } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import path from "node:path"
import { SessionOrganization as Contract } from "@arforge-ai/schema/session-organization"
import { Database } from "../database/database"
import { NonNegativeInt } from "../schema"
import { Location } from "../location"
import { canonicalHash } from "../util/canonical-hash"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import {
  SessionCheckpointTable,
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
  SessionTagTable,
} from "./sql"

export const Tag = Contract.Tag
export type Tag = Contract.Tag
export const Tags = Contract.Tags
export type Tags = Contract.Tags
export const CheckpointID = Contract.CheckpointID
export type CheckpointID = Contract.CheckpointID
export const CheckpointLabel = Contract.CheckpointLabel
export type CheckpointLabel = Contract.CheckpointLabel
export const Checkpoint = Contract.Checkpoint
export type Checkpoint = Contract.Checkpoint
export const RewindPreview = Contract.RewindPreview
export type RewindPreview = Contract.RewindPreview
export const RewindResult = Contract.RewindResult
export type RewindResult = Contract.RewindResult

export class InvalidTagsError extends Schema.TaggedErrorClass<InvalidTagsError>()("Session.InvalidTagsError", {
  message: Schema.String,
}) {}

export class CheckpointNotFoundError extends Schema.TaggedErrorClass<CheckpointNotFoundError>()(
  "Session.CheckpointNotFoundError",
  {
    sessionID: SessionSchema.ID,
    checkpointID: CheckpointID,
  },
) {}

export class StaleRewindError extends Schema.TaggedErrorClass<StaleRewindError>()("Session.StaleRewindError", {
  checkpointID: CheckpointID,
  expectedLastSequence: NonNegativeInt,
  actualLastSequence: NonNegativeInt,
}) {}

export class RewindMessageNotFoundError extends Schema.TaggedErrorClass<RewindMessageNotFoundError>()("Session.RewindMessageNotFoundError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export class RewindConflictError extends Schema.TaggedErrorClass<RewindConflictError>()("Session.RewindConflictError", {
  sessionID: SessionSchema.ID,
  message: Schema.String,
}) {}

const normalizeTag = (tag: Tag) => tag.normalize("NFKC").toLocaleLowerCase("en-US")

export const listTags = Effect.fn("SessionOrganization.listTags")(function* (sessionID: SessionSchema.ID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ value: SessionTagTable.value })
    .from(SessionTagTable)
    .where(eq(SessionTagTable.session_id, sessionID))
    .orderBy(asc(SessionTagTable.position))
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => Contract.Tag.make(row.value))
})

export const updateTags = Effect.fn("SessionOrganization.updateTags")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly tags: Tags
}) {
  const { db } = yield* Database.Service
  const normalized = input.tags.map((value, position) => ({
    value,
    position,
    normalized: normalizeTag(value),
  }))
  if (new Set(normalized.map((item) => item.normalized)).size !== normalized.length)
    return yield* new InvalidTagsError({ message: "Session tags must be unique ignoring case." })

  yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.delete(SessionTagTable).where(eq(SessionTagTable.session_id, input.sessionID)).run()
        if (normalized.length)
          yield* tx
            .insert(SessionTagTable)
            .values(normalized.map((item) => ({ ...item, session_id: input.sessionID })))
            .run()
        yield* tx
          .update(SessionTable)
          .set({ time_updated: Date.now() })
          .where(eq(SessionTable.id, input.sessionID))
          .run()
      }),
    )
    .pipe(Effect.orDie)
  return input.tags
})

const checkpointFromRow = (row: typeof SessionCheckpointTable.$inferSelect): Checkpoint =>
  Contract.Checkpoint.make({
    id: Contract.CheckpointID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    label: Contract.CheckpointLabel.make(row.label),
    sequence: row.sequence,
    messageID: row.message_id ? SessionMessage.ID.make(row.message_id) : undefined,
    time: { created: DateTime.makeUnsafe(row.time_created) },
  })

type QueryDatabase = Pick<Database.Interface["db"], "select">

const latestVisible = (db: QueryDatabase, sessionID: SessionSchema.ID) =>
  db
    .select({ id: SessionMessageTable.id, sequence: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), isNull(SessionMessageTable.time_rewound)))
    .orderBy(desc(SessionMessageTable.seq))
    .get()

export const createCheckpoint = Effect.fn("SessionOrganization.createCheckpoint")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly label: CheckpointLabel
}) {
  const { db } = yield* Database.Service
  const latest = yield* latestVisible(db, input.sessionID).pipe(Effect.orDie)
  const row = yield* db
    .insert(SessionCheckpointTable)
    .values({
      id: Contract.CheckpointID.create(),
      session_id: input.sessionID,
      label: input.label,
      sequence: latest?.sequence ?? 0,
      message_id: latest?.id,
    })
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* Effect.die("Failed to persist session checkpoint")
  return checkpointFromRow(row)
})

export const listCheckpoints = Effect.fn("SessionOrganization.listCheckpoints")(function* (
  sessionID: SessionSchema.ID,
) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionCheckpointTable)
    .where(eq(SessionCheckpointTable.session_id, sessionID))
    .orderBy(desc(SessionCheckpointTable.time_created), desc(SessionCheckpointTable.id))
    .all()
    .pipe(Effect.orDie)
  return rows.map(checkpointFromRow)
})

const findCheckpoint = Effect.fn("SessionOrganization.findCheckpoint")(function* (
  db: QueryDatabase,
  input: { readonly sessionID: SessionSchema.ID; readonly checkpointID: CheckpointID },
) {
  const row = yield* db
    .select()
    .from(SessionCheckpointTable)
    .where(
      and(eq(SessionCheckpointTable.id, input.checkpointID), eq(SessionCheckpointTable.session_id, input.sessionID)),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new CheckpointNotFoundError(input)
  return row
})

type RewindRequest = { readonly sessionID: SessionSchema.ID } & Contract.RewindTarget
const conflict = (sessionID: SessionSchema.ID) => new RewindConflictError({ sessionID, message: "The conversation or its source changed. Preview the rewind again before retrying." })

/** All preview reads and apply validation use the same owned database snapshot. */
const rewindState = Effect.fn("SessionOrganization.rewindState")(function* (db: QueryDatabase, input: RewindRequest) {
  if ((input.messageID !== undefined) === (input.checkpointID !== undefined) || (input.messageID !== undefined && input.expectedDirectory === undefined)) return yield* conflict(input.sessionID)
  const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
  const session = yield* db.select().from(SessionTable).where(and(
    eq(SessionTable.id, input.sessionID), eq(SessionTable.tenant_id, principal.tenantID), eq(SessionTable.owner_user_id, principal.userID),
  )).get().pipe(Effect.orDie)
  if (!session) return yield* conflict(input.sessionID)
  const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
  if ((location && (path.resolve(location.directory) !== path.resolve(session.directory) || (location.workspaceID ?? null) !== session.workspace_id)) ||
    (input.expectedDirectory !== undefined && path.resolve(input.expectedDirectory) !== path.resolve(session.directory))) return yield* conflict(input.sessionID)
  const messages = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.tenant_id, principal.tenantID), eq(SessionMessageTable.owner_user_id, principal.userID),
  )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  const inputs = yield* db.select().from(SessionInputTable).where(and(
    eq(SessionInputTable.session_id, input.sessionID), eq(SessionInputTable.tenant_id, principal.tenantID), eq(SessionInputTable.owner_user_id, principal.userID),
  )).orderBy(asc(SessionInputTable.admitted_seq)).all().pipe(Effect.orDie)
  const visible = messages.filter(row => row.time_rewound === null)
  let checkpoint: typeof SessionCheckpointTable.$inferSelect
  if (input.messageID !== undefined) {
    const target = visible.find(row => row.id === input.messageID && row.type === "user")
    const original = inputs.find(row => row.id === input.messageID)
    if (!target || !original || original.promoted_seq !== target.seq) return yield* new RewindMessageNotFoundError({ sessionID: input.sessionID, messageID: input.messageID })
    const previous = visible.filter(row => row.seq < target.seq).at(-1)
    const sequence = previous?.seq ?? 0
    // A planned checkpoint is deterministic but is not persisted by preview/cancel.
    checkpoint = {
      tenant_id: principal.tenantID, owner_user_id: principal.userID,
      id: Contract.CheckpointID.make(`chk_${canonicalHash({ sessionID: input.sessionID, messageID: input.messageID, sequence, directory: session.directory, workspaceID: session.workspace_id, principal })}`),
      session_id: input.sessionID, label: Contract.CheckpointLabel.make("Before regenerated prompt"),
      sequence, message_id: previous?.id ?? null, time_created: Date.now(),
    }
  } else {
    checkpoint = yield* findCheckpoint(db, { sessionID: input.sessionID, checkpointID: input.checkpointID! })
    if (checkpoint.tenant_id !== principal.tenantID || checkpoint.owner_user_id !== principal.userID) return yield* conflict(input.sessionID)
  }
  const revision = canonicalHash({
    session: { id: session.id, directory: session.directory, workspaceID: session.workspace_id, projectID: session.project_id, tenantID: session.tenant_id, ownerID: session.owner_user_id, updated: session.time_updated },
    checkpoint: { id: checkpoint.id, sequence: checkpoint.sequence, messageID: checkpoint.message_id }, messages, inputs,
  })!
  return { checkpoint, visible, revision, session }
})

export const previewRewind = Effect.fn("SessionOrganization.previewRewind")(function* (input: RewindRequest) {
  const { db } = yield* Database.Service
  return yield* db.transaction(tx => Effect.gen(function* () {
    const state = yield* rewindState(tx, input)
    return Contract.RewindPreview.make({
      checkpoint: checkpointFromRow(state.checkpoint),
      affectedMessages: state.visible.filter(row => row.seq > state.checkpoint.sequence).length,
      expectedLastSequence: state.visible.at(-1)?.seq ?? 0,
      expectedRevision: state.revision,
      workspaceEffectsUnchanged: true,
    })
  })).pipe(databaseOrDie)
})

export const applyRewind = Effect.fn("SessionOrganization.applyRewind")(function* (input: { readonly sessionID: SessionSchema.ID } & Contract.RewindApplyInput) {
  const { db } = yield* Database.Service
  if (input.messageID !== undefined && input.expectedRevision === undefined) return yield* conflict(input.sessionID)
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const state = yield* rewindState(tx, input)
        const checkpoint = state.checkpoint
        const actual = state.visible.at(-1)?.seq ?? 0
        if (actual !== input.expectedLastSequence)
          return yield* new StaleRewindError({
            checkpointID: checkpoint.id,
            expectedLastSequence: input.expectedLastSequence,
            actualLastSequence: actual,
          })
        if (input.expectedRevision !== undefined && input.expectedRevision !== state.revision) return yield* conflict(input.sessionID)
        if (input.messageID !== undefined) {
          const created = yield* tx.insert(SessionCheckpointTable).values(checkpoint).onConflictDoNothing().returning().get()
          if (!created) return yield* conflict(input.sessionID)
        }
        const later = yield* tx
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              isNull(SessionMessageTable.time_rewound),
              gt(SessionMessageTable.seq, checkpoint.sequence),
            ),
          )
          .all()
        if (later.length)
          yield* tx
            .update(SessionMessageTable)
            .set({ time_rewound: Date.now() })
            .where(
              and(
                eq(SessionMessageTable.session_id, input.sessionID),
                isNull(SessionMessageTable.time_rewound),
                gt(SessionMessageTable.seq, checkpoint.sequence),
              ),
            )
            .run()
        yield* tx
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, input.sessionID),
              input.messageID !== undefined ? and(isNotNull(SessionInputTable.promoted_seq), gt(SessionInputTable.promoted_seq, checkpoint.sequence)) : or(
                gt(SessionInputTable.admitted_seq, checkpoint.sequence),
                gt(SessionInputTable.promoted_seq, checkpoint.sequence),
              ),
            ),
          )
          .run()
        const settled = yield* tx
          .update(SessionTable)
          .set({ revert: null, time_updated: Date.now() })
          .where(and(
            eq(SessionTable.id, input.sessionID), eq(SessionTable.tenant_id, state.session.tenant_id), eq(SessionTable.owner_user_id, state.session.owner_user_id),
            eq(SessionTable.directory, state.session.directory), eq(SessionTable.project_id, state.session.project_id),
            state.session.workspace_id === null ? isNull(SessionTable.workspace_id) : eq(SessionTable.workspace_id, state.session.workspace_id),
            eq(SessionTable.time_updated, state.session.time_updated),
          ))
          .returning({ id: SessionTable.id }).get()
        if (!settled) return yield* conflict(input.sessionID)
        yield* tx
          .delete(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, input.sessionID))
          .run()
        return Contract.RewindResult.make({
          checkpoint: checkpointFromRow(checkpoint),
          rewoundMessages: later.length,
          lastSequence: checkpoint.sequence,
          workspaceEffectsUnchanged: true,
        })
      }),
    )
    .pipe(databaseOrDie)
})

type DomainError = CheckpointNotFoundError | StaleRewindError | RewindMessageNotFoundError | RewindConflictError

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return error._tag === "Session.CheckpointNotFoundError" || error._tag === "Session.StaleRewindError" || error._tag === "Session.RewindMessageNotFoundError" || error._tag === "Session.RewindConflictError"
}
