import { expect, test } from "bun:test"
import { Database } from "@arforge-ai/core/database/database"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"
import { Effect, Exit, Layer } from "effect"
import { SessionID } from "@/session/schema"
import { SessionShareProvider } from "@/share/provider"
import { SessionShareSnapshot } from "@/share/session-snapshot"

const sessionID = SessionID.make("ses_self_hosted_provider_1")
const baseURL = "https://share.example.com/api"

function snapshot() {
  return SessionShareSnapshot.encode({
    version: 1,
    kind: "share",
    requestID: "cpr_self_hosted_provider_1",
    sessionID,
    projectID: "project_self_hosted_provider",
    location: "C:\\repo\\self-hosted-provider",
    eventHighWaterMark: 3,
    export: {
      format: SessionShareSnapshot.FORMAT,
      items: [
        {
          key: "session",
          type: "session",
          data: { id: sessionID, projectID: "project_self_hosted_provider", directory: "C:\\repo\\self-hosted-provider" },
        },
      ],
    },
    target: {
      baseURL,
      organizationID: null,
      visibility: "private",
      publication: null,
    },
    heuristicScan: {
      scannerVersion: SessionShareSnapshot.HEURISTIC_SCANNER_VERSION,
      excluded: [],
    },
  })
}

test("self-hosted provider persists publish/revoke receipts and reconciles retries", async () => {
  const database = Database.layerFromPath(":memory:")
  const runtime = LayerNode.compile(LayerNode.group([SessionShareProvider.node, Database.node]), [
    [Database.node, database],
  ])
  const current = snapshot()
  const publishInput: SessionShareProvider.PublishInput = {
    operationID: "run_self_hosted_provider:share",
    frozenExport: current.export,
    exportDigest: current.export.contentDigest,
    target: current.target,
  }
  const differentContent = {
    format: current.export.format,
    items: [...current.export.items, { key: "model", type: "model" as const, data: [] }],
  }
  const differentDigest = canonicalHash(differentContent)!
  const differentExport = {
    ...differentContent,
    contentDigest: differentDigest,
    canonicalBytes: Buffer.byteLength(canonicalJson(differentContent)!),
  }

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* SessionShareProvider.Service
      const first = yield* provider.publish(publishInput)
      const retry = yield* provider.publish(publishInput)
      const lookup = yield* provider.lookup(publishInput.operationID)
      const publication = first.publication
      const revokeInput: SessionShareProvider.RevokeInput = {
        operationID: "run_self_hosted_provider:unshare",
        publicationID: publication.publicationID,
        originalDigest: publication.storedDigest,
        target: {
          ...current.target,
          publication: {
            id: publication.publicationID,
            url: publication.publicationURL,
            exportDigest: publication.storedDigest,
          },
        },
      }
      const revoked = yield* provider.revoke(revokeInput)
      const revokedRetry = yield* provider.revoke(revokeInput)
      const revokeLookup = yield* provider.lookupRevoke(revokeInput.operationID)
      const conflict = yield* Effect.exit(
        provider.publish({
          ...publishInput,
          frozenExport: differentExport,
          exportDigest: differentDigest,
        }),
      )
      return { first, retry, lookup, revoked, revokedRetry, revokeLookup, conflict }
    }).pipe(Effect.provide(runtime), Effect.scoped),
  )

  expect(result.retry).toEqual(result.first)
  expect(result.lookup).toEqual(result.first)
  expect(result.revokedRetry).toEqual(result.revoked)
  expect(result.revokeLookup).toMatchObject({
    operationID: "run_self_hosted_provider:unshare",
    status: "settled",
    publicationID: result.first.publication.publicationID,
    removedDigest: result.first.publication.storedDigest,
  })

  expect(Exit.isFailure(result.conflict)).toBe(true)
  if (Exit.isFailure(result.conflict)) expect(String(result.conflict.cause)).toMatch(/conflicts/)
})
