#!/usr/bin/env bun

/**
 * Controlled PostgreSQL fixture for the observation journal transaction
 * boundary.  The parent probe owns setup/cleanup and terminates this process
 * in crash mode.  No provider output, prompt, secret, or business payload is
 * accepted by this worker; only the immutable settlement contract crosses the
 * process boundary.
 */

import { renameSync, writeFileSync, readFileSync } from "node:fs"
import { DateTime, Effect } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { loadProductEnv } from "../src/config/product-env"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import * as ChildSettlement from "../src/runtime/child-settlement"
import * as SettlementCoordinator from "../src/runtime/settlement-coordinator"
import * as SettlementObservationJournal from "../src/runtime/settlement-observation-journal"
import * as SettlementOwnerAdapters from "../src/runtime/settlement-owner-adapters"

loadProductEnv()

const appUrl = process.env.ARFORGE_DB_URL?.trim()
if (!appUrl) throw new Error("ARFORGE_DB_URL is required")

const [descriptorPath, mode, readyMarker] = Bun.argv.slice(2)
if (!descriptorPath || (mode !== "crash" && mode !== "commit") || !readyMarker)
  throw new Error("usage: <descriptor.json> <crash|commit> <ready-marker>")

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
  readonly plan: ChildSettlement.SettlementCommitPlan
  readonly shared: ChildSettlement.SettlementSharedTransactionEvidence
  readonly adapterInput: SerializedAdapterInput
  readonly observedAtMs: number
  readonly parentRunID: AgentRuntime.RunID
  readonly childRunID: AgentRuntime.RunID
  readonly sessionID: AgentRuntime.SessionRun["sessionID"]
  readonly observerID: string
  readonly minimumSamples: number
}>

const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Descriptor
ChildSettlement.assertSettlementCommitPlan(descriptor.plan)
ChildSettlement.assertSettlementSharedTransactionEvidence(descriptor.shared, {
  transactionKey: descriptor.plan.transactionKey,
  ownerOrder: descriptor.plan.ownerOrder,
})

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

const writeMarker = (value: unknown) => {
  const temporary = `${readyMarker}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), "utf8")
  renameSync(temporary, readyMarker)
}

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPostgresUrl(appUrl)],
])

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  const base = SettlementOwnerAdapters.createSettlementOwnerWriters(adapterInput)
  const beforeCommit: SettlementCoordinator.SettlementBeforeCommit = ({ transaction, execution }) => {
    const journal = SettlementObservationJournal.appendInTransaction({
      transaction,
      parentRunID: descriptor.parentRunID,
      sessionID: descriptor.sessionID,
      childRunID: descriptor.childRunID,
      observerID: descriptor.observerID,
      execution,
      plan: descriptor.plan,
      sharedTransactionEvidence: descriptor.shared,
      minimumSamples: descriptor.minimumSamples,
    }).pipe(
      Effect.tap(() =>
        mode === "crash"
          ? Effect.sync(() =>
              writeMarker({
                schemaVersion: 1,
                mode,
                parentRunID: descriptor.parentRunID,
                childRunID: descriptor.childRunID,
                observerID: descriptor.observerID,
                journalEventType: SettlementObservationJournal.type,
                journalPresentOnOpenTransaction: true,
              }),
            )
          : Effect.void,
      ),
    )
    return mode === "crash" ? journal.pipe(Effect.flatMap(() => Effect.never)) : journal.pipe(Effect.asVoid)
  }
  const execution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan: descriptor.plan,
    sharedTransactionEvidence: descriptor.shared,
    writers: base,
    principal: descriptor.identity,
    beforeCommit,
    observedAtMs: descriptor.observedAtMs,
  })
  if (mode === "commit")
    writeMarker({
      schemaVersion: 1,
      mode,
      parentRunID: descriptor.parentRunID,
      childRunID: descriptor.childRunID,
      observerID: descriptor.observerID,
      journalEventType: SettlementObservationJournal.type,
      journalPresentOnOpenTransaction: true,
      committed: true,
      executionDigest: execution.executionDigest,
    })
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
