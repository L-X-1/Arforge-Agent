import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import { ExperienceStoreV1 } from "@arforge-ai/core/experience-store"
import { LearningV2 } from "@arforge-ai/core/learning"
import { Location } from "@arforge-ai/core/location"
import { Project } from "@arforge-ai/core/project"
import { DurableAction } from "@arforge-ai/core/runtime/durable-action"
import * as ChildSettlementAudit from "@arforge-ai/core/runtime/child-settlement-audit"
import * as ChildSettlementRecovery from "@arforge-ai/core/runtime/child-settlement-recovery"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import * as RuntimeEvaluation from "@arforge-ai/core/runtime/evaluation"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { Effect, Layer } from "effect"
import { identity, phases, runIDs, type Phase } from "../fixture/admission-settlement-cross-owner-contract"
import { assertRecoveryOutboxReceipt, recoveryOutboxReceipt } from "../../src/runtime/child-settlement-recovery"
import * as SettlementOutbox from "../../src/runtime/settlement-outbox"
import { tmpdir } from "../fixture/tmpdir"

const project = Project.ID.global
const location = AbsolutePath.make("C:/cross-owner-settlement")

type CrossOwnerMarker = Readonly<{
  readonly phase: Phase
  readonly parentRunID: string
  readonly childRunID: string
  readonly intentID: string
}>

const isCrossOwnerMarker = (value: unknown): value is CrossOwnerMarker => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const phase = Reflect.get(value, "phase")
  const parentRunID = Reflect.get(value, "parentRunID")
  const childRunID = Reflect.get(value, "childRunID")
  const intentID = Reflect.get(value, "intentID")
  return (
    typeof phase === "string" &&
    phases.some((knownPhase) => knownPhase === phase) &&
    typeof parentRunID === "string" &&
    typeof childRunID === "string" &&
    typeof intentID === "string"
  )
}

const restartLayer = (databasePath: string) => {
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of({ directory: location, project: { id: project, directory: location } }),
  )
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      DurableAction.node,
      DurableRun.node,
      RuntimeEvaluation.node,
      LearningV2.node,
      ExperienceStoreV1.node,
      ChildSettlementAudit.node,
      ChildSettlementRecovery.node,
      SettlementOutbox.node,
    ]),
    [
      [Database.node, Database.layerFromPath(databasePath)],
      [Location.node, current],
    ],
  )
}

const expectedBefore: Record<
  Phase,
  Readonly<{
    evidence: Readonly<{ state: "missing" | "present" }>
    childResult: Readonly<{ state: "missing" | "present" }>
    parentBudget: Readonly<{ state: "missing" | "present" }>
  }>
> = {
  "before-evidence": {
    evidence: { state: "missing" },
    childResult: { state: "missing" },
    parentBudget: { state: "missing" },
  },
  "after-evidence": {
    evidence: { state: "present" },
    childResult: { state: "missing" },
    parentBudget: { state: "missing" },
  },
  "after-result": {
    evidence: { state: "present" },
    childResult: { state: "present" },
    parentBudget: { state: "missing" },
  },
  "after-owners-before-ack": {
    evidence: { state: "present" },
    childResult: { state: "present" },
    parentBudget: { state: "present" },
  },
  "after-outbox-commit": {
    evidence: { state: "present" },
    childResult: { state: "present" },
    parentBudget: { state: "present" },
  },
}

