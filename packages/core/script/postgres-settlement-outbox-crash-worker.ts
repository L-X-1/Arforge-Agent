#!/usr/bin/env bun

/**
 * Fixture worker for the PostgreSQL outbox SIGKILL window.
 *
 * The parent process owns setup/verification/cleanup. This worker only
 * prepares one metadata-only receipt, promotes the first owner, announces a
 * marker, and stays alive until the parent kills it. No provider or payload is
 * ever invoked.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { Effect } from "effect"
import { loadProductEnv } from "../src/config/product-env"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import * as ChildSettlement from "../src/runtime/child-settlement"
import * as SettlementOutbox from "../src/runtime/settlement-outbox"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")

const [descriptorPath, readyMarker] = Bun.argv.slice(2)
if (!descriptorPath || !readyMarker) throw new Error("usage: <descriptor.json> <ready-marker>")

const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
  readonly identity: SettlementOutbox.SettlementOutboxIdentity
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly observedAtMs: number
}
ChildSettlement.assertSettlementCommitPlan(descriptor.plan)

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
  [Database.node, Database.layerFromPostgresUrl(appUrl)],
])

const program = Effect.gen(function* () {
  const outbox = yield* SettlementOutbox.Service
  const input = {
    identity: descriptor.identity,
    plan: descriptor.plan,
    observedAtMs: descriptor.observedAtMs,
  } as const
  const prepared = yield* outbox.prepare(input)
  const promoted = yield* outbox.promoteOwner({
    ...input,
    owner: "admission-evidence",
    ownerDigest: descriptor.plan.expectedDigests.evidence!,
    observedAtMs: descriptor.observedAtMs + 1,
  })
  writeFileSync(
    readyMarker,
    JSON.stringify({
      schemaVersion: 1,
      prepared: prepared.record.status,
      ownerProgress: promoted.record.ownerProgress?.completed,
      intentID: descriptor.plan.intentID,
    }),
    "utf8",
  )
  yield* Effect.never
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
