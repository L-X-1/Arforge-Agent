export * as SessionOrganization from "./organization"

import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { SessionOrganization as Contract } from "@arforge-ai/schema/session-organization"
import { Database } from "../database/database"
import { NonNegativeInt } from "../schema"
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

export const previewRewind = Effect.fn("SessionOrganization.previewRewind")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly checkpointID: CheckpointID
}) {
  const { db } = yield* Database.Service
  const checkpoint = yield* findCheckpoint(db, input)
  const later = yield* db
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
    .pipe(Effect.orDie)
  const latest = yield* latestVisible(db, input.sessionID).pipe(Effect.orDie)
  return Contract.RewindPreview.make({
    checkpoint: checkpointFromRow(checkpoint),
    affectedMessages: later.length,
    expectedLastSequence: latest?.sequence ?? 0,
    workspaceEffectsUnchanged: true,
  })
})

export const applyRewind = Effect.fn("SessionOrganization.applyRewind")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly checkpointID: CheckpointID
  readonly expectedLastSequence: number
}) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        const checkpoint = yield* findCheckpoint(tx, input)
        const latest = yield* latestVisible(tx, input.sessionID).pipe(Effect.orDie)
        const actual = latest?.sequence ?? 0
        if (actual !== input.expectedLastSequence)
          return yield* new StaleRewindError({
            checkpointID: input.checkpointID,
            expectedLastSequence: input.expectedLastSequence,
            actualLastSequence: actual,
          })
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
              or(
                gt(SessionInputTable.admitted_seq, checkpoint.sequence),
                gt(SessionInputTable.promoted_seq, checkpoint.sequence),
              ),
            ),
          )
          .run()
        yield* tx
          .update(SessionTable)
          .set({ revert: null, time_updated: Date.now() })
          .where(eq(SessionTable.id, input.sessionID))
          .run()
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

type DomainError = CheckpointNotFoundError | StaleRewindError

function databaseOrDie<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, Extract<E, DomainError>, R> {
  return effect.pipe(
    Effect.catch((error) => (isDomainError(error) ? Effect.fail(error) : Effect.die(error))),
  ) as Effect.Effect<A, Extract<E, DomainError>, R>
}

function isDomainError(error: unknown): error is DomainError {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false
  return error._tag === "Session.CheckpointNotFoundError" || error._tag === "Session.StaleRewindError"
}
