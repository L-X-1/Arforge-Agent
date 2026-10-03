import { afterEach, expect } from "bun:test"
import { canonicalHash, canonicalJson } from "@arforge-ai/core/util/canonical-hash"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Worktree } from "@/worktree"
import { SessionShareSnapshot } from "@/share/session-snapshot"
import { SELF_HOSTED_PROVIDER_INTERNAL_TOKEN } from "@/share/self-hosted"
import { SelfHostedSharePaths } from "../../src/server/routes/instance/httpapi/groups/self-hosted-share"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, Database.node, InstanceStore.node, Worktree.node]), [
      [InstanceStore.bootstrapNode, InstanceBootstrap.node],
    ]),
    httpApiLayer,
  ),
)

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance(
  "executes the self-hosted provider contract through HTTP",
  () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const session = yield* Session.use.create({ title: "self-hosted-http" })
      const content = {
        format: SessionShareSnapshot.FORMAT,
        items: [
          {
            key: "session",
            type: "session" as const,
            data: { id: session.id, projectID: session.projectID, directory: tmp.directory },
          },
        ],
      }
      const exportDigest = canonicalHash(content)!
      const frozenExport = {
        ...content,
        contentDigest: exportDigest,
        canonicalBytes: Buffer.byteLength(canonicalJson(content)!),
      }
      const target = {
        baseURL: "https://share.example.com/api",
        organizationID: null,
        visibility: "private" as const,
        publication: null,
        transportPolicy: "https-only" as const,
      }
      const operationID = "run_self_hosted_http:share"
      const unauthorized = yield* requestInDirectory(SelfHostedSharePaths.publish, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationID, frozenExport, exportDigest, target }),
      })
      expect(unauthorized.status).toBe(403)
      const headers = {
        "content-type": "application/json",
        "x-arforge-provider-internal": SELF_HOSTED_PROVIDER_INTERNAL_TOKEN,
      }
      const publish = yield* requestInDirectory(SelfHostedSharePaths.publish, tmp.directory, {
        method: "POST",
        headers,
        body: JSON.stringify({ operationID, frozenExport, exportDigest, target }),
      })
      expect(publish.status).toBe(200)
      const publication = (yield* json<{
        operationID: string
        status: "settled"
        publication: {
          providerReceiptID: string
          publicationID: string
          publicationURL: string
          storedDigest: string
        }
      }>(publish)).publication
      expect(publication.storedDigest).toBe(exportDigest)

      const lookup = yield* requestInDirectory(
        SelfHostedSharePaths.lookup.replace(":operationID", encodeURIComponent(operationID)),
        tmp.directory,
        { headers },
      )
      expect(lookup.status).toBe(200)
      expect(yield* json<{ status: string; publication?: { publicationID: string } }>(lookup)).toMatchObject({
        status: "settled",
        publication: { publicationID: publication.publicationID },
      })

      const revokeOperationID = "run_self_hosted_http:unshare"
      const revoke = yield* requestInDirectory(SelfHostedSharePaths.revoke, tmp.directory, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationID: revokeOperationID,
          publicationID: publication.publicationID,
          originalDigest: exportDigest,
          target: {
            ...target,
            publication: {
              id: publication.publicationID,
              url: publication.publicationURL,
              exportDigest,
            },
          },
        }),
      })
      expect(revoke.status).toBe(200)
      expect(yield* json<{ status: string; publicationID: string; removedDigest: string }>(revoke)).toMatchObject({
        status: "settled",
        publicationID: publication.publicationID,
        removedDigest: exportDigest,
      })

      const revokeLookup = yield* requestInDirectory(
        SelfHostedSharePaths.lookupRevoke.replace(":operationID", encodeURIComponent(revokeOperationID)),
        tmp.directory,
        { headers },
      )
      expect(revokeLookup.status).toBe(200)
      expect(yield* json<{ status: string; publicationID?: string }>(revokeLookup)).toMatchObject({
        status: "settled",
        publicationID: publication.publicationID,
      })

      const differentContent = {
        ...content,
        items: [...content.items, { key: "model", type: "model" as const, data: [] }],
      }
      const differentDigest = canonicalHash(differentContent)!
      const conflict = yield* requestInDirectory(SelfHostedSharePaths.publish, tmp.directory, {
        method: "POST",
        headers,
        body: JSON.stringify({
          operationID,
          frozenExport: {
            ...differentContent,
            contentDigest: differentDigest,
            canonicalBytes: Buffer.byteLength(canonicalJson(differentContent)!),
          },
          exportDigest: differentDigest,
          target,
        }),
      })
      expect(conflict.status).toBe(409)
    }),
  30_000,
)
