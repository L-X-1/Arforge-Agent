import { expect, test } from "bun:test"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { ModelV2 } from "@arforge-ai/core/model"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { ProviderV2 } from "@arforge-ai/core/provider"
import { VariantID } from "@arforge-ai/schema/model"
import { AbsolutePath, RelativePath } from "@arforge-ai/core/schema"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionProjector } from "@arforge-ai/core/session/projector"
import { Prompt } from "@arforge-ai/core/session/prompt"
import {
  MessageTable,
  PartTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@arforge-ai/core/session/sql"
import { SessionV1 } from "@arforge-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit, Schema } from "effect"
import path from "node:path"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { readSession } from "@/session/revert-readonly-local"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"

type DB = Database.Interface["db"]
const model = {
  id: ModelV2.ID.make("image-model"),
  providerID: ProviderV2.ID.make("owned-loopback"),
  variant: VariantID.make("pinned"),
}
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const tree = "a".repeat(40)
const prompt = Prompt.make({
  text: "exact source image",
  files: [
    {
      uri: "data:image/png;base64,owned",
      mime: "image/png",
      name: "owned.png",
      source: { text: "@owned.png", start: 0, end: 10 },
    },
  ],
  route: { agent: "build", model },
  system: { text: "only this turn", source: "request", scope: "turn" },
})

function fixture<A, E>(
  body: (input: {
    db: DB
    events: EventV2.Interface
    sessionID: SessionID
    directory: string
    read: (id: string, partID?: string) => ReturnType<typeof readSession>
    admit: (id: string) => Effect.Effect<void>
  }) => Effect.Effect<A, E>,
) {
  return async () => {
    await using directory = await tmpdir()
    const sessionID = SessionID.descending("ses_readonly_canonical")
    const projectID = ProjectV2.ID.make("project_readonly_canonical")
    const context: InstanceContext = {
      directory: directory.path,
      worktree: directory.path,
      project: { id: projectID, worktree: directory.path, time: { created: 1, updated: 1 }, sandboxes: [] },
    }
    const runtime = LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(":memory:")],
    ])
    return Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: AbsolutePath.make(directory.path), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values(
            Session.toRow({
              id: sessionID,
              projectID,
              directory: directory.path,
              slug: "canonical",
              title: "canonical",
              version: "test",
              cost: 0,
              tokens,
              time: { created: 1, updated: 1 },
            }),
          )
          .run()
        const read = (id: string, partID?: string) =>
          readSession(db, {
            requestID: "cpr_readonly_canonical",
            kind: "revert",
            sessionID,
            messageID: MessageID.make(id),
            ...(partID === undefined ? {} : { partID: PartID.make(partID) }),
          })
        const admit = (id: string) =>
          Effect.gen(function* () {
            yield* SessionInput.admit(db, events, {
              id: SessionMessage.ID.make(id),
              sessionID,
              prompt,
              delivery: "queue",
            })
            yield* SessionInput.promoteNextQueued(db, events, sessionID, SessionMessage.ID.make(id))
          })
        return yield* body({ db, events, sessionID, directory: directory.path, read, admit })
      }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(runtime), Effect.scoped),
    )
  }
}

const state = (db: DB) =>
  Effect.gen(function* () {
    return {
      sessions: yield* db.select().from(SessionTable).all(),
      canonical: yield* db.select().from(SessionMessageTable).all(),
      inputs: yield* db.select().from(SessionInputTable).all(),
      legacy: yield* db.select().from(MessageTable).all(),
      parts: yield* db.select().from(PartTable).all(),
      events: yield* db.select().from(EventTable).all(),
      sequence: yield* db.select().from(EventSequenceTable).all(),
    }
  })

