import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import * as SettlementCoordinator from "@arforge-ai/core/runtime/settlement-coordinator"
import * as SettlementCoordinatorInvariant from "@arforge-ai/core/runtime/settlement-coordinator-invariant"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { Effect } from "effect"
import { it } from "../lib/effect"

const parentRunID = AgentRuntime.RunID.make("run_settlement_coordinator_parent")
const idempotencyKey = "settlement-coordinator-contract"
const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
const legacyIdempotencyKey = `${idempotencyKey}-legacy`
const legacyChildRunID = childRunIDFor(parentRunID, legacyIdempotencyKey)!
const evidenceID = AgentRuntime.EvidenceID.make("evd_settlement_coordinator")

const makeContract = () => {
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: {
      status: "completed",
      summary: "transaction-bound settlement fixture",
      artifactRefs: [],
      evidenceRefs: [evidenceID],
      usage: { attempts: 1, durationMs: 6, costMicros: 3, tokens: 12 },
    },
    admissionEvidence: {
      evidenceID,
      recordDigest: "a".repeat(64),
      actionID: AgentRuntime.ActionID.make("act_settlement_coordinator"),
      observationID: AgentRuntime.ObservationID.make("obs_settlement_coordinator"),
    },
    createdAtMs: 10,
  })
  const transactionKey = `settlement:${intent.intentID}`
  const sharedTransactionEvidence = ChildSettlement.makeSettlementSharedTransactionEvidence({
    transactionKey,
    transactionID: "tx_settlement_coordinator_1",
    ownerOrder: ["admission-evidence", "child-result", "parent-budget"],
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
    sharedTransactionEvidence,
  })
  return { plan, sharedTransactionEvidence }
}

const makeLegacyContract = () => {
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID: legacyChildRunID,
    idempotencyKey: legacyIdempotencyKey,
    result: {
      status: "completed",
      summary: "legacy transaction-bound settlement fixture",
      artifactRefs: [],
      evidenceRefs: [],
      usage: { attempts: 1, durationMs: 4, costMicros: 2, tokens: 8 },
    },
    createdAtMs: 10,
  })
  const plan = ChildSettlement.planSettlementCommit(intent, {
    mode: "same-transaction",
    atomicDatabaseTransaction: true,
    durableRecoveryOutbox: false,
  })
  return { plan, transactionID: "tx_settlement_coordinator_legacy_1" }
}

const layer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])

const ownerOrder: ReadonlyArray<ChildSettlement.SettlementWrite> = [
  "admission-evidence",
  "child-result",
  "parent-budget",
]

const makeWriters = (options?: {
  readonly seenTransactions?: Set<unknown>
  readonly seenPrincipals?: Array<Database.Principal | undefined>
  readonly failOwner?: ChildSettlement.SettlementWrite
  readonly malformedOwner?: ChildSettlement.SettlementWrite
}): SettlementCoordinator.SettlementOwnerWriters => {
  const seenTransactions = options?.seenTransactions
  return Object.fromEntries(
    ownerOrder.map((owner) => [
      owner,
      (
        transaction: SettlementCoordinator.SettlementTransactionHandle,
        scope: SettlementCoordinator.SettlementOwnerTransactionScope,
      ) =>
        Effect.gen(function* () {
          seenTransactions?.add(transaction)
          options?.seenPrincipals?.push(yield* Database.CurrentPrincipal)
          yield* transaction
            .run(
              sql`INSERT INTO settlement_coordinator_probe (owner, transaction_id) VALUES (${owner}, ${scope.transactionID})`,
            )
            .pipe(Effect.orDie)
          if (options?.failOwner === owner) return yield* Effect.fail(new Error(`${owner} owner failed`))
          const digest =
            owner === "admission-evidence"
              ? makeContract().plan.expectedDigests.evidence!
              : owner === "child-result"
                ? makeContract().plan.expectedDigests.childResult
                : makeContract().plan.expectedDigests.parentBudget
          const receipt = {
            schemaVersion: 1 as const,
            owner,
            transactionKey: scope.transactionKey,
            transactionID: scope.transactionID,
            ownerDigest: digest,
          }
          if (options?.malformedOwner === owner) return { ...receipt, unexpected: "payload" } as never
          return receipt
        }),
    ]),
  ) as SettlementCoordinator.SettlementOwnerWriters
}

