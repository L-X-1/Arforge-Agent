#!/usr/bin/env bun

/**
 * Cross-process fixture for the settlement observation journal.
 *
 * The worker exercises the real transaction-bound SettlementCoordinator and
 * appends the metadata-only observation event through its before-commit seam.
 * In crash mode it announces that the journal row is present on the still-open
 * transaction and then waits for SIGKILL.  A fresh process must observe the
 * entire owner/journal prefix rolled back.  In commit mode the same contract
 * commits and can be rebuilt by a fresh application layer.
 */

import { renameSync, writeFileSync } from "node:fs"
import { Effect } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionID } from "@arforge-ai/schema/session-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventSequenceTable } from "@arforge-ai/core/event/sql"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as SettlementCoordinator from "@arforge-ai/core/runtime/settlement-coordinator"
import * as SettlementObservationJournal from "@arforge-ai/core/runtime/settlement-observation-journal"

const [databasePath, mode, readyMarker] = Bun.argv.slice(2)
if (!databasePath || (mode !== "crash" && mode !== "commit") || !readyMarker)
  throw new Error("usage: <databasePath> <crash|commit> <readyMarker>")

const parentRunID = AgentRuntime.RunID.make("run_settlement_observation_sigkill_parent")
const childRunID = childRunIDFor(parentRunID, "settlement-observation-sigkill")
if (!childRunID) throw new Error("settlement observation child identity could not be derived")
const sessionID = SessionID.make("ses_settlement_observation_sigkill_parent")
const observerID = "durable-run:settlement-observation-sigkill"
const observedAtMs = 1_725_000_000_000

const writeMarker = (value: unknown) => {
  const temporary = `${readyMarker}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), "utf8")
  renameSync(temporary, readyMarker)
}

const intent = ChildSettlement.createIntent({
  parentRunID,
  childRunID,
  idempotencyKey: "settlement-observation-sigkill",
  result: {
    status: "completed",
    summary: "cross-process observation journal fixture",
    artifactRefs: [],
    evidenceRefs: [AgentRuntime.EvidenceID.make("evd_settlement_observation_sigkill")],
    usage: { attempts: 1, durationMs: 2, costMicros: 1, tokens: 3 },
  },
  admissionEvidence: {
    evidenceID: AgentRuntime.EvidenceID.make("evd_settlement_observation_sigkill"),
    recordDigest: "a".repeat(64),
    actionID: AgentRuntime.ActionID.make("act_settlement_observation_sigkill"),
    observationID: AgentRuntime.ObservationID.make("obs_settlement_observation_sigkill"),
  },
  createdAtMs: observedAtMs,
})

const sharedTransactionEvidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
  transactionKey: `settlement:${intent.intentID}`,
  transactionID: "tx_settlement_observation_sigkill",
  ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
})
const plan = ChildSettlement.planSettlementCommit(intent, {
  mode: "same-transaction",
  atomicDatabaseTransaction: true,
  durableRecoveryOutbox: false,
  sharedTransactionEvidence,
})

const writer =
  (owner: ChildSettlement.SettlementWrite, ownerDigest: string): SettlementCoordinator.SettlementOwnerWriter =>
  (_transaction, scope) =>
    Effect.succeed({
      schemaVersion: 1 as const,
      owner,
      transactionKey: scope.transactionKey,
      transactionID: scope.transactionID,
      ownerDigest,
    })

const writers: SettlementCoordinator.SettlementOwnerWriters = {
  "admission-evidence": writer("admission-evidence", plan.expectedDigests.evidence!),
  "child-result": writer("child-result", plan.expectedDigests.childResult),
  "parent-budget": writer("parent-budget", plan.expectedDigests.parentBudget),
}

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPath(databasePath)],
])

const seedParentAggregate = (database: Database.Interface) =>
  database.db
    .insert(EventSequenceTable)
    .values({ aggregate_id: parentRunID, seq: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)

const beforeCommit: SettlementCoordinator.SettlementBeforeCommit = ({ transaction, execution }) => {
  const journal = SettlementObservationJournal.appendInTransaction({
    transaction,
    parentRunID,
    sessionID,
    childRunID,
    observerID,
    execution,
    plan,
    sharedTransactionEvidence,
    minimumSamples: 1,
  }).pipe(
    Effect.tap(() =>
      mode === "crash"
        ? Effect.sync(() =>
            writeMarker({
              schemaVersion: 1,
              mode,
              parentRunID,
              childRunID,
              observerID,
              journalEventType: SettlementObservationJournal.type,
              journalPresentOnOpenTransaction: true,
            }),
          )
        : Effect.void,
    ),
  )
  return mode === "crash" ? journal.pipe(Effect.flatMap(() => Effect.never)) : journal.pipe(Effect.asVoid)
}

const program = Effect.gen(function* () {
  const database = yield* Database.Service
  // Seed is committed separately, so a crash in the coordinator cannot erase
  // the parent aggregate required for the restart read.
  yield* seedParentAggregate(database)
  const execution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
    database,
    plan,
    sharedTransactionEvidence,
    writers,
    principal: Database.DefaultLocalPrincipal,
    beforeCommit,
    observedAtMs,
  })
  if (mode === "commit")
    writeMarker({
      schemaVersion: 1,
      mode,
      parentRunID,
      childRunID,
      observerID,
      journalEventType: SettlementObservationJournal.type,
      journalPresentOnOpenTransaction: true,
      committed: true,
      executionDigest: execution.executionDigest,
    })
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