const legacyUser = (id: string, sessionID: SessionID) => {
  const user = structuredClone(
    Schema.decodeUnknownSync(SessionV1.User)({
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: model.providerID, modelID: model.id },
    }),
  ) as SessionV1.User
  const { id: _id, sessionID: _sessionID, ...data } = user
  return { id: MessageID.make(id), session_id: sessionID, time_created: 1, data }
}
const legacyText = (id: string, messageID: string, sessionID: SessionID) => {
  const {
    id: _id,
    messageID: _messageID,
    sessionID: _sessionID,
    ...data
  } = Schema.decodeUnknownSync(SessionV1.TextPart)({ id, sessionID, messageID, type: "text", text: "legacy boundary" })
  return { id: PartID.make(id), session_id: sessionID, message_id: MessageID.make(messageID), data }
}

test(
  "real canonical admission/promotion is a read-only revert boundary with exact input/media and no legacy writes",
  fixture(({ db, sessionID, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_canonical_user")
      const before = yield* state(db)
      expect(before.legacy).toEqual([])
      expect(before.parts).toEqual([])
      expect(before.inputs).toHaveLength(1)
      expect(before.inputs[0]!.prompt).toEqual(prompt)
      const observation = yield* read("msg_canonical_user")
      expect(observation.sessionID).toBe(sessionID)
      expect(observation.target.messageID).toBe(MessageID.make("msg_canonical_user"))
      expect(observation.files).toEqual([])
      expect(observation.eventHighWaterMark).toBe(before.sequence[0]!.seq)
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "canonical snapshot files use the earliest immutable start tree and remain inside the exact source",
  fixture(({ db, events, sessionID, directory, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_canonical_files")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_canonical_answer"),
        agent: "build",
        model,
        snapshot: tree,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_canonical_answer"),
        finish: "stop",
        cost: 0,
        tokens,
        snapshot: "b".repeat(40),
        files: [RelativePath.make("src/file.txt")],
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_canonical_later_answer"),
        agent: "build",
        model,
        snapshot: "c".repeat(40),
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_canonical_later_answer"),
        finish: "stop",
        cost: 0,
        tokens,
        snapshot: "d".repeat(40),
        files: [RelativePath.make("src/file.txt")],
      })
      const before = yield* state(db)
      const observation = yield* read("msg_canonical_files")
      const expectedPath = path.resolve(directory, "src/file.txt")
      expect(observation.files).toEqual([
        {
          path: process.platform === "win32" ? expectedPath.toLowerCase() : expectedPath,
          relativePath: "src/file.txt",
          gitPath: "src/file.txt",
          targetRevision: { kind: "snapshot", id: tree },
        },
      ])
      expect(observation.targetRevisions).toEqual([{ kind: "snapshot", id: tree }])
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "legacy immutable patch/file plans remain unchanged",
  fixture(({ db, sessionID, directory, read }) =>
    Effect.gen(function* () {
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 9 }).run()
      yield* db
        .insert(MessageTable)
        .values([legacyUser("msg_legacy_a", sessionID), { ...legacyUser("msg_legacy_b", sessionID), time_created: 2 }])
        .run()
      yield* db
        .insert(PartTable)
        .values(legacyText("prt_legacy_a", "msg_legacy_a", sessionID))
        .run()
      const file = path.resolve(directory, "src/file.txt")
      const part = structuredClone(
        Schema.decodeUnknownSync(SessionV1.PatchPart)({
          id: "prt_legacy_patch",
          sessionID,
          messageID: "msg_legacy_b",
          type: "patch",
          hash: tree,
          files: [file],
        }),
      ) as SessionV1.PatchPart
      const { id, messageID, sessionID: _sessionID, ...data } = part
      yield* db.insert(PartTable).values({ id, message_id: messageID, session_id: sessionID, data }).run()
      const before = yield* state(db)
      expect((yield* read("msg_legacy_a")).files).toEqual([
        {
          path: process.platform === "win32" ? file.toLowerCase() : file,
          relativePath: "src/file.txt",
          gitPath: "src/file.txt",
          targetRevision: { kind: "snapshot", id: tree },
        },
      ])
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "missing, foreign, queued-only, and non-conversation canonical targets never fall back to legacy",
  fixture(({ db, events, sessionID, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_canonical_owned")
      const ownSession = (yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!
      const foreignSessionID = SessionID.descending("ses_foreign_canonical")
      yield* db
        .insert(SessionTable)
        .values({ ...ownSession, id: foreignSessionID })
        .run()
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make("msg_foreign"),
        sessionID: foreignSessionID,
        prompt,
        delivery: "queue",
      })
      yield* SessionInput.promoteNextQueued(db, events, foreignSessionID, SessionMessage.ID.make("msg_foreign"))
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make("msg_pending_only"),
        sessionID,
        prompt,
        delivery: "queue",
      })
      for (const id of ["msg_missing", "msg_foreign", "msg_pending_only"]) {
        const result = yield* Effect.flip(read(id))
        expect(result.reason).toBe("target_not_found")
      }
      const modelRow = (yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.type, "model-switched"))
        .get())!
      expect((yield* Effect.flip(read(modelRow.id))).reason).toBe("unsupported_operation")
      expect((yield* Effect.flip(read("msg_canonical_owned", "prt_invented"))).reason).toBe("unsupported_operation")
    }),
  ),
)

