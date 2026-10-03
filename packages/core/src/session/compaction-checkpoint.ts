export * as SessionCompactionCheckpoint from "./compaction-checkpoint"

import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { SessionDurable } from "@arforge-ai/schema/durable-event-manifest"
import type { Database } from "../database/database"
import * as ContextSurface from "../context-surface"
import { EventV2 } from "../event"
import * as RuntimeInvariants from "../runtime/invariants"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionCompactionCheckpointTable } from "./sql"

type DatabaseService = Database.Interface["db"]
const RECOVERY_EVENT_LIMIT = 100_000

/**
 * Deterministic crash probes are opt-in and never active in a normal process.
 * The acceptance flag keeps a stray environment variable from terminating a
 * user's running Arforge instance; the phase value selects the checkpoint
 * append boundary exercised by a disposable child process.
 */
const testCompactionCrashBoundary = (phase: ContextSurface.AsyncCompactionPhase): boolean =>
  process.env.ARFORGE_DESKTOP_ISOLATED_ACCEPTANCE === "1" && process.env.ARFORGE_TEST_COMPACTION_CRASH_PHASE === phase

const crashAfterCheckpointForTest = (phase: ContextSurface.AsyncCompactionPhase): void => {
  if (testCompactionCrashBoundary(phase)) process.kill(process.pid, "SIGKILL")
}

export type RecoveryOperation = Readonly<{
  readonly operationID: string
  readonly status: ContextSurface.AsyncCompactionRecoveryStatus
  readonly lastPhase: ContextSurface.AsyncCompactionPhase
  readonly candidateDigest?: string
}>

export type RecoveryReport = Readonly<{
  readonly settled: ReadonlyArray<string>
  readonly blocked: ReadonlyArray<RecoveryOperation>
}>

const encode = (checkpoint: ContextSurface.AsyncCompactionCheckpoint) => JSON.stringify(checkpoint)

const decode = (value: unknown): ContextSurface.AsyncCompactionCheckpoint => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  return ContextSurface.decodeAsyncCompactionCheckpoint(parsed)
}

type CompactionCheckpointInvariantContext =
  | {
      readonly kind: "checkpoint-prefix"
      readonly checkpoints: ReadonlyArray<ContextSurface.AsyncCompactionCheckpoint>
    }
  | {
      readonly kind: "recovery-status"
      readonly checkpoints: ReadonlyArray<ContextSurface.AsyncCompactionCheckpoint>
      readonly status: ContextSurface.AsyncCompactionRecoveryStatus
    }

/** Register durable compaction evidence checks into the shared registry. */
export const registerInvariants = (registry: RuntimeInvariants.RuntimeInvariantRegistry): void => {
  if (!registry.get("session-compaction", "checkpoint-prefix", "1"))
    registry.register({
      owner: "session-compaction",
      key: "checkpoint-prefix",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as CompactionCheckpointInvariantContext).kind !== "checkpoint-prefix"
          )
            throw new Error("compaction checkpoint invariant context is invalid")
          const checkpoints = (
            context as Extract<CompactionCheckpointInvariantContext, { readonly kind: "checkpoint-prefix" }>
          ).checkpoints
          ContextSurface.verifyAsyncCompactionCheckpointPrefix(checkpoints)
          const candidateDigests = new Set(
            checkpoints.flatMap((checkpoint) =>
              checkpoint.candidateDigest === undefined ? [] : [checkpoint.candidateDigest],
            ),
          )
          if (candidateDigests.size > 1) throw new Error("compaction candidate digest drifted across checkpoints")
        }),
    })
  if (!registry.get("session-compaction", "recovery-status", "1"))
    registry.register({
      owner: "session-compaction",
      key: "recovery-status",
      version: "1",
      cost: "cheap",
      check: (context) =>
        Effect.sync(() => {
          if (
            context === null ||
            typeof context !== "object" ||
            Array.isArray(context) ||
            (context as CompactionCheckpointInvariantContext).kind !== "recovery-status"
          )
            throw new Error("compaction recovery invariant context is invalid")
          const value = context as Extract<CompactionCheckpointInvariantContext, { readonly kind: "recovery-status" }>
          const classified = ContextSurface.classifyAsyncCompaction(value.checkpoints)
          if (classified !== value.status) throw new Error("compaction recovery status disagrees with checkpoint chain")
        }),
    })
}

