#!/usr/bin/env bun

/**
 * Fixture worker for the PostgreSQL recovery-outbox owner-write crash window.
 *
 * The parent process owns setup, restart verification, and cleanup. This
 * worker commits the concrete admission Evidence owner, announces that the
 * corresponding audit row is durable, and then stays alive before recording
 * the outbox promotion checkpoint. A parent SIGKILL therefore exercises the
 * exact gap a recovery process must close: the owner write is present, while
 * the metadata-only promotion proof is still absent. No provider capability,
 * prompt, secret, or raw response bytes are logged or accepted by the
 * metadata-only outbox boundary.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { DateTime, Effect } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { loadProductEnv } from "../src/config/product-env"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import * as ChildSettlement from "../src/runtime/child-settlement"
import * as SettlementCoordinator from "../src/runtime/settlement-coordinator"
import * as SettlementOutbox from "../src/runtime/settlement-outbox"
import * as SettlementOwnerAdapters from "../src/runtime/settlement-owner-adapters"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")

const [descriptorPath, readyMarker] = Bun.argv.slice(2)
if (!descriptorPath || !readyMarker) throw new Error("usage: <descriptor.json> <ready-marker>")

type SerializedAdapterInput = Omit<
  SettlementOwnerAdapters.SettlementOwnerAdapterInput,
  "admission" | "childResult" | "parentBudget"
> & {
  readonly admission: Omit<SettlementOwnerAdapters.SettlementOwnerAdapterInput["admission"], "observation"> & {
    readonly observation: Omit<AgentRuntime.Observation, "observedAt"> & { readonly observedAt: string }
  }
  readonly childResult: Omit<SettlementOwnerAdapters.SettlementOwnerAdapterInput["childResult"], "result"> & {
    readonly result: Omit<AgentRuntime.ChildRunResult, "recordedAt"> & { readonly recordedAt: string }
  }
  readonly parentBudget: Omit<SettlementOwnerAdapters.SettlementOwnerAdapterInput["parentBudget"], "settledAt"> & {
    readonly settledAt: string
  }
}

type Descriptor = Readonly<{
  readonly identity: Database.Principal
  readonly outboxPlan: ChildSettlement.SettlementCommitPlan
  readonly adapterInput: SerializedAdapterInput
  readonly observedAtMs: number
}>

const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Descriptor
ChildSettlement.assertSettlementCommitPlan(descriptor.outboxPlan)

/** Restore Effect DateTime values that JSON encodes as RFC3339 strings. */
const adapterInput: SettlementOwnerAdapters.SettlementOwnerAdapterInput = {
  ...descriptor.adapterInput,
  admission: {
    ...descriptor.adapterInput.admission,
    observation: {
      ...descriptor.adapterInput.admission.observation,
      observedAt: DateTime.makeUnsafe(descriptor.adapterInput.admission.observation.observedAt),
    },
  },
  childResult: {
    ...descriptor.adapterInput.childResult,
    result: {
      ...descriptor.adapterInput.childResult.result,
      recordedAt: DateTime.makeUnsafe(descriptor.adapterInput.childResult.result.recordedAt),
    },
  },
  parentBudget: {
    ...descriptor.adapterInput.parentBudget,
    settledAt: DateTime.makeUnsafe(descriptor.adapterInput.parentBudget.settledAt),
  },
}

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
  [Database.node, Database.layerFromPostgresUrl(appUrl)],
])

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const outbox = yield* SettlementOutbox.Service
  const writers = SettlementOwnerAdapters.createSettlementOwnerWriters(adapterInput)
  const outboxInput = {
    identity: descriptor.identity,
    plan: descriptor.outboxPlan,
    observedAtMs: descriptor.observedAtMs,
  } as const
  yield* outbox.prepare(outboxInput)
  const scope: SettlementCoordinator.SettlementOwnerTransactionScope = Object.freeze({
    owner: "admission-evidence",
    transactionKey: descriptor.outboxPlan.transactionKey,
    transactionID: `tx_recovery_probe_${descriptor.outboxPlan.intentID.slice(-24)}`,
    providerExecutionAllowed: false,
  })

  // Commit the concrete owner and its ExperienceStore audit in its own
  // transaction. The outbox promotion intentionally happens after the marker,
  // so the parent can prove recovery promotes an already durable owner rather
  // than replaying it blindly.
  yield* database.transactionAsPrincipal(descriptor.identity, (transaction) =>
    writers["admission-evidence"](transaction, scope).pipe(Effect.asVoid),
  )
  writeFileSync(
    readyMarker,
    JSON.stringify({
      schemaVersion: 1,
      ownerWritten: "admission-evidence",
      auditDurable: true,
      intentID: descriptor.outboxPlan.intentID,
      transactionKey: descriptor.outboxPlan.transactionKey,
      transactionID: scope.transactionID,
    }),
    "utf8",
  )
  yield* Effect.never
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
