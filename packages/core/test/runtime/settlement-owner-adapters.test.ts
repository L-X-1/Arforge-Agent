import { describe, expect, test } from "bun:test"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { DateTime, Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import * as AdmissionEvidence from "@arforge-ai/core/runtime/admission-evidence"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as SettlementCoordinator from "@arforge-ai/core/runtime/settlement-coordinator"
import * as SettlementOwnerAdapters from "@arforge-ai/core/runtime/settlement-owner-adapters"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import { ExperienceAuditTable, ExperienceEvidenceTable } from "@arforge-ai/core/experience-store/sql"
import { it } from "../lib/effect"

const identity = {
  tenantID: "ten_settlement_adapter",
  userID: "usr_settlement_adapter",
  actor: "user:settlement-adapter",
}
const parentRunID = AgentRuntime.RunID.make("run_settlement_adapter_parent")
const idempotencyKey = "settlement-owner-adapter"
const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
const legacyIdempotencyKey = `${idempotencyKey}-legacy`
const legacyChildRunID = childRunIDFor(parentRunID, legacyIdempotencyKey)!

const admission = (): AgentRuntime.CustomAgentAdmissionEvidence => ({
  schema_version: 1,
  kind: "custom-agent-admission",
  role: "CustomAgent.Adapter",
  profile_path: "profiles/adapter.json",
  status: "admitted",
  decision: "admitted",
  reason: "transaction adapter fixture",
  ready: true,
  descriptor_digest: "a".repeat(64),
  checks: {
    status_consistent: true,
    descriptor_digest_consistent: true,
    tool_projection_consistent: true,
    payload_free: true,
  },
  declared_tool_count: 1,
  canonical_tool_count: 1,
  unsupported_tool_count: 0,
  valid: true,
  violations: [],
})

const databaseLayer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])

const makeInput = () => {
  const actionID = AgentRuntime.ActionID.make("act_settlement_adapter")
  const observation = AgentRuntime.Observation.make({
    id: AgentRuntime.ObservationID.make("obs_settlement_adapter"),
    actionID,
    status: "succeeded",
    summary: "adapter fixture observation",
    artifactIDs: [],
    observedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
  })
  const admissionPlan = AdmissionEvidence.plan({
    identity,
    parentRunID,
    childRunID,
    idempotencyKey,
    admission: admission(),
    evidenceRefs: [],
  })
  const materialized = AdmissionEvidence.materialize({ plan: admissionPlan, actionID, observation })
  const usage = { attempts: 1, durationMs: 12, costMicros: 4, tokens: 20 }
  const resultInput = {
    status: "completed" as const,
    summary: "adapter child result",
    artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
    evidenceRefs: [admissionPlan.evidenceID],
    usage,
  }
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: resultInput,
    admissionEvidence: {
      evidenceID: admissionPlan.evidenceID,
      recordDigest: materialized.recordDigest,
      actionID,
      observationID: observation.id,
    },
    createdAtMs: 1,
  })
  const result = AgentRuntime.ChildRunResult.make({
    ...resultInput,
    resultDigest: intent.resultDigest,
    recordedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
  })
  const shared = ChildSettlement.makeSettlementSharedTransactionEvidence({
    transactionKey: `settlement:${intent.intentID}`,
    transactionID: "tx_settlement_adapter_1",
    ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
    sharedTransactionEvidence: shared,
  })
  return {
    plan,
    shared,
    input: {
      plan,
      admission: { identity, plan: admissionPlan, actionID, observation },
      childResult: {
        eventID: EventV2.ID.create(),
        sessionID: "ses_settlement_adapter_child" as AgentRuntime.SessionRun["sessionID"],
        result,
        expectedSequence: 0,
      },
      parentBudget: {
        eventID: EventV2.ID.create(),
        sessionID: "ses_settlement_adapter_parent" as AgentRuntime.SessionRun["sessionID"],
        reserved: usage,
        actual: usage,
        reservedTotal: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        settledAt: result.recordedAt,
        expectedSequence: 0,
      },
    } satisfies SettlementOwnerAdapters.SettlementOwnerAdapterInput,
  }
}

