import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SessionID } from "@arforge-ai/schema/session-id"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { DurableRun, childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as SettlementCoordinator from "@arforge-ai/core/runtime/settlement-coordinator"
import * as SettlementObservationJournal from "@arforge-ai/core/runtime/settlement-observation-journal"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { Effect, DateTime } from "effect"
import { it } from "../lib/effect"

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])
const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]))

const makeExecution = (
  label: string,
  observedAtMs: number,
  options?: { readonly parentRunID?: AgentRuntime.RunID; readonly idempotencyKey?: string },
) =>
  Effect.gen(function* () {
    const parentRunID = options?.parentRunID ?? AgentRuntime.RunID.make(`run_journal_${label}_parent`)
    const idempotencyKey = options?.idempotencyKey ?? `journal-${label}`
    const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
    const evidenceID = AgentRuntime.EvidenceID.make(`evd_journal_${label}`)
    const intent = ChildSettlement.createIntent({
      parentRunID,
      childRunID,
      idempotencyKey,
      result: {
        status: "completed",
        summary: "journal fixture",
        artifactRefs: [],
        evidenceRefs: [evidenceID],
        usage: { attempts: 1, durationMs: 2, costMicros: 1, tokens: 3 },
      },
      admissionEvidence: {
        evidenceID,
        recordDigest: "a".repeat(64),
        actionID: AgentRuntime.ActionID.make(`act_journal_${label}`),
        observationID: AgentRuntime.ObservationID.make(`obs_journal_${label}`),
      },
      createdAtMs: observedAtMs,
    })
    const sharedTransactionEvidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
      transactionKey: `settlement:${intent.intentID}`,
      transactionID: `tx_journal_${label}`,
      ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
    })
    const plan = ChildSettlement.planSettlementCommit(intent, {
      mode: "same-transaction",
      atomicDatabaseTransaction: true,
      durableRecoveryOutbox: false,
      sharedTransactionEvidence,
    })
    const writers: SettlementCoordinator.SettlementOwnerWriters = Object.fromEntries(
      (["admission-evidence", "child-result", "parent-budget"] as const).map((owner) => [
        owner,
        (
          _transaction: SettlementCoordinator.SettlementTransactionHandle,
          scope: SettlementCoordinator.SettlementOwnerTransactionScope,
        ) =>
          Effect.succeed({
            schemaVersion: 1 as const,
            owner,
            transactionKey: scope.transactionKey,
            transactionID: scope.transactionID,
            ownerDigest:
              owner === "admission-evidence"
                ? plan.expectedDigests.evidence!
                : owner === "child-result"
                  ? plan.expectedDigests.childResult
                  : plan.expectedDigests.parentBudget,
          }),
      ]),
    ) as unknown as SettlementCoordinator.SettlementOwnerWriters
    const execution = yield* SettlementCoordinator.executeSettlementTransaction({
      database: {} as SettlementCoordinator.SettlementTransactionInput["database"],
      plan,
      sharedTransactionEvidence,
      writers,
      transaction: (callback) => callback({} as SettlementCoordinator.SettlementTransactionHandle),
      observedAtMs,
    })
    return { parentRunID, childRunID, plan, sharedTransactionEvidence, execution }
  })

const seedAggregate = (database: Database.Interface, aggregateID: AgentRuntime.RunID) =>
  database.db.insert(EventSequenceTable).values({ aggregate_id: aggregateID, seq: 0 }).run().pipe(Effect.orDie)