describe("real cross-owner admission settlement crash/recovery", () => {
  for (const phase of phases) {
    test(
      `reconciles the ${phase} SIGKILL window through one durable outbox order`,
      async () => {
        const temporary = await tmpdir()
        const root = temporary.path
        const databasePath = join(root, `${phase}.sqlite`)
        const readyMarker = join(root, `${phase}.ready.json`)
        const worker = Bun.spawn(
          [
            process.execPath,
            "test/fixture/admission-settlement-cross-owner-worker.ts",
            databasePath,
            phase,
            readyMarker,
          ],
          {
            cwd: join(import.meta.dir, "..", ".."),
            env: {
              ...process.env,
              ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
              ARFORGE_DISABLE_CHANNEL_DB: "1",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        )

        try {
          for (let attempt = 0; attempt < 1_200 && !existsSync(readyMarker); attempt += 1) await Bun.sleep(25)
          if (!existsSync(readyMarker)) {
            const stderr = worker.stderr ? await new Response(worker.stderr).text() : ""
            throw new Error(`cross-owner ${phase} fixture did not reach its crash window: ${stderr}`)
          }
          const markerValue: unknown = JSON.parse(readFileSync(readyMarker, "utf8"))
          if (!isCrossOwnerMarker(markerValue)) throw new Error("cross-owner fixture marker is malformed")
          const marker = markerValue
          expect(marker.phase).toBe(phase)
          expect(marker.parentRunID).toBe(String(runIDs(phase).parentRunID))
          expect(marker.childRunID).toBe(String(runIDs(phase).childRunID))
          expect(marker.intentID).toMatch(/^stl_[a-f0-9]{64}$/)

          worker.kill("SIGKILL")
          expect(await worker.exited).not.toBe(0)

          const { parentRunID, childRunID } = runIDs(phase)
          const recovered = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const audit = yield* ChildSettlementAudit.Service
                const recovery = yield* ChildSettlementRecovery.Service
                const outbox = yield* SettlementOutbox.Service
                const input = { identity, parentRunID, childRunID }
                const before = yield* audit.inspect(input)
                const beforeOutbox = recoveryOutboxReceipt(before, 1_000)
                if (!beforeOutbox) throw new Error("cross-owner fixture did not produce a before outbox receipt")
                assertRecoveryOutboxReceipt(beforeOutbox)
                const durableBefore = yield* outbox.read({ identity, intentID: beforeOutbox.intentID })
                if (phase === "after-owners-before-ack") expect(durableBefore?.status).toBe("prepared")
                else if (phase === "after-outbox-commit") expect(durableBefore?.status).toBe("committed")
                else expect(durableBefore).toBeUndefined()
                const repaired = yield* recovery.recover(input)
                const after = yield* audit.inspect(input)
                const afterOutbox = recoveryOutboxReceipt(after, 2_000)
                if (!afterOutbox) throw new Error("cross-owner fixture did not produce an after outbox receipt")
                assertRecoveryOutboxReceipt(afterOutbox)
                const durableAfter = yield* outbox.read({ identity, intentID: afterOutbox.intentID })
                if (!durableAfter) throw new Error("cross-owner fixture did not persist a recovery receipt")
                expect(durableAfter.status).toBe("committed")
                expect(durableAfter.receiptDigest).toMatch(/^[a-f0-9]{64}$/)
                const replay = yield* recovery.recover(input)
                const replayOutbox = recoveryOutboxReceipt(replay.after, 3_000)
                if (!replayOutbox) throw new Error("cross-owner fixture replay lost its outbox receipt")
                assertRecoveryOutboxReceipt(replayOutbox)
                const durableReplay = yield* outbox.read({ identity, intentID: replayOutbox.intentID })
                return {
                  before,
                  beforeOutbox,
                  durableBefore,
                  repaired,
                  after,
                  afterOutbox,
                  durableAfter,
                  replay,
                  replayOutbox,
                  durableReplay,
                }
              }).pipe(Effect.provide(restartLayer(databasePath))),
            ),
          )

          // Reopen the same SQLite file in a fresh application layer. This is
          // a second process boundary for the durable receipt, not just a
          // replay against the first in-memory service graph.
          const secondRestart = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                const audit = yield* ChildSettlementAudit.Service
                const recovery = yield* ChildSettlementRecovery.Service
                const outbox = yield* SettlementOutbox.Service
                const input = { identity, parentRunID, childRunID }
                const before = yield* audit.inspect(input)
                const beforeOutbox = recoveryOutboxReceipt(before, 4_000)
                if (!beforeOutbox) throw new Error("second restart lost its recovery receipt projection")
                const durableBefore = yield* outbox.read({ identity, intentID: beforeOutbox.intentID })
                if (!durableBefore) throw new Error("second restart lost its durable receipt")
                const replay = yield* recovery.recover(input)
                const after = yield* audit.inspect(input)
                const afterOutbox = recoveryOutboxReceipt(after, 5_000)
                if (!afterOutbox) throw new Error("second restart lost its recovery receipt")
                const durableAfter = yield* outbox.read({ identity, intentID: afterOutbox.intentID })
                if (!durableAfter) throw new Error("second restart lost its durable receipt after replay")
                return { before, beforeOutbox, durableBefore, replay, after, afterOutbox, durableAfter }
              }).pipe(Effect.provide(restartLayer(databasePath))),
            ),
          )

          expect(recovered.before.status).toBe(
            phase === "after-owners-before-ack" || phase === "after-outbox-commit" ? "complete" : "repairable",
          )
          expect(recovered.before.facts).toMatchObject(expectedBefore[phase])
          expect(recovered.before.decision?.next).toEqual(
            phase === "before-evidence"
              ? ["admission-evidence", "child-result", "parent-budget"]
              : phase === "after-evidence"
                ? ["child-result", "parent-budget"]
                : phase === "after-result"
                  ? ["parent-budget"]
                  : [],
          )
          expect(recovered.repaired.attempted).toEqual(
            phase === "before-evidence"
              ? ["admission-evidence", "child-result", "parent-budget"]
              : phase === "after-evidence"
                ? ["child-result", "parent-budget"]
                : phase === "after-result"
                  ? ["parent-budget"]
                  : [],
          )
          expect(recovered.repaired.repaired).toEqual(recovered.repaired.attempted)
          expect(recovered.after.status).toBe("complete")
          expect(recovered.after.facts).toMatchObject({
            evidence: { state: "present" },
            childResult: { state: "present" },
            parentBudget: { state: "present" },
          })
          expect(recovered.after.decision?.complete).toBe(true)
          expect(recovered.repaired.providerExecutionAllowed).toBe(false)
          expect(recovered.replay.repaired).toEqual([])
          expect(recovered.durableReplay).toEqual(recovered.durableAfter)
          expect(recovered.durableAfter.status).toBe("committed")
          expect(recovered.afterOutbox.decisionDigest).toBe(recovered.replayOutbox.decisionDigest)
          expect(secondRestart.replay.repaired).toEqual([])
          expect(secondRestart.before.status).toBe("complete")
          expect(secondRestart.after.status).toBe("complete")
          expect(secondRestart.durableBefore).toEqual(recovered.durableAfter)
          expect(secondRestart.durableAfter).toEqual(recovered.durableAfter)
          expect(secondRestart.afterOutbox.decisionDigest).toBe(recovered.afterOutbox.decisionDigest)
          expect(JSON.stringify(recovered.beforeOutbox)).not.toContain("cross-owner crash window")
          expect(JSON.stringify(recovered.afterOutbox)).not.toContain("credentials")
        } finally {
          worker.kill()
          await worker.exited
          await temporary[Symbol.asyncDispose]()
        }
      },
      { timeout: 45_000 },
    )
  }
})
