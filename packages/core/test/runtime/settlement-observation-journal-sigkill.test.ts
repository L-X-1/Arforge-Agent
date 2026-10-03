import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Database } from "@arforge-ai/core/database/database"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@arforge-ai/core/event/sql"
import * as SettlementObservationJournal from "@arforge-ai/core/runtime/settlement-observation-journal"
import { sql } from "drizzle-orm"
import { tmpdir } from "../fixture/tmpdir"

const parentRunID = AgentRuntime.RunID.make("run_settlement_observation_sigkill_parent")
const observerID = "durable-run:settlement-observation-sigkill"

const restartLayer = (databasePath: string) =>
  AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, Database.layerFromPath(databasePath)]])

const readState = (databasePath: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const sequence = yield* database.db
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(sql`${EventSequenceTable.aggregate_id} = ${parentRunID}`)
        .all()
        .pipe(Effect.orDie)
      const journalRows = yield* database.db
        .select({ type: EventTable.type, seq: EventTable.seq })
        .from(EventTable)
        .where(
          sql`${EventTable.aggregate_id} = ${parentRunID} AND ${EventTable.type} = ${SettlementObservationJournal.type}`,
        )
        .all()
        .pipe(Effect.orDie)
      const checkpoint = yield* SettlementObservationJournal.load(database.db, { parentRunID, observerID })
      return { sequence, journalRows, checkpoint }
    }).pipe(Effect.provide(restartLayer(databasePath))),
  )

const waitForMarker = async (worker: ReturnType<typeof Bun.spawn>, markerPath: string) => {
  for (let attempt = 0; attempt < 1_000 && !existsSync(markerPath); attempt += 1) await Bun.sleep(25)
  if (!existsSync(markerPath)) {
    const stderr = worker.stderr && typeof worker.stderr !== "number" ? await new Response(worker.stderr).text() : ""
    throw new Error(`observation journal worker did not reach its marker: ${stderr}`)
  }
  return JSON.parse(readFileSync(markerPath, "utf8")) as {
    readonly mode: "crash" | "commit"
    readonly parentRunID: string
    readonly observerID: string
    readonly journalPresentOnOpenTransaction: boolean
    readonly committed?: boolean
  }
}

describe("real SQLite settlement observation journal crash/restart", () => {
  test(
    "rolls back an uncommitted journal prefix after SIGKILL and rebuilds it after a fresh commit",
    async () => {
      const temporary = await tmpdir()
      const databasePath = join(temporary.path, "settlement-observation.sqlite")
      const crashMarker = join(temporary.path, "crash.ready.json")
      const commitMarker = join(temporary.path, "commit.ready.json")
      const workerArgs = (mode: "crash" | "commit", marker: string) => [
        process.execPath,
        "test/fixture/settlement-observation-journal-sigkill-worker.ts",
        databasePath,
        mode,
        marker,
      ]

      const crashWorker = Bun.spawn(workerArgs("crash", crashMarker), {
        cwd: join(import.meta.dir, "..", ".."),
        env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const crash = await waitForMarker(crashWorker, crashMarker)
        expect(crash.mode).toBe("crash")
        expect(crash.parentRunID).toBe(String(parentRunID))
        expect(crash.observerID).toBe(observerID)
        expect(crash.journalPresentOnOpenTransaction).toBe(true)

        crashWorker.kill("SIGKILL")
        expect(await crashWorker.exited).not.toBe(0)

        const afterCrash = await Effect.runPromise(readState(databasePath))
        expect(afterCrash.sequence).toEqual([{ seq: 0 }])
        expect(afterCrash.journalRows).toEqual([])
        expect(afterCrash.checkpoint).toBeUndefined()

        const commitWorker = Bun.spawn(workerArgs("commit", commitMarker), {
          cwd: join(import.meta.dir, "..", ".."),
          env: { ...process.env, ARFORGE_DISABLE_CHANNEL_DB: "1" },
          stdout: "pipe",
          stderr: "pipe",
        })
        try {
          const commit = await waitForMarker(commitWorker, commitMarker)
          expect(commit.mode).toBe("commit")
          expect(commit.parentRunID).toBe(String(parentRunID))
          expect(commit.observerID).toBe(observerID)
          expect(commit.journalPresentOnOpenTransaction).toBe(true)
          expect(commit.committed).toBe(true)
          expect(await commitWorker.exited).toBe(0)
        } finally {
          commitWorker.kill()
          await commitWorker.exited
        }

        const afterCommit = await Effect.runPromise(readState(databasePath))
        expect(afterCommit.sequence).toEqual([{ seq: 1 }])
        expect(afterCommit.journalRows).toEqual([{ type: SettlementObservationJournal.type, seq: 1 }])
        expect(afterCommit.checkpoint?.window.sampleCount).toBe(1)
        expect(afterCommit.checkpoint?.window.promotionAuthorized).toBe(false)

        // A second fresh layer proves the checkpoint is rebuilt from durable
        // EventV2 rows rather than from the first restart's in-memory state.
        const secondRestart = await Effect.runPromise(readState(databasePath))
        expect(secondRestart.checkpoint?.checkpointDigest).toBe(afterCommit.checkpoint?.checkpointDigest)
        expect(secondRestart.journalRows).toEqual(afterCommit.journalRows)
      } finally {
        crashWorker.kill()
        await crashWorker.exited
        await temporary[Symbol.asyncDispose]()
      }
    },
    { timeout: 45_000 },
  )
})