describe("SettlementObservationJournal", () => {
  it.effect(
    "appends metadata-only parent events and rebuilds the exact checkpoint after restart",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const first = yield* makeExecution("first", 10)
      const second = yield* makeExecution("second", 20, { parentRunID: first.parentRunID })
      const observerID = "durable-run:journal-parent"
      const sessionID = SessionID.make("ses_journal_parent")
      yield* seedAggregate(database, first.parentRunID)

      const firstRecord = yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({
          transaction,
          parentRunID: first.parentRunID,
          sessionID,
          childRunID: first.childRunID,
          observerID,
          execution: first.execution,
          plan: first.plan,
          sharedTransactionEvidence: first.sharedTransactionEvidence,
          minimumSamples: 2,
        }),
      )
      const secondRecord = yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({
          transaction,
          parentRunID: first.parentRunID,
          sessionID,
          childRunID: second.childRunID,
          observerID,
          execution: second.execution,
          plan: second.plan,
          sharedTransactionEvidence: second.sharedTransactionEvidence,
          minimumSamples: 2,
        }),
      )

      expect(firstRecord.event.data.sample).not.toHaveProperty("summary")
      expect(firstRecord.event.data.sample).not.toHaveProperty("providerOutput")
      expect(firstRecord.event.data.sampleSequence).toBe(1)
      expect(secondRecord.event.data.sampleSequence).toBe(2)
      expect(secondRecord.checkpoint.window.status).toBe("ready-for-review")
      expect(secondRecord.serializedEvent.type).toBe("agent.child-run.settlement-observation-recorded.1")

      const restored = yield* SettlementObservationJournal.load(database.db, {
        parentRunID: first.parentRunID,
        observerID,
      })
      expect(restored?.checkpointDigest).toBe(secondRecord.checkpoint.checkpointDigest)
      expect(restored?.window.samples.map((sample) => sample.transactionID)).toEqual([
        "tx_journal_first",
        "tx_journal_second",
      ])
      const rows = yield* database.db
        .select({ type: EventTable.type, seq: EventTable.seq })
        .from(EventTable)
        .where(sql`${EventTable.aggregate_id} = ${first.parentRunID}`)
        .all()
        .pipe(Effect.orDie)
      expect(rows.filter((row) => row.type === SettlementObservationJournal.type)).toHaveLength(2)
      expect(rows.map((row) => row.seq)).toEqual([1, 2])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "treats an exact child replay as idempotent and rejects divergent duplicates",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const execution = yield* makeExecution("idempotent", 30)
      const observerID = "durable-run:journal-idempotent"
      const sessionID = SessionID.make("ses_journal_idempotent")
      yield* seedAggregate(database, execution.parentRunID)
      const input = {
        parentRunID: execution.parentRunID,
        sessionID,
        childRunID: execution.childRunID,
        observerID,
        execution: execution.execution,
        plan: execution.plan,
        sharedTransactionEvidence: execution.sharedTransactionEvidence,
      } as const
      const first = yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({ transaction, ...input }),
      )
      const replay = yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({ transaction, ...input }),
      )
      expect(replay.event.id).toBe(first.event.id)
      const divergent = yield* database
        .transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
          SettlementObservationJournal.appendInTransaction({
            transaction,
            ...input,
            sessionID: SessionID.make("ses_journal_other"),
          }),
        )
        .pipe(Effect.exit)
      expect(divergent._tag).toBe("Failure")
      expect(String(divergent)).toContain("conflicts with its existing journal record")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "rejects tampered persisted checkpoint metadata",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const execution = yield* makeExecution("tamper", 40)
      const observerID = "durable-run:journal-tamper"
      yield* seedAggregate(database, execution.parentRunID)
      yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({
          transaction,
          parentRunID: execution.parentRunID,
          sessionID: SessionID.make("ses_journal_tamper"),
          childRunID: execution.childRunID,
          observerID,
          execution: execution.execution,
          plan: execution.plan,
          sharedTransactionEvidence: execution.sharedTransactionEvidence,
        }),
      )
      const row = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(sql`${EventTable.aggregate_id} = ${execution.parentRunID}`)
        .all()
        .pipe(Effect.orDie)
      const tampered = { ...row[0]!.data, checkpointDigest: "0".repeat(64) }
      yield* database.db
        .update(EventTable)
        .set({ data: tampered })
        .where(sql`${EventTable.aggregate_id} = ${execution.parentRunID}`)
        .run()
        .pipe(Effect.orDie)
      const restored = yield* SettlementObservationJournal.load(database.db, {
        parentRunID: execution.parentRunID,
        observerID,
      }).pipe(Effect.exit)
      expect(restored._tag).toBe("Failure")
      expect(String(restored)).toContain("checkpoint metadata drifted")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "lets DurableRun load and read the checkpoint from its parent aggregate after restart",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const runtime = yield* DurableRun.Service
      const parentRunID = AgentRuntime.RunID.make("run_journal_durable_parent")
      const parentSessionID = SessionID.make("ses_journal_durable_parent")
      const childSessionID = SessionID.make("ses_journal_durable_child")
      const childID = childRunIDFor(parentRunID, "journal-durable-child")!
      const now = DateTime.makeUnsafe(0)
      const parentBudget = AgentRuntime.Budget.make({
        maxAttempts: 4,
        maxDurationMs: 100,
        maxCostMicros: 100,
        maxTokens: 100,
        attemptsUsed: 0,
        durationMsUsed: 0,
        costMicrosUsed: 0,
        tokensUsed: 0,
      })
      const childBudget = AgentRuntime.Budget.make({
        maxAttempts: 1,
        maxDurationMs: 10,
        maxCostMicros: 10,
        maxTokens: 10,
        attemptsUsed: 0,
        durationMsUsed: 0,
        costMicrosUsed: 0,
        tokensUsed: 0,
      })
      const parentRun = AgentRuntime.SessionRun.make({
        id: parentRunID,
        sessionID: parentSessionID,
        status: "draft",
        initiator: "user",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "journal parent",
        budget: parentBudget,
        traceID: "journal-parent-trace",
        visibility: "details",
        time: { created: now, updated: now },
      })
      const childRun = AgentRuntime.SessionRun.make({
        id: childID,
        sessionID: childSessionID,
        status: "completed",
        initiator: "agent",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "journal child",
        budget: childBudget,
        traceID: "journal-child-trace",
        parentTraceID: "journal-parent-trace",
        visibility: "details",
        child: {
          version: 1,
          parentRunID,
          idempotencyKey: "journal-durable-child",
          delegatedObjective: "record a journal sample",
          allowedCapabilities: [{ action: "read", resources: ["workspace"], access: "read" }],
          project: ProjectID.global,
          location: AbsolutePath.make("/journal-durable-child"),
          expectedDeliverable: {
            summaryRequired: true,
            artifactKinds: [],
            evidenceKinds: [],
            verifier: "parent",
          },
          depth: 1,
        },
        time: { created: now, updated: now, finished: now },
      })
      yield* events.publish(AgentRuntime.Event.RunCreated, {
        runID: parentRunID,
        sessionID: parentSessionID,
        run: parentRun,
      })
      const reserved = { attempts: 1, durationMs: 2, costMicros: 3, tokens: 4 }
      yield* events.publish(
        AgentRuntime.Event.ChildRunBudgetReserved,
        {
          runID: parentRunID,
          sessionID: parentSessionID,
          childRunID: childID,
          childRun,
          reserved,
          reservedTotal: reserved,
          reservedAt: now,
        },
        { expectedSequence: 0 },
      )
      yield* events.publish(
        AgentRuntime.Event.ChildRunBudgetSettled,
        {
          runID: parentRunID,
          sessionID: parentSessionID,
          childRunID: childID,
          reserved,
          actual: reserved,
          reservedTotal: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
          settledAt: now,
        },
        { expectedSequence: 1 },
      )

      const execution = yield* makeExecution("durable", 10, {
        parentRunID,
        idempotencyKey: "journal-durable-child",
      })
      expect(execution.childRunID).toBe(childID)
      const observerID = `durable-run:${parentRunID}`
      const record = yield* database.transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
        SettlementObservationJournal.appendInTransaction({
          transaction,
          parentRunID,
          sessionID: parentSessionID,
          childRunID: childID,
          observerID,
          execution: execution.execution,
          plan: execution.plan,
          sharedTransactionEvidence: execution.sharedTransactionEvidence,
          minimumSamples: 1,
        }),
      )
      const loaded = yield* runtime.load(parentRunID)
      expect(loaded.lastSequence).toBe(3)
      const checkpoint = yield* runtime.readSettlementObservation({
        parentRunID,
        observerID,
        minimumSamples: 1,
      })
      expect(checkpoint?.checkpointDigest).toBe(record.checkpoint.checkpointDigest)
      expect(checkpoint?.window.sampleCount).toBe(1)
      expect(checkpoint?.window.promotionAuthorized).toBe(false)
    }).pipe(Effect.provide(runtimeLayer)),
  )
})
