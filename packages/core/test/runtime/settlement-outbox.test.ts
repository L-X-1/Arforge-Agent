import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { and, eq } from "drizzle-orm"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import * as SettlementOutbox from "@arforge-ai/core/runtime/settlement-outbox"
import * as SettlementOutboxInvariant from "@arforge-ai/core/runtime/settlement-outbox-invariant"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { ChildSettlementRecoveryOutboxTable } from "@arforge-ai/core/runtime/settlement-outbox.sql"
import { childRunIDFor } from "@arforge-ai/core/runtime/durable-run"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const identity = { tenantID: "ten_settlement_outbox", userID: "usr_settlement_outbox" }
const otherIdentity = { tenantID: "ten_settlement_outbox_other", userID: "usr_settlement_outbox_other" }
const parentRunID = AgentRuntime.RunID.make("run_settlement_outbox_parent")
const idempotencyKey = "settlement-outbox-contract"
const childRunID = childRunIDFor(parentRunID, idempotencyKey)!
const evidenceID = AgentRuntime.EvidenceID.make("evd_settlement_outbox")

const makePlan = () => {
  const intent = ChildSettlement.createIntent({
    parentRunID,
    childRunID,
    idempotencyKey,
    result: {
      status: "completed",
      summary: "metadata-only settlement fixture",
      artifactRefs: [],
      evidenceRefs: [evidenceID],
      usage: { attempts: 1, durationMs: 4, costMicros: 2, tokens: 8 },
    },
    admissionEvidence: {
      evidenceID,
      recordDigest: "a".repeat(64),
      actionID: AgentRuntime.ActionID.make("act_settlement_outbox"),
      observationID: AgentRuntime.ObservationID.make("obs_settlement_outbox"),
    },
    createdAtMs: 10,
  })
  return ChildSettlement.planSettlementCommit(intent, {
    mode: "recovery-outbox",
    atomicDatabaseTransaction: false,
    durableRecoveryOutbox: true,
  })
}

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
  [Database.node, Database.layerFromPath(":memory:")],
])

