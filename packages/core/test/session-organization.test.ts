import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Project } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionV2 } from "@arforge-ai/core/session"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionHistory } from "@arforge-ai/core/session/history"
import { SessionOrganization } from "@arforge-ai/core/session/organization"
import { SessionMessageTable, SessionTable } from "@arforge-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sessionID = SessionV2.ID.make("ses_organization_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "organization",
      directory: "/project",
      title: "organization",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const addMessage = Effect.fn(function* (sequence: number, text: string) {
  const { db } = yield* Database.Service
  const id = SessionMessage.ID.create()
  yield* db
    .insert(SessionMessageTable)
    .values({
      id,
      session_id: sessionID,
      type: "user",
      seq: sequence,
      data: {
        text,
        files: [],
        agents: [],
        time: { created: Date.now() },
      } as typeof SessionMessageTable.$inferInsert.data,
    })
    .run()
    .pipe(Effect.orDie)
  return id
})

describe("SessionOrganization", () => {
  it.effect("stores ordered tags and rejects case-insensitive duplicates atomically", () =>
    Effect.gen(function* () {
      yield* setup
      const tags = SessionOrganization.Tags.make([
        SessionOrganization.Tag.make("Backend"),
        SessionOrganization.Tag.make("release"),
      ])

      expect(yield* SessionOrganization.updateTags({ sessionID, tags })).toEqual(tags)
      expect(yield* SessionOrganization.listTags(sessionID)).toEqual([...tags])

      const error = yield* Effect.flip(
        SessionOrganization.updateTags({
          sessionID,
          tags: SessionOrganization.Tags.make([
            SessionOrganization.Tag.make("Backend"),
            SessionOrganization.Tag.make("backend"),
          ]),
        }),
      )
      expect(error).toMatchObject({
        _tag: "Session.InvalidTagsError",
        message: "Session tags must be unique ignoring case.",
      })
      expect(yield* SessionOrganization.listTags(sessionID)).toEqual([...tags])
    }),
  )

  it.effect("uses a stale-safe preview and archives later messages without deleting them", () =>
    Effect.gen(function* () {
      yield* setup
      yield* addMessage(1, "keep")
      const checkpoint = yield* SessionOrganization.createCheckpoint({
        sessionID,
        label: SessionOrganization.CheckpointLabel.make("Before experiment"),
      })
      yield* addMessage(2, "rewind one")

      const preview = yield* SessionOrganization.previewRewind({
        sessionID,
        checkpointID: checkpoint.id,
      })
      expect(preview).toMatchObject({
        affectedMessages: 1,
        expectedLastSequence: 2,
        workspaceEffectsUnchanged: true,
      })

      yield* addMessage(3, "rewind two")
      const stale = yield* Effect.flip(
        SessionOrganization.applyRewind({
          sessionID,
          checkpointID: checkpoint.id,
          expectedLastSequence: preview.expectedLastSequence,
        }),
      )
      expect(stale).toMatchObject({
        _tag: "Session.StaleRewindError",
        expectedLastSequence: 2,
        actualLastSequence: 3,
      })

      const current = yield* SessionOrganization.previewRewind({
        sessionID,
        checkpointID: checkpoint.id,
      })
      const result = yield* SessionOrganization.applyRewind({
        sessionID,
        checkpointID: checkpoint.id,
        expectedLastSequence: current.expectedLastSequence,
      })
      expect(result).toMatchObject({
        rewoundMessages: 2,
        lastSequence: 1,
        workspaceEffectsUnchanged: true,
      })

      const { db } = yield* Database.Service
      const rows = yield* db
        .select({ sequence: SessionMessageTable.seq, rewound: SessionMessageTable.time_rewound })
        .from(SessionMessageTable)
        .orderBy(SessionMessageTable.seq)
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(3)
      expect(rows[0]).toEqual({ sequence: 1, rewound: null })
      expect(rows.slice(1).every((row) => typeof row.rewound === "number")).toBe(true)
      expect((yield* SessionHistory.load(db, sessionID)).map((message) => message.id)).toEqual([
        checkpoint.messageID!,
      ])
      expect(
        (
          yield* SessionOrganization.previewRewind({
            sessionID,
            checkpointID: checkpoint.id,
          })
        ).affectedMessages,
      ).toBe(0)
    }),
  )
})
