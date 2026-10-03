#!/usr/bin/env bun

/**
 * Fixture worker for the PostgreSQL coordinator in-flight SIGKILL window.
 *
 * The parent process owns setup, crash verification, restart, and cleanup.
 * This worker only runs the real concrete owner adapters through the
 * production-shaped Database.transactionAsPrincipal seam.  It announces a
 * marker after the Evidence and ChildResult owners have written inside the
 * still-open transaction, then waits forever so the parent can terminate the
 * process.  No provider, payload-bearing log, or second transaction is
 * allowed through this boundary.
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
import * as SettlementOwnerAdapters from "../src/runtime/settlement-owner-adapters"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")

const [descriptorPath, readyMarker] = Bun.argv.slice(2)
if (!descriptorPath || !readyMarker) throw new Error("usage: <descriptor.json> <ready-marker>")

type Descriptor = Readonly<{
  readonly identity: Database.Principal
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly shared: ChildSettlement.SettlementSharedTransactionEvidence
  readonly adapterInput: SettlementOwnerAdapters.SettlementOwnerAdapterInput
  readonly observedAtMs: number
}>

const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Descriptor & {
  readonly adapterInput: Omit<
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
}

ChildSettlement.assertSettlementCommitPlan(descriptor.plan)
ChildSettlement.assertSettlementSharedTransactionEvidence(descriptor.shared, {
  transactionKey: descriptor.plan.transactionKey,
  ownerOrder: descriptor.plan.ownerOrder,
})

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

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPostgresUrl(appUrl)],
])

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const base = SettlementOwnerAdapters.createSettlementOwnerWriters(adapterInput)
  const writers: SettlementCoordinator.SettlementOwnerWriters = {
    "admission-evidence": base["admission-evidence"],
    "child-result": (transaction, scope) =>
      base["child-result"](transaction, scope).pipe(
        // The marker is written only after both real owner writes have
        // completed on the open transaction.  Effect.never keeps the
        // transaction callback alive until the parent sends SIGKILL.
        Effect.tap(() =>
          Effect.sync(() =>
            writeFileSync(
              readyMarker,
              JSON.stringify({
                schemaVersion: 1,
                ownersWritten: ["admission-evidence", "child-result"],
                transactionKey: descriptor.plan.transactionKey,
                transactionID: descriptor.shared.transactionID,
              }),
              "utf8",
            ),
          ),
        ),
        Effect.flatMap(() => Effect.never),
      ),
    "parent-budget": base["parent-budget"],
  }
  yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan: descriptor.plan,
    sharedTransactionEvidence: descriptor.shared,
    writers,
    principal: descriptor.identity,
    observedAtMs: descriptor.observedAtMs,
  })
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