const runtimeInvariantMode = (): RuntimeInvariants.InvariantMode =>
  process.env.NODE_ENV === "production" ? "production" : process.env.NODE_ENV === "test" ? "test" : "development"

const assertCompactionInvariant = (
  registry: RuntimeInvariants.RuntimeInvariantRegistry,
  key: "checkpoint-prefix" | "recovery-status",
  context: CompactionCheckpointInvariantContext,
) =>
  registry
    .assert(context, { owner: "session-compaction", key, mode: runtimeInvariantMode() })
    .pipe(Effect.orDie, Effect.asVoid)

/**
 * Persist one immutable checkpoint. Replaying the same sequence is idempotent
 * only when its JSON is byte-for-byte equivalent; a divergent replay fails
 * closed instead of overwriting evidence.
 */
export const append = Effect.fn("SessionCompactionCheckpoint.append")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  checkpoint: ContextSurface.AsyncCompactionCheckpoint,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  if (invariants) registerInvariants(invariants)
  const validated = ContextSurface.decodeAsyncCompactionCheckpoint(checkpoint)
  const checkpointJSON = encode(validated)
  if (validated.operationID.length === 0) return yield* Effect.die("Compaction checkpoint operation ID is required")

  yield* db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .select()
            .from(SessionCompactionCheckpointTable)
            .where(
              and(
                eq(SessionCompactionCheckpointTable.session_id, sessionID),
                eq(SessionCompactionCheckpointTable.operation_id, validated.operationID),
              ),
            )
            .orderBy(asc(SessionCompactionCheckpointTable.sequence))
            .all()
            .pipe(Effect.orDie)
          const persisted = rows.map((row) => {
            const current = decode(row.checkpoint)
            if (current.operationID !== validated.operationID)
              throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint operation identity drifted")
            if (row.phase !== current.phase || row.sequence !== current.sequence)
              throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint index drifted")
            return current
          })
          if (persisted.length > 0) ContextSurface.verifyAsyncCompactionCheckpointPrefix(persisted)
          const existing = rows.find((row) => row.sequence === validated.sequence)
          if (existing) {
            const existingJSON = encode(decode(existing.checkpoint))
            if (existingJSON !== checkpointJSON)
              return yield* Effect.die("Compaction checkpoint replay diverged at an existing sequence")
            if (invariants)
              yield* assertCompactionInvariant(invariants, "checkpoint-prefix", {
                kind: "checkpoint-prefix",
                checkpoints: Object.freeze([...persisted]),
              })
            return
          }

          const expected = persisted.at(-1)?.sequence ?? 0
          if (validated.sequence !== expected + 1)
            return yield* Effect.die(
              `Compaction checkpoint sequence is not append-only (expected ${expected + 1}, got ${validated.sequence})`,
            )
          const candidate = Object.freeze([...persisted, validated])
          ContextSurface.verifyAsyncCompactionCheckpointPrefix(candidate)
          if (invariants)
            yield* assertCompactionInvariant(invariants, "checkpoint-prefix", {
              kind: "checkpoint-prefix",
              checkpoints: candidate,
            })

          yield* tx
            .insert(SessionCompactionCheckpointTable)
            .values({
              session_id: sessionID,
              operation_id: validated.operationID,
              sequence: validated.sequence,
              phase: validated.phase,
              checkpoint: validated,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)

  // The transaction has committed before this hook runs. A disposable
  // acceptance worker can therefore terminate at every semantic checkpoint
  // without changing production behavior or introducing a runtime fault
  // mode. Recovery must classify the durable prefix in a fresh process.
  yield* Effect.sync(() => crashAfterCheckpointForTest(validated.phase))
})