test(
  "canonical snapshots reject escaping or incomplete file evidence and source/owner mismatches",
  fixture(({ db, events, sessionID, directory, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_snapshot_negative")
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_snapshot_negative_answer"),
        agent: "build",
        model,
        snapshot: tree,
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID: SessionMessage.ID.make("msg_snapshot_negative_answer"),
        finish: "stop",
        cost: 0,
        tokens,
        snapshot: "b".repeat(40),
        files: [RelativePath.make("src/safe.txt")],
      })
      const answer = (yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_snapshot_negative_answer")))
        .get())!
      for (const snapshot of [
        { start: tree, end: "b".repeat(40), files: ["../foreign.txt"] },
        { start: tree, end: "b".repeat(40), files: [path.resolve(directory, "absolute.txt")] },
        { end: "b".repeat(40), files: ["src/safe.txt"] },
        { start: tree, end: "b".repeat(40) },
      ]) {
        const data = { ...answer.data, snapshot }
        yield* db.update(SessionMessageTable).set({ data }).where(eq(SessionMessageTable.id, answer.id)).run()
        const result = yield* Effect.flip(read("msg_snapshot_negative"))
        expect(["session_scope_mismatch", "source_revision_unavailable"]).toContain(result.reason)
      }
      yield* db
        .update(SessionMessageTable)
        .set({ data: answer.data })
        .where(eq(SessionMessageTable.id, answer.id))
        .run()
      const before = yield* state(db)
      const scoped = yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const capture = () =>
              readSession(tx, {
                requestID: "cpr_foreign_source",
                kind: "revert",
                sessionID,
                messageID: MessageID.make("msg_snapshot_negative"),
              })
            yield* tx
              .update(SessionTable)
              .set({ directory: path.join(directory, "foreign") })
              .where(eq(SessionTable.id, sessionID))
              .run()
            expect((yield* Effect.flip(capture())).reason).toBe("session_scope_mismatch")
            yield* tx.update(SessionTable).set({ directory }).where(eq(SessionTable.id, sessionID)).run()
            yield* tx
              .update(SessionMessageTable)
              .set({ owner_user_id: "usr_foreign" })
              .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_snapshot_negative")))
              .run()
            expect((yield* Effect.flip(capture())).reason).toBe("session_scope_mismatch")
            return yield* Effect.fail("rollback fixture mutations")
          }),
        ),
      )
      expect(Exit.isFailure(scoped)).toBe(true)
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "canonical queue/source mutations change the fence and a failed outer transaction rolls back without compatibility writes",
  fixture(({ db, events, sessionID, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_canonical_rollback")
      const before = yield* state(db)
      const original = yield* read("msg_canonical_rollback")
      const result = yield* Effect.exit(
        db.transaction((tx) =>
          Effect.gen(function* () {
            const data = {
              ...before.canonical.find((row) => row.id === "msg_canonical_rollback")!.data,
              text: "transaction-only text",
            }
            yield* tx
              .update(SessionMessageTable)
              .set({ data })
              .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_canonical_rollback")))
              .run()
            const changed = yield* readSession(tx, {
              requestID: "cpr_rollback",
              kind: "revert",
              sessionID,
              messageID: MessageID.make("msg_canonical_rollback"),
            })
            expect(changed.sessionRevision).not.toBe(original.sessionRevision)
            return yield* Effect.fail("rollback")
          }),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* state(db)).toEqual(before)
      expect((yield* read("msg_canonical_rollback")).sessionRevision).toBe(original.sessionRevision)
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.make("msg_queue_source"),
        sessionID,
        prompt,
        delivery: "queue",
      })
      expect((yield* read("msg_canonical_rollback")).sessionRevision).not.toBe(original.sessionRevision)
    }),
  ),
)

