import { expect, test } from "bun:test"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Database } from "@arforge-ai/core/database/database"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import { ProjectV2 } from "@arforge-ai/core/project"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionShareOperationReceiptTable } from "@arforge-ai/core/share/sql"
import { Effect, Layer } from "effect"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Service, node } from "@/share/readonly-local"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { tmpdir } from "../fixture/fixture"

test("local share exporter captures a consistent DB/Event snapshot without provider or write side effects", async () => {
  await using project = await tmpdir()
  const projectID = ProjectV2.ID.make("project_share_readonly_local")
  const sessionID = SessionID.descending("ses_share_readonly_local")
  const now = Date.now()
  const context: InstanceContext = {
    directory: project.path,
    worktree: project.path,
    project: {
      id: projectID,
      worktree: project.path,
      vcs: "git",
      time: { created: now, updated: now },
      sandboxes: [],
    },
  }
  const database = Database.layerFromPath(":memory:")
  const runtime = LayerNode.compile(LayerNode.group([node, Database.node]), [[Database.node, database]])

  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make(project.path),
          vcs: "git",
          sandboxes: [],
          time_created: now,
          time_updated: now,
        })
        .run()
      const info: Session.Info = {
        id: sessionID,
        slug: "share-readonly-local",
        projectID,
        directory: project.path,
        title: "share readonly local",
        version: "test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      }
      yield* db.insert(SessionTable).values(Session.toRow(info)).run()
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 9 }).run()
      const exporter = yield* Service
      return yield* exporter.capture({
        requestID: "cpr_share_readonly_local",
        kind: "share",
        sessionID,
        target: {
          baseURL: "https://share.example.com/api",
          organizationID: null,
          visibility: "private",
          publication: null,
        },
      })
    }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(runtime), Effect.scoped),
  )

  expect(snapshot.eventHighWaterMark).toBe(9)
  expect(snapshot.export.items.map((item) => item.key)).toEqual(["model", "session", "session_diff"])
  expect(snapshot.export.items.find((item) => item.type === "session")?.data).toMatchObject({
    id: sessionID,
    projectID,
    directory: project.path,
  })
  expect(snapshot.export.contentDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(snapshot.requestID).toBe("cpr_share_readonly_local")
  expect(SessionShareSnapshot.claimMaterial(snapshot).input).not.toHaveProperty("requestID")
})

test("local unshare exporter resolves the original publication only from a verified receipt", async () => {
  await using project = await tmpdir()
  const projectID = ProjectV2.ID.make("project_unshare_readonly_local")
  const sessionID = SessionID.descending("ses_unshare_readonly_local")
  const now = Date.now()
  const context: InstanceContext = {
    directory: project.path,
    worktree: project.path,
    project: {
      id: projectID,
      worktree: project.path,
      vcs: "git",
      time: { created: now, updated: now },
      sandboxes: [],
    },
  }
  const database = Database.layerFromPath(":memory:")
  const runtime = LayerNode.compile(LayerNode.group([node, Database.node]), [[Database.node, database]])

  const snapshot = await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: AbsolutePath.make(project.path),
          vcs: "git",
          sandboxes: [],
          time_created: now,
          time_updated: now,
        })
        .run()
      const info: Session.Info = {
        id: sessionID,
        slug: "unshare-readonly-local",
        projectID,
        directory: project.path,
        title: "unshare readonly local",
        version: "test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        share: { url: "https://share.example.com/s/shr_unshare_readonly_local" },
        time: { created: now, updated: now },
      }
      yield* db.insert(SessionTable).values(Session.toRow(info)).run()
      yield* db.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 11 }).run()
      yield* db
        .insert(SessionShareOperationReceiptTable)
        .values({
          operation_id: "op_share_unshare_readonly_local",
          run_id: "run_share_unshare_readonly_local",
          action_id: "act_share_unshare_readonly_local",
          request_id: "cpr_share_unshare_readonly_local",
          kind: "share",
          session_id: sessionID,
          project_id: projectID,
          snapshot_digest: "a".repeat(64),
          export_digest: "b".repeat(64),
          target_base_url: "https://share.example.com/api",
          visibility: "private",
          organization_id: null,
          provider_receipt_id: "rcpt_unshare_readonly_local",
          publication_id: "shr_unshare_readonly_local",
          publication_url: "https://share.example.com/s/shr_unshare_readonly_local",
          stored_digest: "b".repeat(64),
          removed_digest: null,
          response_digest: "c".repeat(64),
        })
        .run()
      const exporter = yield* Service
      return yield* exporter.capture({
        requestID: "cpr_unshare_readonly_local",
        kind: "unshare",
        sessionID,
        target: {
          baseURL: "https://share.example.com/api",
          organizationID: null,
          visibility: "private",
          publication: null,
        },
      })
    }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(runtime), Effect.scoped),
  )

  expect(snapshot.kind).toBe("unshare")
  expect(snapshot.target.publication).toEqual({
    id: "shr_unshare_readonly_local",
    url: "https://share.example.com/s/shr_unshare_readonly_local",
    exportDigest: "b".repeat(64),
  })
})