describe("SettlementOutbox durable metadata owner", () => {
  it.effect(
    "persists prepared/committed state with idempotent replay and no downgrade",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const plan = makePlan()
      const input = { identity, plan, observedAtMs: 10 } as const

      const prepared = yield* outbox.prepare(input)
      expect(prepared.inserted).toBe(true)
      expect(prepared.changed).toBe(true)
      expect(prepared.record.status).toBe("prepared")
      expect(prepared.record.revision).toBe(0)
      expect(prepared.record.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(prepared.record)).not.toContain("metadata-only settlement fixture")
      expect(JSON.stringify(prepared.record)).not.toContain("credentials")

      const replayed = yield* outbox.prepare({ ...input, observedAtMs: 5 })
      expect(replayed.record).toEqual(prepared.record)
      expect(replayed.inserted).toBe(false)
      expect(replayed.changed).toBe(false)

      const committed = yield* outbox.commit({ ...input, observedAtMs: 20 })
      expect(committed.inserted).toBe(false)
      expect(committed.changed).toBe(true)
      expect(committed.record.status).toBe("committed")
      expect(committed.record.revision).toBe(1)
      expect(committed.record.updatedAtMs).toBe(20)

      const committedReplay = yield* outbox.commit({ ...input, observedAtMs: 5 })
      expect(committedReplay.record).toEqual(committed.record)
      expect(committedReplay.inserted).toBe(false)
      expect(committedReplay.changed).toBe(false)
      const recoveryAfterCommit = yield* outbox.markRecoveryRequired({
        ...input,
        observedAtMs: 25,
        reason: "late owner failure",
      })
      expect(recoveryAfterCommit.record).toEqual(committed.record)
      expect(recoveryAfterCommit.record.status).toBe("committed")
      expect(recoveryAfterCommit.changed).toBe(false)
      const noDowngrade = yield* outbox.prepare({ ...input, observedAtMs: 30 })
      expect(noDowngrade.record).toEqual(committed.record)
      expect(noDowngrade.inserted).toBe(false)
      expect(noDowngrade.changed).toBe(false)
      expect(yield* outbox.read({ identity, intentID: plan.intentID })).toEqual(committed.record)
      expect(yield* outbox.list({ identity, status: "committed" })).toEqual([committed.record])
      expect(yield* outbox.list({ identity, status: "prepared" })).toEqual([])

      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      const invariant = yield* SettlementOutboxInvariant.inspect(registry, { record: committed.record })
      expect(invariant.passedAll).toBe(true)
      const drifted = yield* SettlementOutboxInvariant.inspect(registry, {
        record: { ...committed.record, receiptDigest: "0".repeat(64) },
      })
      expect(drifted.passedAll).toBe(false)
      const schemaDrifted = yield* SettlementOutboxInvariant.inspect(registry, {
        record: { ...committed.record, schemaVersion: 2 },
      })
      expect(schemaDrifted.passedAll).toBe(false)
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "records recovery-required, supports explicit exact-plan reopen, and isolates owners",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const plan = makePlan()
      const input = { identity, plan, observedAtMs: 100 } as const

      const missingCommit = yield* outbox.commit(input).pipe(Effect.exit)
      expect(missingCommit._tag).toBe("Failure")

      const failed = yield* outbox.markRecoveryRequired({ ...input, reason: "durable owner write failed" })
      expect(failed.inserted).toBe(true)
      expect(failed.record.status).toBe("recovery-required")
      expect(failed.record.revision).toBe(0)
      const sameFailure = yield* outbox.markRecoveryRequired({
        ...input,
        observedAtMs: 90,
        reason: "durable owner write failed",
      })
      expect(sameFailure.record).toEqual(failed.record)
      expect(sameFailure.inserted).toBe(false)
      expect(sameFailure.changed).toBe(false)
      const driftedFailure = yield* outbox
        .markRecoveryRequired({ ...input, observedAtMs: 95, reason: "a different recovery reason" })
        .pipe(Effect.exit)
      expect(driftedFailure._tag).toBe("Failure")

      const reopened = yield* outbox.prepare({ ...input, observedAtMs: 120 })
      expect(reopened.record.status).toBe("prepared")
      expect(reopened.record.reason).toBe("")
      expect(reopened.record.revision).toBe(1)
      expect(reopened.record.updatedAtMs).toBe(120)
      const committed = yield* outbox.commit({ ...input, observedAtMs: 130 })
      expect(committed.record.status).toBe("committed")
      expect(committed.record.revision).toBe(2)

      const other = yield* outbox.prepare({ identity: otherIdentity, plan, observedAtMs: 200 })
      expect(other.inserted).toBe(true)
      expect(other.record.tenantID).toBe(otherIdentity.tenantID)
      expect(yield* outbox.read({ identity, intentID: plan.intentID })).toEqual(committed.record)
      expect(yield* outbox.read({ identity: otherIdentity, intentID: plan.intentID })).toEqual(other.record)
      expect(yield* outbox.list({ identity })).toEqual([committed.record])
      expect(yield* outbox.list({ identity: otherIdentity })).toEqual([other.record])
      const invalidLimit = yield* outbox.list({ identity, limit: 0 }).pipe(Effect.exit)
      expect(invalidLimit._tag).toBe("Failure")

      const invalidPlan = { ...plan, commitDigest: "b".repeat(64) }
      const conflict = yield* outbox.prepare({ identity, plan: invalidPlan, observedAtMs: 300 }).pipe(Effect.exit)
      expect(conflict._tag).toBe("Failure")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "persists an ordered owner promotion prefix and refuses incomplete or divergent commits",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const plan = makePlan()
      const input = { identity, plan, observedAtMs: 600 } as const

      yield* outbox.prepare(input)
      const incomplete = yield* outbox.commitPromoted(input).pipe(Effect.exit)
      expect(incomplete._tag).toBe("Failure")

      const wrongDigest = yield* outbox
        .promoteOwner({
          ...input,
          owner: "admission-evidence",
          ownerDigest: "b".repeat(64),
        })
        .pipe(Effect.exit)
      expect(wrongDigest._tag).toBe("Failure")

      const outOfOrder = yield* outbox
        .promoteOwner({
          ...input,
          owner: "child-result",
          ownerDigest: plan.expectedDigests.childResult,
        })
        .pipe(Effect.exit)
      expect(outOfOrder._tag).toBe("Failure")

      const evidence = yield* outbox.promoteOwner({
        ...input,
        owner: "admission-evidence",
        ownerDigest: plan.expectedDigests.evidence!,
      })
      expect(evidence.changed).toBe(true)
      expect(evidence.record.ownerProgress?.completed).toEqual(["admission-evidence"])
      expect(evidence.record.ownerProgress?.ownerDigests).toEqual({
        "admission-evidence": plan.expectedDigests.evidence!,
      })
      const evidenceReplay = yield* outbox.promoteOwner({
        ...input,
        owner: "admission-evidence",
        ownerDigest: plan.expectedDigests.evidence!,
        observedAtMs: 590,
      })
      expect(evidenceReplay.record).toEqual(evidence.record)
      expect(evidenceReplay.changed).toBe(false)

      const child = yield* outbox.promoteOwner({
        ...input,
        owner: "child-result",
        ownerDigest: plan.expectedDigests.childResult,
        observedAtMs: 610,
      })
      expect(child.record.ownerProgress?.completed).toEqual(["admission-evidence", "child-result"])
      const parent = yield* outbox.promoteOwner({
        ...input,
        owner: "parent-budget",
        ownerDigest: plan.expectedDigests.parentBudget,
        observedAtMs: 620,
      })
      expect(parent.record.ownerProgress?.completed).toEqual(["admission-evidence", "child-result", "parent-budget"])

      const committed = yield* outbox.commitPromoted({ ...input, observedAtMs: 630 })
      expect(committed.record.status).toBe("committed")
      expect(committed.record.ownerProgress?.completed).toHaveLength(3)
      expect((yield* outbox.commitPromoted({ ...input, observedAtMs: 640 })).record).toEqual(committed.record)
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "reopens a failed promotion without losing the durable prefix",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const plan = makePlan()
      const input = { identity: otherIdentity, plan, observedAtMs: 700 } as const

      yield* outbox.prepare(input)
      const evidence = yield* outbox.promoteOwner({
        ...input,
        owner: "admission-evidence",
        ownerDigest: plan.expectedDigests.evidence!,
      })
      const failed = yield* outbox.markRecoveryRequired({
        ...input,
        reason: "simulated owner interruption",
        observedAtMs: 710,
      })
      expect(failed.record.status).toBe("recovery-required")
      expect(failed.record.ownerProgress).toEqual(evidence.record.ownerProgress)
      const reopened = yield* outbox.prepare({ ...input, observedAtMs: 720 })
      expect(reopened.record.status).toBe("prepared")
      expect(reopened.record.ownerProgress).toEqual(evidence.record.ownerProgress)
      yield* outbox.promoteOwner({
        ...input,
        owner: "child-result",
        ownerDigest: plan.expectedDigests.childResult,
        observedAtMs: 730,
      })
      yield* outbox.promoteOwner({
        ...input,
        owner: "parent-budget",
        ownerDigest: plan.expectedDigests.parentBudget,
        observedAtMs: 740,
      })
      expect((yield* outbox.commitPromoted({ ...input, observedAtMs: 750 })).record.status).toBe("committed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "fails closed when a persisted promotion checkpoint carries an unknown field",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const database = yield* Database.Service
      const plan = makePlan()
      const input = { identity, plan, observedAtMs: 800 } as const

      yield* outbox.prepare(input)
      const promoted = yield* outbox.promoteOwner({
        ...input,
        owner: "admission-evidence",
        ownerDigest: plan.expectedDigests.evidence!,
      })
      const progress = promoted.record.ownerProgress
      if (!progress) throw new Error("promotion fixture did not persist owner progress")
      yield* database.db
        .update(ChildSettlementRecoveryOutboxTable)
        .set({
          owner_progress: { ...progress, unexpected: true } as never,
        })
        .where(
          and(
            eq(ChildSettlementRecoveryOutboxTable.tenant_id, identity.tenantID),
            eq(ChildSettlementRecoveryOutboxTable.owner_user_id, identity.userID),
            eq(ChildSettlementRecoveryOutboxTable.intent_id, plan.intentID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      const rejected = yield* outbox.read({ identity, intentID: plan.intentID }).pipe(Effect.exit)
      expect(rejected._tag).toBe("Failure")
    }).pipe(Effect.provide(layer)),
  )

  it.effect(
    "fails closed on a corrupt receipt and requires an explicit recovery reopen",
    Effect.gen(function* () {
      const outbox = yield* SettlementOutbox.Service
      const database = yield* Database.Service
      const plan = makePlan()
      const input = { identity, plan, observedAtMs: 400 } as const

      yield* outbox.prepare(input)
      const blockedCommit = yield* outbox.markRecoveryRequired({
        ...input,
        reason: "owner write requires manual recovery",
      })
      expect(blockedCommit.record.status).toBe("recovery-required")
      const commitWithoutReopen = yield* outbox.commit({ ...input, observedAtMs: 410 }).pipe(Effect.exit)
      expect(commitWithoutReopen._tag).toBe("Failure")

      const reopened = yield* outbox.prepare({ ...input, observedAtMs: 420 })
      expect(reopened.record.status).toBe("prepared")
      expect(reopened.record.revision).toBe(blockedCommit.record.revision + 1)
      const committed = yield* outbox.commit({ ...input, observedAtMs: 430 })
      expect(committed.record.status).toBe("committed")
      const replayed = yield* outbox.commit({ ...input, observedAtMs: 10 })
      expect(replayed.record).toEqual(committed.record)
      expect(replayed.record.revision).toBe(committed.record.revision)

      yield* database.db
        .update(ChildSettlementRecoveryOutboxTable)
        .set({ receipt_digest: "0".repeat(64) })
        .where(
          and(
            eq(ChildSettlementRecoveryOutboxTable.tenant_id, identity.tenantID),
            eq(ChildSettlementRecoveryOutboxTable.owner_user_id, identity.userID),
            eq(ChildSettlementRecoveryOutboxTable.intent_id, plan.intentID),
          ),
        )
        .run()
        .pipe(Effect.orDie)

      const corruptRead = yield* outbox.read({ identity, intentID: plan.intentID }).pipe(Effect.exit)
      expect(corruptRead._tag).toBe("Failure")
      const corruptList = yield* outbox.list({ identity }).pipe(Effect.exit)
      expect(corruptList._tag).toBe("Failure")
      const corruptCommit = yield* outbox.commit({ ...input, observedAtMs: 440 }).pipe(Effect.exit)
      expect(corruptCommit._tag).toBe("Failure")
    }).pipe(Effect.provide(layer)),
  )

  test("serializes same-intent prepares and commits across concurrent SQLite owners", async () => {
    const temporary = await tmpdir()
    const databasePath = join(temporary.path, "settlement-outbox-concurrent.sqlite")
    const fileLayer = () =>
      AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
        [Database.node, Database.layerFromPath(databasePath)],
      ])
    const plan = makePlan()
    try {
      const prepared = await Promise.all(
        [1, 2].map((observedAtMs) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const outbox = yield* SettlementOutbox.Service
                return yield* outbox.prepare({ identity, plan, observedAtMs })
              }).pipe(Effect.provide(fileLayer())),
            ),
          ),
        ),
      )
      expect(prepared.filter((result) => result.inserted)).toHaveLength(1)
      expect(prepared[0]!.record).toEqual(prepared[1]!.record)

      const committed = await Promise.all(
        [3, 4].map((observedAtMs) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const outbox = yield* SettlementOutbox.Service
                return yield* outbox.commit({ identity, plan, observedAtMs })
              }).pipe(Effect.provide(fileLayer())),
            ),
          ),
        ),
      )
      expect(committed.filter((result) => result.changed)).toHaveLength(1)
      expect(committed[0]!.record).toEqual(committed[1]!.record)
      expect(committed[0]!.record.status).toBe("committed")
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  })

  test("serializes concurrent promotion of the same owner without a false recovery marker", async () => {
    const temporary = await tmpdir()
    const databasePath = join(temporary.path, "settlement-outbox-promotion-concurrent.sqlite")
    const fileLayer = () =>
      AppNodeBuilder.build(LayerNode.group([Database.node, SettlementOutbox.node]), [
        [Database.node, Database.layerFromPath(databasePath)],
      ])
    const plan = makePlan()
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const outbox = yield* SettlementOutbox.Service
            yield* outbox.prepare({ identity, plan, observedAtMs: 900 })
          }).pipe(Effect.provide(fileLayer())),
        ),
      )
      const promoted = await Promise.all(
        [901, 902].map((observedAtMs) =>
          Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const outbox = yield* SettlementOutbox.Service
                return yield* outbox.promoteOwner({
                  identity,
                  plan,
                  owner: "admission-evidence",
                  ownerDigest: plan.expectedDigests.evidence!,
                  observedAtMs,
                })
              }).pipe(Effect.provide(fileLayer())),
            ),
          ),
        ),
      )
      expect(promoted.filter((result) => result.changed)).toHaveLength(1)
      expect(promoted[0]!.record).toEqual(promoted[1]!.record)
      expect(promoted[0]!.record.status).toBe("prepared")
    } finally {
      await temporary[Symbol.asyncDispose]()
    }
  })
})
