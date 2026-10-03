import { describe, expect } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { and, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { LayerNode } from "@arforge-ai/core/effect/layer-node"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import * as ContextSurface from "@arforge-ai/core/context-surface"
import { ProjectTable } from "@arforge-ai/core/project/sql"
import { ProjectV2 } from "@arforge-ai/core/project"
import { AbsolutePath } from "@arforge-ai/core/schema"
import { SessionCompactionCheckpoint } from "@arforge-ai/core/session/compaction-checkpoint"
import { SessionCompaction } from "@arforge-ai/core/session/compaction"
import { SessionEvent } from "@arforge-ai/core/session/event"
import { SessionMessage } from "@arforge-ai/core/session/message"
import * as RuntimeInvariants from "@arforge-ai/core/runtime/invariants"
import { SessionCompactionCheckpointTable, SessionTable } from "@arforge-ai/core/session/sql"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const runtimeLayer = AppNodeBuilder.build(LayerNode.group([Database.node]))
const it = testEffect(runtimeLayer)
const invariantIt = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, RuntimeInvariants.node])))
const recoveryIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, RuntimeInvariants.node])),
)

const sessionID = SessionSchema.ID.make("ses_compaction_checkpoint")

const checkpointFor =
  (base: ContextSurface.SurfaceVersion, operationID: string) =>
  (input: {
    readonly sequence: number
    readonly phase: ContextSurface.AsyncCompactionPhase
    readonly reason?: ContextSurface.AsyncCompactionReason
    readonly candidateDigest?: string
  }): ContextSurface.AsyncCompactionCheckpoint => ({
    version: 1,
    operationID,
    sequence: input.sequence,
    phase: input.phase,
    epoch: base.epoch,
    generation: base.generation,
    sourceHeadSeq: base.sourceHeadSeq,
    surfaceDigest: base.digest,
    providerRevision: "test-provider/v1",
    ...(input.candidateDigest === undefined ? {} : { candidateDigest: input.candidateDigest }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  })

const createSession = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: ProjectV2.ID.global,
      slug: "compaction-checkpoint",
      directory: "/project",
      title: "Compaction checkpoint",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
})