const makeLegacyWriters = (options?: {
  readonly seenPrincipals?: Array<Database.Principal | undefined>
  readonly failOwner?: SettlementCoordinator.LegacySettlementOwner
}): SettlementCoordinator.LegacySettlementOwnerWriters => {
  const contract = makeLegacyContract()
  const ownerOrder: ReadonlyArray<SettlementCoordinator.LegacySettlementOwner> = ["child-result", "parent-budget"]
  return Object.fromEntries(
    ownerOrder.map((owner) => [
      owner,
      (
        transaction: SettlementCoordinator.SettlementTransactionHandle,
        scope: SettlementCoordinator.SettlementOwnerTransactionScope,
      ) =>
        Effect.gen(function* () {
          options?.seenPrincipals?.push(yield* Database.CurrentPrincipal)
          yield* transaction
            .run(
              sql`INSERT INTO settlement_coordinator_probe (owner, transaction_id) VALUES (${owner}, ${scope.transactionID})`,
            )
            .pipe(Effect.orDie)
          if (options?.failOwner === owner) return yield* Effect.fail(new Error(`${owner} owner failed`))
          return {
            schemaVersion: 1 as const,
            owner,
            transactionKey: scope.transactionKey,
            transactionID: scope.transactionID,
            ownerDigest:
              owner === "child-result"
                ? contract.plan.expectedDigests.childResult
                : contract.plan.expectedDigests.parentBudget,
          }
        }),
    ]),
  ) as SettlementCoordinator.LegacySettlementOwnerWriters
}