/** Load and strictly verify one persisted chain prefix. */
export const load = Effect.fn("SessionCompactionCheckpoint.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  operationID: string,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  if (invariants) registerInvariants(invariants)
  const rows = yield* db
    .select()
    .from(SessionCompactionCheckpointTable)
    .where(
      and(
        eq(SessionCompactionCheckpointTable.session_id, sessionID),
        eq(SessionCompactionCheckpointTable.operation_id, operationID),
      ),
    )
    .orderBy(asc(SessionCompactionCheckpointTable.sequence))
    .all()
    .pipe(Effect.orDie)
  const checkpoints = rows.map((row) => {
    const checkpoint = decode(row.checkpoint)
    if (checkpoint.operationID !== operationID)
      throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint operation identity drifted")
    if (row.phase !== checkpoint.phase || row.sequence !== checkpoint.sequence)
      throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint index drifted")
    return checkpoint
  })
  if (checkpoints.length === 0) return Object.freeze([]) as ReadonlyArray<ContextSurface.AsyncCompactionCheckpoint>
  const verified = ContextSurface.verifyAsyncCompactionCheckpointPrefix(checkpoints)
  if (invariants)
    yield* assertCompactionInvariant(invariants, "checkpoint-prefix", {
      kind: "checkpoint-prefix",
      checkpoints: verified,
    })
  return verified
})

/** Classify a persisted prefix without authorizing a retry or repair. */
export const reconcile = Effect.fn("SessionCompactionCheckpoint.reconcile")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  operationID: string,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  if (invariants) registerInvariants(invariants)
  const checkpoints = yield* load(db, sessionID, operationID, invariants)
  const status = ContextSurface.classifyAsyncCompaction(checkpoints)
  if (invariants)
    yield* assertCompactionInvariant(invariants, "recovery-status", {
      kind: "recovery-status",
      checkpoints,
      status,
    })
  return status
})

/** Enumerate strictly verified operation prefixes for one Session. The
 * projection is metadata-only and does not expose summary text or source
 * messages. */
export const scan = Effect.fn("SessionCompactionCheckpoint.scan")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  if (invariants) registerInvariants(invariants)
  const rows = yield* db
    .select()
    .from(SessionCompactionCheckpointTable)
    .where(eq(SessionCompactionCheckpointTable.session_id, sessionID))
    .orderBy(asc(SessionCompactionCheckpointTable.operation_id), asc(SessionCompactionCheckpointTable.sequence))
    .all()
    .pipe(Effect.orDie)
  const grouped = new Map<string, ContextSurface.AsyncCompactionCheckpoint[]>()
  for (const row of rows) {
    const checkpoint = decode(row.checkpoint)
    if (checkpoint.operationID !== row.operation_id)
      throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint operation identity drifted")
    if (row.phase !== checkpoint.phase || row.sequence !== checkpoint.sequence)
      throw new ContextSurface.ContextSurfaceError("Persisted compaction checkpoint index drifted")
    const current = grouped.get(checkpoint.operationID) ?? []
    current.push(checkpoint)
    grouped.set(checkpoint.operationID, current)
  }

  const operations: RecoveryOperation[] = []
  for (const [operationID, checkpoints] of grouped) {
    const verified = ContextSurface.verifyAsyncCompactionCheckpointPrefix(checkpoints)
    if (invariants)
      yield* assertCompactionInvariant(invariants, "checkpoint-prefix", {
        kind: "checkpoint-prefix",
        checkpoints: verified,
      })
    const last = verified.at(-1)!
    const status = ContextSurface.classifyAsyncCompaction(verified)
    if (invariants)
      yield* assertCompactionInvariant(invariants, "recovery-status", {
        kind: "recovery-status",
        checkpoints: verified,
        status,
      })
    operations.push(
      Object.freeze({
        operationID,
        status,
        lastPhase: last.phase,
        ...(last.candidateDigest === undefined ? {} : { candidateDigest: last.candidateDigest }),
      }),
    )
  }
  return Object.freeze(operations)
})

/** Promote a Session settlement that is already durably published into the
 * remaining semantic checkpoint facts. A unique checkpoint primary key and
 * exact replay comparison make concurrent recovery idempotent. */