test(
  "pure legacy message/part boundaries remain supported and missing parts fail without writes",
  fixture(({ db, sessionID, read }) =>
    Effect.gen(function* () {
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 7 }).run()
      yield* db.insert(MessageTable).values(legacyUser("msg_legacy_boundary", sessionID)).run()
      yield* db
        .insert(PartTable)
        .values(legacyText("prt_legacy_text", "msg_legacy_boundary", sessionID))
        .run()
      const before = yield* state(db)
      expect((yield* read("msg_legacy_boundary")).target).toEqual({
        messageID: MessageID.make("msg_legacy_boundary"),
        messageSequence: 0,
      })
      expect((yield* read("msg_legacy_boundary", "prt_legacy_text")).target).toMatchObject({
        partID: "prt_legacy_text",
        partIndex: 0,
      })
      expect((yield* Effect.flip(read("msg_legacy_boundary", "prt_missing"))).reason).toBe("target_not_found")
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "explicitly rewound canonical targets never regain eligibility from retained legacy projections",
  fixture(({ db, events, sessionID, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_rewind_base")
      yield* admit("msg_rewound_dual")
      yield* db.insert(MessageTable).values(legacyUser("msg_rewound_dual", sessionID)).run()
      yield* db
        .insert(PartTable)
        .values(legacyText("prt_rewound_dual", "msg_rewound_dual", sessionID))
        .run()
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        timestamp: yield* DateTime.now,
        messageID: SessionMessage.ID.make("msg_rewind_base"),
      })
      const before = yield* state(db)
      expect(before.canonical.find((row) => row.id === "msg_rewound_dual")?.time_rewound).not.toBeNull()
      expect(before.legacy.some((row) => row.id === "msg_rewound_dual")).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(read("msg_rewound_dual")))).toBe(true)
      expect((yield* Effect.flip(read("msg_rewound_dual"))).reason).toBe("target_not_found")
      expect((yield* Effect.flip(read("msg_rewound_dual", "prt_rewound_dual"))).reason).toBe("target_not_found")
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)

test(
  "legacy part IDs keep their original boundary in a dual-projected canonical Session",
  fixture(({ db, sessionID, read, admit }) =>
    Effect.gen(function* () {
      yield* admit("msg_dual_boundary")
      yield* db.insert(MessageTable).values(legacyUser("msg_dual_boundary", sessionID)).run()
      yield* db
        .insert(PartTable)
        .values(legacyText("prt_dual_text", "msg_dual_boundary", sessionID))
        .run()
      const before = yield* state(db)
      expect((yield* read("msg_dual_boundary", "prt_dual_text")).target).toMatchObject({
        messageID: "msg_dual_boundary",
        partID: "prt_dual_text",
        partIndex: 0,
      })
      expect((yield* Effect.flip(read("msg_dual_boundary", "prt_missing"))).reason).toBe("target_not_found")
      expect(yield* state(db)).toEqual(before)
    }),
  ),
)