const makeLegacyInput = () => {
  const usage = { attempts: 1, durationMs: 9, costMicros: 2, tokens: 14 }
  const resultInput = {
    status: "completed" as const,
    summary: "legacy adapter child result",
    artifactRefs: [] as ReadonlyArray<AgentRuntime.ArtifactID>,
    evidenceRefs: [] as ReadonlyArray<AgentRuntime.EvidenceID>,
    usage,
  }
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID: legacyChildRunID,
    idempotencyKey: legacyIdempotencyKey,
    result: resultInput,
    createdAtMs: 1,
  })
  const result = AgentRuntime.ChildRunResult.make({
    ...resultInput,
    resultDigest: intent.resultDigest,
    recordedAt: DateTime.makeUnsafe("2026-09-04T00:00:00.000Z"),
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
  })
  return {
    plan,
    input: {
      plan,
      childResult: {
        eventID: EventV2.ID.create(),
        sessionID: "ses_settlement_adapter_legacy_child" as AgentRuntime.SessionRun["sessionID"],
        result,
        expectedSequence: 0,
      },
      parentBudget: {
        eventID: EventV2.ID.create(),
        sessionID: "ses_settlement_adapter_legacy_parent" as AgentRuntime.SessionRun["sessionID"],
        reserved: usage,
        actual: usage,
        reservedTotal: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
        settledAt: result.recordedAt,
        expectedSequence: 0,
      },
    } satisfies SettlementOwnerAdapters.LegacySettlementOwnerAdapterInput,
  }
}

