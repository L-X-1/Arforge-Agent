import { existsSync, writeFileSync } from "node:fs"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventV2 } from "@arforge-ai/core/event"
import * as ChildSettlement from "@arforge-ai/core/runtime/child-settlement"
import { DurableRun } from "@arforge-ai/core/runtime/durable-run"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { ProjectID } from "@arforge-ai/schema/project-id"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { DateTime, Effect } from "effect"
import { childRunID, idempotencyKey, parentRunID } from "./child-settlement-crash-contract"

const [databasePath, readyMarker, mode = "crash", releaseMarker] = Bun.argv.slice(2)
if (!databasePath || !readyMarker) throw new Error("missing child settlement crash fixture arguments")
if (mode !== "crash" && mode !== "recover") throw new Error("invalid child settlement fixture mode")

const budget = AgentRuntime.Budget.make({
  maxAttempts: 2,
  maxDurationMs: 10_000,
  maxCostMicros: 10_000,
  maxTokens: 100_000,
  attemptsUsed: 0,
  durationMsUsed: 0,
  costMicrosUsed: 0,
  tokensUsed: 0,
})

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]), [
  [Database.node, Database.layerFromPath(databasePath)],
])

const running = (runtime: DurableRun.Interface, runID: AgentRuntime.RunID) =>
  Effect.gen(function* () {
    yield* runtime.transition({ runID, to: "preflight", reason: "SIGKILL settlement fixture preflight" })
    yield* runtime.transition({ runID, to: "queued", reason: "SIGKILL settlement fixture queued" })
    yield* runtime.transition({ runID, to: "running", reason: "SIGKILL settlement fixture running" })
  })

const program = Effect.gen(function* () {
  const runtime = yield* DurableRun.Service
  const events = yield* EventV2.Service
  const parent = yield* runtime.create({
    id: parentRunID,
    sessionID: SessionSchema.ID.make("ses_child_settlement_sigkill_parent"),
    initiator: "user",
    authority: "automatic",
    riskTier: "L1",
    reasonSummary: "real file SQLite settlement recovery fixture",
    budget,
    traceID: "trace-child-settlement-sigkill-parent",
    visibility: "audit",
    project: ProjectID.global,
    location: AbsolutePath.make("C:/child-settlement-sigkill"),
  })
  yield* running(runtime, parent.run.id)
  const child = yield* runtime.createChild({
    parentRunID: parent.run.id,
    sessionID: SessionSchema.ID.make("ses_child_settlement_sigkill_child"),
    idempotencyKey,
    delegatedObjective: "exercise file SQLite settlement recovery",
    allowedCapabilities: [{ action: "read", resources: ["fixture"], access: "read" }],
    project: ProjectID.global,
    location: AbsolutePath.make("C:/child-settlement-sigkill"),
    expectedDeliverable: { summaryRequired: true, artifactKinds: [], evidenceKinds: [], verifier: "parent" },
    initiator: "agent",
    authority: "automatic",
    riskTier: "L0",
    reasonSummary: "SIGKILL settlement fixture child",
    budget,
    traceID: "trace-child-settlement-sigkill-child",
    parentTraceID: parent.run.traceID,
    visibility: "audit",
  })
  yield* running(runtime, child.run.id)
  yield* runtime.transition({ runID: child.run.id, to: "completed", reason: "SIGKILL fixture terminal status" })

  const intentAt = yield* DateTime.now
  const resultInput = {
    status: "completed" as const,
    summary: "file SQLite settlement intent survived SIGKILL",
    artifactRefs: [],
    evidenceRefs: [],
    usage: { attempts: 0, durationMs: 0, costMicros: 0, tokens: 0 },
  }
  const settlement = ChildSettlement.createIntent({
    parentRunID: parent.run.id,
    childRunID: child.run.id,
    idempotencyKey,
    result: resultInput,
    createdAtMs: DateTime.toEpochMillis(intentAt),
  })
  const result = AgentRuntime.ChildRunResult.make({
    ...resultInput,
    resultDigest: settlement.resultDigest,
    recordedAt: intentAt,
  })
  const parentSnapshot = yield* runtime.load(parent.run.id)
  // This is the intentional crash window: the parent recovery prefix is
  // committed, but the child result and parent budget events are not.
  yield* events.publish(
    AgentRuntime.Event.ChildRunSettlementIntentRecorded,
    {
      runID: parent.run.id,
      sessionID: parent.run.sessionID,
      childRunID: child.run.id,
      idempotencyKey,
      intentID: settlement.intentID,
      idempotencyDigest: settlement.idempotencyDigest,
      result,
      intentAt,
    },
    { expectedSequence: parentSnapshot.lastSequence },
  )
  writeFileSync(readyMarker, JSON.stringify({ parentRunID, childRunID, intentID: settlement.intentID }), "utf8")
  yield* Effect.never
})

const recover = Effect.gen(function* () {
  const runtime = yield* DurableRun.Service
  const before = yield* runtime.readChildSettlementFacts({ parentRunID, childRunID })
  const parentBefore = yield* runtime.load(parentRunID)
  const childBefore = yield* runtime.load(childRunID)
  if (releaseMarker) {
    writeFileSync(readyMarker, "ready", "utf8")
    while (!existsSync(releaseMarker)) yield* Effect.sleep("10 millis")
  }
  const repaired = yield* runtime.recoverChildren({ parentRunID })
  const after = yield* runtime.readChildSettlementFacts({ parentRunID, childRunID })
  const parent = yield* runtime.load(parentRunID)
  const child = yield* runtime.load(childRunID)
  return {
    before,
    repaired,
    after,
    parentSequence: parent.lastSequence,
    childSequence: child.lastSequence,
    parentSequenceBefore: parentBefore.lastSequence,
    childSequenceBefore: childBefore.lastSequence,
  }
})

if (mode === "recover") {
  const result = await Effect.runPromise(recover.pipe(Effect.scoped, Effect.provide(layer)))
  console.log(`CHILD_RECOVERY_RESULT=${JSON.stringify(result)}`)
} else await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(layer)))