export const settlePublished = Effect.fn("SessionCompactionCheckpoint.settlePublished")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  evidence: Readonly<{ readonly operationID: string; readonly candidateDigest: string }>,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  let checkpoints = yield* load(db, sessionID, evidence.operationID, invariants)
  if (checkpoints.length === 0)
    return yield* Effect.die(`Compaction settlement has no checkpoint prefix: ${evidence.operationID}`)
  let last = checkpoints.at(-1)!
  if (last.candidateDigest !== evidence.candidateDigest)
    return yield* Effect.die(`Compaction settlement candidate digest mismatch: ${evidence.operationID}`)
  const status = ContextSurface.classifyAsyncCompaction(checkpoints)
  if (status === "committed") return false
  if (status === "noop" || status === "aborted")
    return yield* Effect.die(`Terminal compaction cannot accept settlement evidence: ${evidence.operationID}`)
  if (last.phase !== "revalidated" && last.phase !== "committed")
    return yield* Effect.die(`Compaction checkpoint is not settlement-ready: ${evidence.operationID}`)

  if (last.phase === "revalidated") {
    const committed: ContextSurface.AsyncCompactionCheckpoint = Object.freeze({
      ...last,
      sequence: last.sequence + 1,
      phase: "committed",
      reason: "compacted",
    })
    yield* append(db, sessionID, committed, invariants)
    checkpoints = Object.freeze([...checkpoints, committed])
    last = committed
  }
  const closed: ContextSurface.AsyncCompactionCheckpoint = Object.freeze({
    ...last,
    sequence: last.sequence + 1,
    phase: "closed",
    reason: "compacted",
  })
  yield* append(db, sessionID, closed, invariants)
  return true
})

/** Reconcile only from a matching durable Compaction.Ended fact. An unfinished
 * provider call or a committed checkpoint without its Session event remains
 * blocked and is never retried automatically. */
export const recoverPublished = Effect.fn("SessionCompactionCheckpoint.recoverPublished")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  invariants?: RuntimeInvariants.RuntimeInvariantRegistry,
) {
  const operations = yield* scan(db, sessionID, invariants)
  const blocked = operations.filter(
    (operation) => operation.status === "in_flight" || operation.status === "completed_unsettled",
  )
  const settlementReady = blocked.filter(
    (operation) => operation.lastPhase === "revalidated" || operation.lastPhase === "committed",
  )
  if (settlementReady.length === 0)
    return { settled: Object.freeze([]), blocked: Object.freeze(blocked) } satisfies RecoveryReport

  const history = yield* EventV2.readAggregate(db, {
    aggregateID: sessionID,
    limit: RECOVERY_EVENT_LIMIT,
    strict: true,
    manifest: SessionDurable,
  })
  if (history.hasMore)
    return yield* Effect.die(`Compaction settlement scan exceeded ${RECOVERY_EVENT_LIMIT} Session events`)

  const publications = new Map<string, string>()
  for (const event of history.events) {
    if (event.type !== SessionEvent.Compaction.Ended.type) continue
    const operationID = event.data.operationID
    const candidateDigest = event.data.candidateDigest
    if (operationID === undefined && candidateDigest === undefined) continue
    if (operationID === undefined || candidateDigest === undefined)
      return yield* Effect.die("Compaction settlement event identity is incomplete")
    if (publications.has(operationID))
      return yield* Effect.die(`Compaction settlement event is duplicated: ${operationID}`)
    publications.set(operationID, candidateDigest)
  }

  const settled: string[] = []
  for (const operation of settlementReady) {
    const publishedDigest = publications.get(operation.operationID)
    if (publishedDigest === undefined) continue
    if (operation.candidateDigest !== publishedDigest)
      return yield* Effect.die(`Compaction settlement event digest mismatch: ${operation.operationID}`)
    yield* settlePublished(
      db,
      sessionID,
      { operationID: operation.operationID, candidateDigest: publishedDigest },
      invariants,
    )
    settled.push(operation.operationID)
  }
  const settledIDs = new Set(settled)
  return {
    settled: Object.freeze(settled),
    blocked: Object.freeze(blocked.filter((operation) => !settledIDs.has(operation.operationID))),
  } satisfies RecoveryReport
})