const seedAggregates = Effect.fn("seedSettlementAdapterAggregates")(function* (
  database: Database.Interface["db"],
  childID: AgentRuntime.RunID = childRunID,
) {
  yield* database
    .insert(EventSequenceTable)
    .values([
      { aggregate_id: childID, seq: 0 },
      { aggregate_id: parentRunID, seq: 0 },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* database
    .insert(EventTable)
    .values([
      { id: EventV2.ID.create(), aggregate_id: childID, seq: 0, type: "fixture.seed.1", data: {} },
      { id: EventV2.ID.create(), aggregate_id: parentRunID, seq: 0, type: "fixture.seed.1", data: {} },
    ])
    .run()
    .pipe(Effect.orDie)
})

describe("SettlementOwnerAdapters", () => {
  it.effect(
    "writes ExperienceStore evidence/audit and both DurableRun events on one transaction",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contract = makeInput()
      yield* seedAggregates(database.db)
      const execution = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.shared,
        writers: SettlementOwnerAdapters.createSettlementOwnerWriters(contract.input),
        observedAtMs: 1,
      })

      expect(execution.ownerReceipts.map((item) => item.owner)).toEqual([
        "admission-evidence",
        "child-result",
        "parent-budget",
      ])
      expect(execution.ownerReceipts.every((item) => item.transactionID === "tx_settlement_adapter_1")).toBe(true)
      expect((yield* database.db.select().from(ExperienceEvidenceTable).all()).length).toBe(1)
      expect((yield* database.db.select().from(ExperienceAuditTable).all()).length).toBe(1)
      const events = yield* database.db
        .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
        .from(EventTable)
        .where(sql`${EventTable.seq} = 1`)
        .all()
      expect(events).toEqual([
        { aggregateID: childRunID, seq: 1 },
        { aggregateID: parentRunID, seq: 1 },
      ])
    }).pipe(Effect.provide(databaseLayer)),
  )

  it.effect(
    "rolls back the concrete owner writes when the parent budget sequence is stale",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contract = makeInput()
      yield* seedAggregates(database.db)
      const failed = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.shared,
        writers: SettlementOwnerAdapters.createSettlementOwnerWriters({
          ...contract.input,
          parentBudget: { ...contract.input.parentBudget, expectedSequence: 9 },
        }),
        observedAtMs: 2,
      }).pipe(Effect.exit)

      expect(failed._tag).toBe("Failure")
      expect(String(failed)).toContain("expected sequence 9")
      expect((yield* database.db.select().from(ExperienceEvidenceTable).all()).length).toBe(0)
      expect((yield* database.db.select().from(ExperienceAuditTable).all()).length).toBe(0)
      const rows = yield* database.db
        .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
        .from(EventTable)
        .where(sql`${EventTable.seq} = 1`)
        .all()
      expect(rows).toEqual([])
    }).pipe(Effect.provide(databaseLayer)),
  )

  test("rejects an admission plan bound to a different parent aggregate", () => {
    const contract = makeInput()
    expect(() =>
      SettlementOwnerAdapters.createSettlementOwnerWriters({
        ...contract.input,
        admission: {
          ...contract.input.admission,
          plan: {
            ...contract.input.admission.plan,
            parentRunID: AgentRuntime.RunID.make("run_settlement_adapter_other_parent"),
          },
        },
      }),
    ).toThrow("parent identity")
  })

  test("rejects an admission Evidence identity that is not carried by the child result", () => {
    const contract = makeInput()
    expect(() =>
      SettlementOwnerAdapters.createSettlementOwnerWriters({
        ...contract.input,
        childResult: {
          ...contract.input.childResult,
          result: {
            ...contract.input.childResult.result,
            evidenceRefs: [],
          },
        },
      }),
    ).toThrow("not carried by the child result")
  })

  it.effect(
    "fuses legacy child-result and parent-budget owners through the same concrete adapter path",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contract = makeLegacyInput()
      yield* seedAggregates(database.db, legacyChildRunID)
      const committed: Array<{ owner: "child-result" | "parent-budget"; aggregateID: string; seq: number }> = []
      const execution = yield* SettlementCoordinator.executeLegacySettlementTransaction({
        database: database.db,
        plan: contract.plan,
        transactionID: "tx_settlement_adapter_legacy_1",
        writers: SettlementOwnerAdapters.createLegacySettlementOwnerWriters({
          ...contract.input,
          onOwnerWrite: (event) => committed.push(event),
        }),
        observedAtMs: 3,
      })

      expect(execution.ownerReceipts.map((item) => item.owner)).toEqual(["child-result", "parent-budget"])
      expect(execution.ownerReceipts.every((item) => item.transactionID === "tx_settlement_adapter_legacy_1")).toBe(
        true,
      )
      expect(committed).toEqual([
        { owner: "child-result", aggregateID: legacyChildRunID, seq: 1 },
        { owner: "parent-budget", aggregateID: parentRunID, seq: 1 },
      ])
      expect((yield* database.db.select().from(ExperienceEvidenceTable).all()).length).toBe(0)
      const events = yield* database.db
        .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
        .from(EventTable)
        .where(sql`${EventTable.seq} = 1`)
        .all()
      expect(events).toEqual([
        { aggregateID: legacyChildRunID, seq: 1 },
        { aggregateID: parentRunID, seq: 1 },
      ])
    }).pipe(Effect.provide(databaseLayer)),
  )

  it.effect(
    "rolls back the legacy concrete adapter when parent-budget CAS is stale",
    Effect.gen(function* () {
      const database = yield* Database.Service
      const contract = makeLegacyInput()
      yield* seedAggregates(database.db, legacyChildRunID)
      const failed = yield* SettlementCoordinator.executeLegacySettlementTransaction({
        database: database.db,
        plan: contract.plan,
        transactionID: "tx_settlement_adapter_legacy_2",
        writers: SettlementOwnerAdapters.createLegacySettlementOwnerWriters({
          ...contract.input,
          parentBudget: { ...contract.input.parentBudget, expectedSequence: 7 },
        }),
        observedAtMs: 4,
      }).pipe(Effect.exit)

      expect(failed._tag).toBe("Failure")
      expect(String(failed)).toContain("expected sequence 7")
      expect((yield* database.db.select().from(ExperienceEvidenceTable).all()).length).toBe(0)
      const rows = yield* database.db
        .select({ aggregateID: EventTable.aggregate_id, seq: EventTable.seq })
        .from(EventTable)
        .where(sql`${EventTable.seq} = 1`)
        .all()
      expect(rows).toEqual([])
    }).pipe(Effect.provide(databaseLayer)),
  )
})
