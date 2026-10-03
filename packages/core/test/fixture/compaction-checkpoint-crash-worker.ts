#!/usr/bin/env bun

/**
 * Cross-process compaction checkpoint fixture.
 *
 * The worker commits a deterministic semantic checkpoint prefix and exits at
 * the requested phase through the opt-in hook in the Core checkpoint owner.
 * The parent test opens the same SQLite database in a new process/layer and
 * classifies the prefix; no provider or user data is involved.
 */

import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import * as ContextSurface from "@arforge-ai/core/context-surface"
import { EventV2 } from "@arforge-ai/core/event"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { ProjectV2 } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionCompactionCheckpoint } from "@arforge-ai/core/session/compaction-checkpoint"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionMessage } from "@arforge-ai/core/session/message"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { SessionSchema } from "@arforge-ai/core/session/schema"

const [databasePath, requestedPhase] = Bun.argv.slice(2)
const phases: ReadonlyArray<ContextSurface.AsyncCompactionPhase> = [
  "prepared",
  "summarizing",
  "summarized",
  "revalidated",
  "committed",
  "closed",
]
const eventRecoveryPhase = "after-event"
if (
  !databasePath ||
  (!phases.includes(requestedPhase as ContextSurface.AsyncCompactionPhase) && requestedPhase !== eventRecoveryPhase)
)
  throw new Error("usage: <databasePath> <prepared|summarizing|summarized|revalidated|committed|closed|after-event>")

const phase = requestedPhase as ContextSurface.AsyncCompactionPhase
const sessionID = SessionSchema.ID.make("ses_compaction_checkpoint_sigkill")
const providerRevision = "cross-process-compaction/v1"
const base = ContextSurface.make({
  epoch: 41,
  nodes: [
    {
      id: "m_compaction_sigkill",
      sourceSeq: 1,
      role: "user",
      text: "cross-process compaction checkpoint fixture",
    },
  ],
})
const operationID = ContextSurface.asyncCompactionOperationID(base, providerRevision)
const candidateDigest = "c".repeat(64)
const phaseIndex = requestedPhase === eventRecoveryPhase ? phases.indexOf("revalidated") : phases.indexOf(phase)

const crashAfterEventForTest = (): void => {
  if (
    process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" &&
    process.env.ARFORGE_TEST_COMPACTION_CRASH_PHASE === eventRecoveryPhase
  )
    process.kill(process.pid, "SIGKILL")
}

const checkpoint = (current: ContextSurface.AsyncCompactionPhase, sequence: number) =>
  ContextSurface.decodeAsyncCompactionCheckpoint({
    version: 1,
    operationID,
    sequence,
    phase: current,
    epoch: base.epoch,
    generation: base.generation,
    sourceHeadSeq: base.sourceHeadSeq,
    surfaceDigest: base.digest,
    providerRevision,
    ...(sequence >= 3 ? { candidateDigest } : {}),
    ...(current === "committed" || current === "closed" ? { reason: "compacted" as const } : {}),
  })

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [
  [Database.node, Database.layerFromPath(databasePath)],
])

await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/compaction-sigkill"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: "compaction-checkpoint-sigkill",
        directory: "/compaction-sigkill",
        title: "Compaction checkpoint SIGKILL fixture",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    const revalidatedIndex = phases.indexOf("revalidated")
    const prefixEnd = Math.min(phaseIndex, revalidatedIndex)
    for (const [index, current] of phases.entries()) {
      if (index > prefixEnd) break
      yield* SessionCompactionCheckpoint.append(database.db, sessionID, checkpoint(current, index + 1))
    }

    // Event-first recovery is intentionally exercised only for the extra
    // boundary and for prefixes that reached revalidated. The durable event
    // commits before the worker is killed; a fresh process must append the
    // missing committed/closed checkpoints without calling a provider.
    if (phaseIndex >= revalidatedIndex && requestedPhase !== "revalidated") {
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_compaction_checkpoint_sigkill"),
        timestamp: DateTime.makeUnsafe(41),
        reason: "auto",
        text: "cross-process recovered summary",
        recent: "recent context",
        operationID,
        candidateDigest,
      })
      crashAfterEventForTest()
    }

    for (const [index, current] of phases.entries()) {
      if (index <= revalidatedIndex || index > phaseIndex) continue
      yield* SessionCompactionCheckpoint.append(database.db, sessionID, checkpoint(current, index + 1))
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
)
