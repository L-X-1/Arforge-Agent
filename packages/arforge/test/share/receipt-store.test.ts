import { expect, test } from "bun:test"
import { Database } from "@arforge-ai/core/database/database"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { ProjectV2 } from "@arforge-ai/core/project"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionShareProvider } from "@/share/provider"
import { Service, node } from "@/share/receipt-store"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { tmpdir } from "../fixture/fixture"

test("receipt store persists only verified settled share/unshare receipts and is idempotent", async () => {
  await using project = await tmpdir()
  const projectID = ProjectV2.ID.make("project_share_receipt_store")
  const sessionID = SessionID.descending("ses_share_receipt_store")
  const now = Date.now()
  const database = Database.layerFromPath(":memory:")
  const runtime = LayerNode.compile(LayerNode.group([node, Database.node]), [[Database.node, database]])

  const shareSnapshot = SessionShareSnapshot.encode({
    version: 1,
    kind: "share",
    requestID: "cpr_share_receipt_store_1",
    sessionID,
    projectID,
    location: project.path,
    eventHighWaterMark: 12,
    export: {
      format: SessionShareSnapshot.FORMAT,
      items: [
        {
          key: "session",
          type: "session",
          data: { id: sessionID, projectID, directory: project.path },
        },
      ],
    },
    target: {
      baseURL: "https://share.example.com/api",
      organizationID: null,
      visibility: "private",
      publication: null,
    },
    heuristicScan: {
      scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
      excluded: [],
    },
  })
  const publication: SessionShareProvider.PublicationReceipt = {
    providerReceiptID: "rcpt_share_receipt_store_1",
    publicationID: "shr_share_receipt_store_1",
    publicationURL: "https://share.example.com/s/shr_share_receipt_store_1",
    storedDigest: shareSnapshot.export.contentDigest,
    visibility: "private",
    organizationID: null,
  }
  const shareInput = {
    operationID: "op_share_receipt_store_1",
    runID: "run_share_receipt_store_1",
    actionID: "act_share_receipt_store_1",
    requestID: shareSnapshot.requestID,
    snapshot: shareSnapshot,
    result: { operationID: "op_share_receipt_store_1", status: "settled" as const, publication },
  }
  const unshareSnapshot = SessionShareSnapshot.encode({
    version: 1,
    kind: "unshare",
    requestID: "cpr_unshare_receipt_store_1",
    sessionID,
    projectID,
    location: project.path,
    eventHighWaterMark: 13,
    export: {
      format: SessionShareSnapshot.FORMAT,
      items: shareSnapshot.export.items.map(({ key, type, data }) => ({ key, type, data })),
    },
    target: {
      baseURL: shareSnapshot.target.baseURL,
      organizationID: shareSnapshot.target.organizationID,
      visibility: shareSnapshot.target.visibility,
      publication: {
        id: publication.publicationID,
        url: publication.publicationURL,
        originalExportDigest: publication.storedDigest,
      },
    },
    heuristicScan: {
      scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
      excluded: [],
    },
  })

  const result = await Effect.runPromise(
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
        slug: "share-receipt-store",
        projectID,
        directory: project.path,
        title: "share receipt store",
        version: "test",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      }
      yield* db.insert(SessionTable).values(Session.toRow(info)).run()
      const store = yield* Service
      const first = yield* store.record(shareInput)
      const same = yield* store.record(shareInput)
      const conflict = yield* Effect.exit(
        store.record({
          ...shareInput,
          result: {
            ...shareInput.result,
            publication: { ...publication, publicationID: "shr_share_receipt_store_other" },
          },
        }),
      )
      const unshare = yield* store.record({
        operationID: "op_unshare_receipt_store_1",
        runID: "run_unshare_receipt_store_1",
        actionID: "act_unshare_receipt_store_1",
        requestID: unshareSnapshot.requestID,
        snapshot: unshareSnapshot,
        result: {
          operationID: "op_unshare_receipt_store_1",
          status: "settled" as const,
          publicationID: publication.publicationID,
          removedDigest: publication.storedDigest,
          visibility: "private" as const,
          organizationID: null,
        },
      })
      return { first, same, conflict, unshare }
    }).pipe(Effect.provide(runtime), Effect.scoped),
  )

  expect(result.first).toMatchObject({
    operation_id: shareInput.operationID,
    kind: "share",
    export_digest: shareSnapshot.export.contentDigest,
    publication_id: publication.publicationID,
    stored_digest: shareSnapshot.export.contentDigest,
  })
  expect(result.same).toEqual(result.first)
  expect(Exit.isFailure(result.conflict)).toBe(true)
  if (Exit.isFailure(result.conflict)) expect(String(result.conflict.cause)).toMatch(/receipt_conflict/)
  expect(result.unshare).toMatchObject({
    operation_id: "op_unshare_receipt_store_1",
    kind: "unshare",
    export_digest: publication.storedDigest,
    publication_id: publication.publicationID,
    removed_digest: publication.storedDigest,
  })
})