describe("SettlementTransactionCoordinator", () => {
  it.effect(
    "injects one transaction handle in fixed order and returns a stable payload-free commit receipt",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeContract()
      const seenTransactions = new Set<unknown>()
      const first = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters({ seenTransactions }),
        observedAtMs: 100,
      })

      expect(seenTransactions.size).toBe(1)
      expect(first.ownerOrder).toEqual(ownerOrder)
      expect(first.ownerReceipts.map((receipt) => receipt.owner)).toEqual([...ownerOrder])
      expect(first.ownerReceipts.every((receipt) => receipt.transactionID === "tx_settlement_coordinator_1")).toBe(true)
      expect(first.outcome).toBe("committed")
      expect(first.providerExecutionAllowed).toBe(false)
      expect(first.executionDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(first)).not.toContain("transaction-bound settlement fixture")
      expect(() =>
        SettlementCoordinator.assertSettlementTransactionExecution(first, {
          plan: contract.plan,
          sharedTransactionEvidence: contract.sharedTransactionEvidence,
        }),
      ).not.toThrow()

      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const report = yield* SettlementCoordinatorInvariant.inspect(registry, {
        kind: "execution",
        execution: first,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
      })
      expect(report.passedAll).toBe(true)
      expect(report.results).toMatchObject([
        { owner: "settlement-coordinator", key: "execution-receipt", status: "passed" },
      ])
      const drifted = yield* SettlementCoordinatorInvariant.inspect(registry, {
        kind: "execution",
        execution: { ...first, executionDigest: "0".repeat(64) },
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
      })
      expect(drifted.passedAll).toBe(false)

      const rows = yield* database.db.all(
        "SELECT owner, transaction_id FROM settlement_coordinator_probe ORDER BY rowid",
      )
      expect(rows).toEqual([
        { owner: "admission-evidence", transaction_id: "tx_settlement_coordinator_1" },
        { owner: "child-result", transaction_id: "tx_settlement_coordinator_1" },
        { owner: "parent-budget", transaction_id: "tx_settlement_coordinator_1" },
      ])

      yield* database.db.run("DELETE FROM settlement_coordinator_probe").pipe(Effect.orDie)
      const replay = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters(),
        observedAtMs: 200,
      })
      expect(replay.executionDigest).toBe(first.executionDigest)
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "accepts the canonical principal-bound transaction runner without opening a second owner transaction",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeContract()
      const seenPrincipals: Array<Database.Principal | undefined> = []
      const principal = { tenantID: "ten_settlement_runner", userID: "usr_settlement_runner" } as const
      const execution = yield* SettlementCoordinator.executeSettlementTransactionAsPrincipal({
        database,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters({ seenPrincipals }),
        principal,
        observedAtMs: 101,
      })

      expect(execution.outcome).toBe("committed")
      expect(seenPrincipals).toEqual([principal, principal, principal])
      expect(execution.transactionID).toBe("tx_settlement_coordinator_1")
      expect(execution.ownerReceipts.map((receipt) => receipt.transactionID)).toEqual([
        "tx_settlement_coordinator_1",
        "tx_settlement_coordinator_1",
        "tx_settlement_coordinator_1",
      ])
      const rows = yield* database.db.all(
        "SELECT owner, transaction_id FROM settlement_coordinator_probe ORDER BY rowid",
      )
      expect(rows).toHaveLength(3)

      const invalidRunner = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters(),
        transaction: "not-a-runner" as never,
        observedAtMs: 102,
      }).pipe(Effect.exit)
      expect(invalidRunner._tag).toBe("Failure")
      expect(String(invalidRunner)).toContain("transaction runner is invalid")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "rolls back every owner write when a later owner fails",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeContract()
      const failed = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters({ failOwner: "child-result" }),
        observedAtMs: 300,
      }).pipe(Effect.exit)

      expect(failed._tag).toBe("Failure")
      expect(String(failed)).toContain("child-result")
      expect(yield* database.db.all("SELECT owner FROM settlement_coordinator_probe")).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "runs metadata-only before-commit work on the same handle and rolls it back on failure",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeContract()
      const first = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters(),
        beforeCommit: ({ transaction, execution }) =>
          transaction
            .run(
              sql`INSERT INTO settlement_coordinator_probe (owner, transaction_id) VALUES ('journal', ${execution.transactionID})`,
            )
            .pipe(Effect.orDie, Effect.asVoid),
        observedAtMs: 350,
      })
      expect(first.outcome).toBe("committed")
      expect(yield* database.db.all("SELECT owner FROM settlement_coordinator_probe")).toHaveLength(4)

      yield* database.db.run("DELETE FROM settlement_coordinator_probe").pipe(Effect.orDie)
      const failed = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters(),
        beforeCommit: () => Effect.fail(new Error("journal failure")),
        observedAtMs: 351,
      }).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(String(failed)).toContain("before-commit")
      expect(yield* database.db.all("SELECT owner FROM settlement_coordinator_probe")).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "rejects malformed owner receipts before committing any row",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeContract()
      const rejected = yield* SettlementCoordinator.executeSettlementTransaction({
        database: database.db,
        plan: contract.plan,
        sharedTransactionEvidence: contract.sharedTransactionEvidence,
        writers: makeWriters({ malformedOwner: "parent-budget" }),
        observedAtMs: 400,
      }).pipe(Effect.exit)

      expect(rejected._tag).toBe("Failure")
      expect(String(rejected)).toContain("fields drifted")
      expect(yield* database.db.all("SELECT owner FROM settlement_coordinator_probe")).toEqual([])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "supports the fused two-owner transaction for legacy children",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeLegacyContract()
      const seenPrincipals: Array<Database.Principal | undefined> = []
      const principal = { tenantID: "ten_legacy_runner", userID: "usr_legacy_runner" } as const
      const first = yield* SettlementCoordinator.executeLegacySettlementTransactionAsPrincipal({
        database,
        plan: contract.plan,
        transactionID: contract.transactionID,
        writers: makeLegacyWriters({ seenPrincipals }),
        principal,
        observedAtMs: 500,
      })

      expect(seenPrincipals).toEqual([principal, principal])
      expect(first.planDigest).toBe(contract.plan.commitDigest)
      expect(first.ownerOrder).toEqual(["child-result", "parent-budget"])
      expect(first.ownerReceipts.map((receipt) => receipt.owner)).toEqual(["child-result", "parent-budget"])
      expect(first.ownerReceipts.every((receipt) => receipt.transactionID === contract.transactionID)).toBe(true)
      expect(first.providerExecutionAllowed).toBe(false)
      expect(first.executionDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(() =>
        SettlementCoordinator.assertLegacySettlementTransactionExecution(first, {
          plan: contract.plan,
          transactionID: contract.transactionID,
        }),
      ).not.toThrow()
      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const report = yield* SettlementCoordinatorInvariant.inspect(registry, {
        kind: "legacy-execution",
        execution: first,
        plan: contract.plan,
        transactionID: contract.transactionID,
      })
      expect(report.passedAll).toBe(true)
      expect(report.results).toMatchObject([
        { owner: "settlement-coordinator", key: "legacy-execution-receipt", status: "passed" },
      ])
      expect(
        yield* database.db.all("SELECT owner, transaction_id FROM settlement_coordinator_probe ORDER BY rowid"),
      ).toEqual([
        { owner: "child-result", transaction_id: contract.transactionID },
        { owner: "parent-budget", transaction_id: contract.transactionID },
      ])

      // The shared registry may have already installed the three-owner
      // invariant. Legacy registration must still be added independently;
      // otherwise a later legacy receipt would be reported as unknown.
      const sharedRegistry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const evidenceReport = yield* SettlementCoordinatorInvariant.inspect(sharedRegistry, {
        kind: "execution",
        execution: first,
        plan: makeContract().plan,
        sharedTransactionEvidence: makeContract().sharedTransactionEvidence,
      })
      expect(evidenceReport.passedAll).toBe(false)
      const legacyReport = yield* SettlementCoordinatorInvariant.inspect(sharedRegistry, {
        kind: "legacy-execution",
        execution: first,
        plan: contract.plan,
        transactionID: contract.transactionID,
      })
      expect(legacyReport.results).toMatchObject([
        { owner: "settlement-coordinator", key: "legacy-execution-receipt", status: "passed" },
      ])
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "rolls back the legacy owner prefix when the parent budget owner fails",
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .run(sql`CREATE TABLE settlement_coordinator_probe (owner text NOT NULL, transaction_id text NOT NULL)`)
        .pipe(Effect.orDie)
      const contract = makeLegacyContract()
      const failed = yield* SettlementCoordinator.executeLegacySettlementTransaction({
        database: database.db,
        plan: contract.plan,
        transactionID: contract.transactionID,
        writers: makeLegacyWriters({ failOwner: "parent-budget" }),
        observedAtMs: 600,
      }).pipe(Effect.exit)

      expect(failed._tag).toBe("Failure")
      expect(String(failed)).toContain("parent-budget")
      expect(yield* database.db.all("SELECT owner FROM settlement_coordinator_probe")).toEqual([])
    }).pipe(Effect.provide(layer)),
  )
})