describe("SessionCompactionCheckpoint", () => {
  recoveryIt.live(
    "classifies every compaction checkpoint prefix after a real child-process SIGKILL",
    () =>
      Effect.promise(async () => {
        const phases = ["prepared", "summarizing", "summarized", "revalidated", "committed", "closed"] as const
        const expected: Readonly<Record<(typeof phases)[number], { status: string; lastPhase: string }>> = {
          prepared: { status: "in_flight", lastPhase: "prepared" },
          summarizing: { status: "in_flight", lastPhase: "summarizing" },
          summarized: { status: "in_flight", lastPhase: "summarized" },
          revalidated: { status: "in_flight", lastPhase: "revalidated" },
          committed: { status: "completed_unsettled", lastPhase: "committed" },
          closed: { status: "committed", lastPhase: "closed" },
        }
        const workerPath = fileURLToPath(new URL("../fixture/compaction-checkpoint-crash-worker.ts", import.meta.url))
        const session = SessionSchema.ID.make("ses_compaction_checkpoint_sigkill")

        for (const phase of phases) {
          const directory = await tmpdir()
          try {
            const databasePath = path.join(directory.path, "compaction-checkpoint.sqlite")
            const child = Bun.spawn([process.execPath, workerPath, databasePath, phase], {
              cwd: directory.path,
              env: {
                ...process.env,
                ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
                ARFORGE_TEST_COMPACTION_CRASH_PHASE: phase,
              },
              stdout: "pipe",
              stderr: "pipe",
            })
            const [exitCode, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            expect(exitCode, `${phase} worker unexpectedly completed: ${stdout}\n${stderr}`).not.toBe(0)

            const inspectionLayer = AppNodeBuilder.build(LayerNode.group([Database.node]), [
              [Database.node, Database.layerFromPath(databasePath)],
            ])
            const operations = await Effect.runPromise(
              Effect.gen(function* () {
                const database = yield* Database.Service
                return yield* SessionCompactionCheckpoint.scan(database.db, session)
              }).pipe(Effect.scoped, Effect.provide(inspectionLayer)),
            )
            expect(operations).toHaveLength(1)
            expect(operations[0]).toMatchObject(expected[phase])
          } finally {
            await directory[Symbol.asyncDispose]()
          }
        }

        const recoveryCases = ["after-event", "committed", "closed"] as const
        const recoveryOperationBase = ContextSurface.make({
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
        const recoveryOperationID = ContextSurface.asyncCompactionOperationID(
          recoveryOperationBase,
          "cross-process-compaction/v1",
        )
        for (const phase of recoveryCases) {
          const directory = await tmpdir()
          try {
            const databasePath = path.join(directory.path, "compaction-checkpoint.sqlite")
            const child = Bun.spawn([process.execPath, workerPath, databasePath, phase], {
              cwd: directory.path,
              env: {
                ...process.env,
                ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE: "1",
                ARFORGE_TEST_COMPACTION_CRASH_PHASE: phase,
              },
              stdout: "pipe",
              stderr: "pipe",
            })
            const [exitCode, stdout, stderr] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ])
            expect(exitCode, `${phase} event worker unexpectedly completed: ${stdout}\n${stderr}`).not.toBe(0)

            const inspectionLayer = AppNodeBuilder.build(
              LayerNode.group([Database.node, EventV2.node, RuntimeInvariants.node]),
              [[Database.node, Database.layerFromPath(databasePath)]],
            )
            const recovered = await Effect.runPromise(
              Effect.gen(function* () {
                const database = yield* Database.Service
                const events = yield* EventV2.Service
                const invariants = yield* RuntimeInvariants.Service
                const report = yield* SessionCompactionCheckpoint.recoverPublished(
                  database.db,
                  events,
                  session,
                  invariants,
                )
                const checkpoints = yield* SessionCompactionCheckpoint.load(
                  database.db,
                  session,
                  recoveryOperationID,
                  invariants,
                )
                return { report, checkpoints }
              }).pipe(Effect.scoped, Effect.provide(inspectionLayer)),
            )
            expect(recovered.report.blocked).toEqual([])
            expect(recovered.report.settled).toEqual(phase === "closed" ? [] : [recoveryOperationID])
            expect(recovered.checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
              "prepared",
              "summarizing",
              "summarized",
              "revalidated",
              "committed",
              "closed",
            ])
          } finally {
            await directory[Symbol.asyncDispose]()
          }
        }
      }),
    { timeout: 45_000 },
  )

  it.effect("persists an immutable chain and classifies it after a service rebuild", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const databaseLayer = Database.layerFromPath(path.join(tmp.path, "compaction-checkpoint.sqlite"))
      const persistentLayer = () =>
        AppNodeBuilder.build(LayerNode.group([Database.node]), [[Database.node, databaseLayer]])

      const base = ContextSurface.make({
        epoch: 7,
        nodes: [
          { id: "m_1", sourceSeq: 1, role: "user", text: "old context" },
          { id: "m_2", sourceSeq: 2, role: "assistant", text: "recent context" },
        ],
      })
      const operationID = ContextSurface.asyncCompactionOperationID(base, "test-provider/v1")
      const checkpoint = checkpointFor(base, operationID)

      yield* Effect.gen(function* () {
        yield* createSession
        const db = (yield* Database.Service).db
        const append = (
          phase: ContextSurface.AsyncCompactionPhase,
          sequence: number,
          reason?: ContextSurface.AsyncCompactionReason,
        ) => SessionCompactionCheckpoint.append(db, sessionID, checkpoint({ sequence, phase, reason }))
        yield* append("prepared", 1)
        yield* append("summarizing", 2)
        yield* append("summarized", 3, undefined)
        yield* append("revalidated", 4)
        yield* append("committed", 5, "compacted")
        yield* append("closed", 6, "compacted")
        expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID)).toBe("committed")
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const loaded = yield* SessionCompactionCheckpoint.load(db, sessionID, operationID)
        expect(loaded).toHaveLength(6)
        expect(loaded.map((item) => item.phase)).toEqual([
          "prepared",
          "summarizing",
          "summarized",
          "revalidated",
          "committed",
          "closed",
        ])
        expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID)).toBe("committed")
      }).pipe(Effect.provide(Layer.fresh(persistentLayer())))
    }),
  )

  it.effect("allows exact idempotent replay but rejects divergence and sequence gaps", () =>
    Effect.gen(function* () {
      yield* createSession
      const db = (yield* Database.Service).db
      const base = ContextSurface.make({ nodes: [{ id: "m_1", sourceSeq: 1, role: "user", text: "context" }] })
      const operationID = ContextSurface.asyncCompactionOperationID(base, "test-provider/v1")
      const prepared = checkpointFor(base, operationID)({ sequence: 1, phase: "prepared" })
      yield* SessionCompactionCheckpoint.append(db, sessionID, prepared)
      yield* SessionCompactionCheckpoint.append(db, sessionID, prepared)

      const divergent = { ...prepared, providerRevision: "other/v1" }
      const divergentExit = yield* SessionCompactionCheckpoint.append(db, sessionID, divergent).pipe(Effect.exit)
      expect(divergentExit._tag).toBe("Failure")

      const gap = checkpointFor(base, operationID)({ sequence: 3, phase: "summarizing" })
      const gapExit = yield* SessionCompactionCheckpoint.append(db, sessionID, gap).pipe(Effect.exit)
      expect(gapExit._tag).toBe("Failure")

      const illegal = checkpointFor(base, operationID)({ sequence: 2, phase: "committed", reason: "compacted" })
      const illegalExit = yield* SessionCompactionCheckpoint.append(db, sessionID, illegal).pipe(Effect.exit)
      expect(illegalExit._tag).toBe("Failure")

      const rows = yield* db
        .select()
        .from(SessionCompactionCheckpointTable)
        .where(
          and(
            eq(SessionCompactionCheckpointTable.session_id, sessionID),
            eq(SessionCompactionCheckpointTable.operation_id, operationID),
          ),
        )
        .all()
      expect(rows).toHaveLength(1)
    }),
  )

  recoveryIt.effect("closes a completed_unsettled chain exactly once from its durable Session settlement", () =>
    Effect.gen(function* () {
      yield* createSession
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const invariants = yield* RuntimeInvariants.Service
      const base = ContextSurface.make({
        epoch: 23,
        nodes: [{ id: "m_recovery", sourceSeq: 1, role: "user", text: "recover committed summary" }],
      })
      const operationID = ContextSurface.asyncCompactionOperationID(base, "test-provider/v1")
      const candidateDigest = "a".repeat(64)
      const makeCheckpoint = checkpointFor(base, operationID)
      const append = (
        phase: ContextSurface.AsyncCompactionPhase,
        sequence: number,
        reason?: ContextSurface.AsyncCompactionReason,
      ) =>
        SessionCompactionCheckpoint.append(
          db,
          sessionID,
          makeCheckpoint({
            phase,
            sequence,
            reason,
            ...(sequence >= 3 ? { candidateDigest } : {}),
          }),
          invariants,
        )
      yield* append("prepared", 1)
      yield* append("summarizing", 2)
      yield* append("summarized", 3)
      yield* append("revalidated", 4)
      yield* append("committed", 5, "compacted")
      expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID, invariants)).toBe(
        "completed_unsettled",
      )

      const messageID = SessionMessage.ID.make("msg_compaction_recovery")
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "auto",
        text: "Recovered summary",
        recent: "Recent context",
        operationID,
        candidateDigest,
      })

      const reports = yield* Effect.all(
        [
          SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants),
          SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants),
        ],
        { concurrency: "unbounded" },
      )
      expect(new Set(reports.flatMap((report) => report.settled))).toEqual(new Set([operationID]))
      expect(reports.flatMap((report) => report.blocked)).toEqual([])
      const loaded = yield* SessionCompactionCheckpoint.load(db, sessionID, operationID, invariants)
      expect(loaded.map((checkpoint) => checkpoint.phase)).toEqual([
        "prepared",
        "summarizing",
        "summarized",
        "revalidated",
        "committed",
        "closed",
      ])
      expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID, invariants)).toBe("committed")
      expect(yield* SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants)).toEqual({
        settled: [],
        blocked: [],
      })
    }),
  )

  recoveryIt.effect("promotes an event-first commit and leaves provider-only prefixes blocked", () =>
    Effect.gen(function* () {
      yield* createSession
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const invariants = yield* RuntimeInvariants.Service
      const base = ContextSurface.make({
        epoch: 29,
        nodes: [{ id: "m_event_first", sourceSeq: 1, role: "user", text: "event first recovery" }],
      })
      const operationID = ContextSurface.asyncCompactionOperationID(base, "test-provider/v1")
      const candidateDigest = "b".repeat(64)
      const makeCheckpoint = checkpointFor(base, operationID)
      for (const [sequence, phase] of [
        [1, "prepared"],
        [2, "summarizing"],
        [3, "summarized"],
        [4, "revalidated"],
      ] as const)
        yield* SessionCompactionCheckpoint.append(
          db,
          sessionID,
          makeCheckpoint({ phase, sequence, ...(sequence >= 3 ? { candidateDigest } : {}) }),
          invariants,
        )

      const blockedBase = ContextSurface.make({
        epoch: 30,
        nodes: [{ id: "m_provider_only", sourceSeq: 1, role: "user", text: "provider still running" }],
      })
      const blockedOperationID = ContextSurface.asyncCompactionOperationID(blockedBase, "test-provider/v1")
      const blockedCheckpoint = checkpointFor(blockedBase, blockedOperationID)
      yield* SessionCompactionCheckpoint.append(
        db,
        sessionID,
        blockedCheckpoint({ phase: "prepared", sequence: 1 }),
        invariants,
      )
      yield* SessionCompactionCheckpoint.append(
        db,
        sessionID,
        blockedCheckpoint({ phase: "summarizing", sequence: 2 }),
        invariants,
      )

      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: SessionMessage.ID.make("msg_event_first_recovery"),
        timestamp: DateTime.makeUnsafe(3),
        reason: "auto",
        text: "Event-first summary",
        recent: "",
        operationID,
        candidateDigest,
      })
      const recovered = yield* SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants)
      expect(recovered.settled).toEqual([operationID])
      expect(recovered.blocked).toEqual([
        {
          operationID: blockedOperationID,
          status: "in_flight",
          lastPhase: "summarizing",
        },
      ])
      expect(
        (yield* SessionCompactionCheckpoint.load(db, sessionID, operationID, invariants)).map(
          (checkpoint) => checkpoint.phase,
        ),
      ).toEqual(["prepared", "summarizing", "summarized", "revalidated", "committed", "closed"])
      expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, blockedOperationID, invariants)).toBe(
        "in_flight",
      )
    }),
  )

  recoveryIt.effect("recovers an event-first settlement when committed checkpoint append fails", () =>
    Effect.gen(function* () {
      yield* createSession
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const invariants = yield* RuntimeInvariants.Service
      const base = ContextSurface.make({
        epoch: 31,
        nodes: [
          {
            id: "m_append_failure_old",
            sourceSeq: 1,
            role: "user",
            text: "old context that can be summarized ".repeat(80),
          },
          { id: "m_append_failure_recent", sourceSeq: 2, role: "user", text: "keep this recent request" },
        ],
      })
      const store = new ContextSurface.SurfaceStore(base.nodes, { epoch: base.epoch })
      const providerRevision = "event-first-append-failure/v1"
      const operationID = ContextSurface.asyncCompactionOperationID(base, providerRevision)
      let providerCalls = 0
      let failCommittedAppend = true
      const checkpointStore: SessionCompaction.CheckpointStore = {
        append: (session, checkpoint) => {
          if (failCommittedAppend && checkpoint.phase === "committed") {
            failCommittedAppend = false
            return Effect.die(new Error("fixture committed checkpoint append failure"))
          }
          return SessionCompactionCheckpoint.append(db, session, checkpoint, invariants)
        },
        reconcile: (session, operation) => SessionCompactionCheckpoint.reconcile(db, session, operation, invariants),
        recoverPublished: (session) => SessionCompactionCheckpoint.recoverPublished(db, events, session, invariants),
      }

      const failed = yield* SessionCompaction.runTransactional(
        { events, invariants, checkpoints: checkpointStore },
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_append_failure"),
          reason: "auto",
          store,
          recentTokenBudget: 20,
          recent: "keep this recent request",
          anchors: {
            objective: "Preserve the task",
            policy: "Keep exact facts",
            protectedFacts: [],
          },
          provider: {
            revision: providerRevision,
            summarize: async () => {
              providerCalls += 1
              return "Short recovered summary"
            },
          },
        },
      ).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect(providerCalls).toBe(1)
      expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID, invariants)).toBe("in_flight")

      const recovered = yield* SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants)
      expect(recovered.settled).toEqual([operationID])
      expect(recovered.blocked).toEqual([])
      expect(
        (yield* SessionCompactionCheckpoint.load(db, sessionID, operationID, invariants)).map(
          (checkpoint) => checkpoint.phase,
        ),
      ).toEqual(["prepared", "summarizing", "summarized", "revalidated", "committed", "closed"])
      expect(yield* SessionCompactionCheckpoint.reconcile(db, sessionID, operationID, invariants)).toBe("committed")
      expect(yield* SessionCompactionCheckpoint.recoverPublished(db, events, sessionID, invariants)).toEqual({
        settled: [],
        blocked: [],
      })
      expect(providerCalls).toBe(1)
    }),
  )

  invariantIt.effect("rolls back before persistence when the shared checkpoint invariant rejects", () =>
    Effect.gen(function* () {
      yield* createSession
      const db = (yield* Database.Service).db
      const invariants = yield* RuntimeInvariants.Service
      invariants.register({
        owner: "session-compaction",
        key: "checkpoint-prefix",
        version: "1",
        cost: "cheap",
        check: () => Effect.fail(new Error("forced checkpoint rejection")),
      })
      const base = ContextSurface.make({
        epoch: 19,
        nodes: [{ id: "m_invariant", sourceSeq: 1, role: "user", text: "transactional context" }],
      })
      const operationID = ContextSurface.asyncCompactionOperationID(base, "test-provider/v1")
      const prepared = checkpointFor(base, operationID)({ sequence: 1, phase: "prepared" })

      const exit = yield* SessionCompactionCheckpoint.append(db, sessionID, prepared, invariants).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const rows = yield* db
        .select()
        .from(SessionCompactionCheckpointTable)
        .where(
          and(
            eq(SessionCompactionCheckpointTable.session_id, sessionID),
            eq(SessionCompactionCheckpointTable.operation_id, operationID),
          ),
        )
        .all()
      expect(rows).toHaveLength(0)
      expect(invariants.get("session-compaction", "recovery-status", "1")).toBeDefined()
    }),
  )
})
