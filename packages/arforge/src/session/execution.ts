import { makeGlobalNode } from "@arforge-ai/core/effect/app-node"
import { Database } from "@arforge-ai/core/database/database"
import { EventV2 } from "@arforge-ai/core/event"
import { SessionExecution } from "@arforge-ai/core/session/execution"
import { SessionInput } from "@arforge-ai/core/session/input"
import { SessionSchema } from "@arforge-ai/core/session/schema"
import { SessionTable } from "@arforge-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer, Scope } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"
import { SessionRunState } from "./run-state"
import { SessionID } from "./schema"

/**
 * Binds the durable Session API to the mature Arforge prompt runtime.
 *
 * SessionInput remains the canonical durable queue. This adapter deliberately
 * replaces the parallel V2 runner in the integrated server so one session can
 * never be drained by two independent execution loops.
 */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const state = yield* SessionRunState.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const inSessionInstance = <A, E, R>(sessionID: SessionSchema.ID, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const row = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die(new Error(`Session instance not found: ${sessionID}`))
        return yield* instances.provide({ directory: row.directory }, effect)
      })

    const run = (sessionID: SessionSchema.ID) =>
      inSessionInstance(
        sessionID,
        Effect.gen(function* () {
          // The mature loop owns execution, but V2 prompt admission owns the
          // durable input queue. Promote pending steering before entering the
          // mature loop so an idle V2 prompt is visible to both runtimes.
          const cutoff = yield* EventV2.latestSequence(db, sessionID)
          yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)
          yield* prompt.loop({ sessionID: SessionID.make(sessionID) })
        }),
      ).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logError("Failed to drain durable prompt queue", cause).pipe(Effect.annotateLogs({ sessionID })),
        ),
      )

    return SessionExecution.Service.of({
      active: state.active,
      resume: (sessionID) => run(sessionID),
      wake: (sessionID) => run(sessionID).pipe(Effect.forkIn(scope), Effect.asVoid),
      interrupt: (sessionID) =>
        inSessionInstance(sessionID, prompt.cancel(SessionID.make(sessionID))).pipe(Effect.asVoid),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [Database.node, EventV2Bridge.node, InstanceStore.node, SessionPrompt.node, SessionRunState.node],
})

export * as SessionExecutionMature from "./execution"
