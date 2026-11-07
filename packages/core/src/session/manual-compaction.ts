import { LLM, LLMClient } from "@arforge-ai/llm"
import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { Config } from "../config"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import * as RuntimeInvariants from "../runtime/invariants"
import { canonicalHash } from "../util/canonical-hash"
import { SessionCompaction } from "./compaction"
import { SessionCompactionCheckpoint } from "./compaction-checkpoint"
import { SessionExecution } from "./execution"
import { SessionHistory } from "./history"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionRunnerModel } from "./runner/model"
import { SessionContextEpochTable, SessionTable } from "./sql"
import { SessionStore } from "./store"

const unavailable = () => new SessionExecution.OperationError({ operation: "compact", reason: "unavailable", message: "Compaction did not commit a complete summary; inspect its checkpoint evidence before retrying" })
const stale = () => new SessionExecution.OperationError({ operation: "compact", reason: "conflict", message: "Compaction source or context changed; reopen the context preview" })

/** Called under the existing exclusive execution slot and captured location/principal. No second runner or V1 marker. */
export const run = Effect.fn("SessionManualCompaction.run")(function* (input: SessionExecution.CompactInput) {
  const database = yield* Database.Service
  const { db } = database
  const events = yield* EventV2.Service
  const sessions = yield* SessionStore.Service
  const models = yield* SessionRunnerModel.Service
  const config = yield* Config.Service
  const llm = yield* LLMClient.Service
  const invariants = yield* RuntimeInvariants.Service
  const principal = (yield* Database.CurrentPrincipal) ?? Database.DefaultLocalPrincipal
  const owned = () => db.select({ id: SessionTable.id }).from(SessionTable).where(and(
    eq(SessionTable.id, input.sessionID), eq(SessionTable.tenant_id, principal.tenantID), eq(SessionTable.owner_user_id, principal.userID),
  )).get().pipe(Effect.orDie)
  if (!(yield* owned())) return yield* stale()
  const session = yield* sessions.get(input.sessionID)
  if (!session || (input.expectedDirectory !== undefined && input.expectedDirectory !== session.location.directory)) return yield* stale()
  const encode = Schema.encodeSync(Schema.Array(SessionMessage.Message))
  const context = yield* sessions.context(input.sessionID)
  const fingerprint = canonicalHash(encode(context))
  if (input.expectedContext !== undefined) {
    const expected = yield* Effect.try({ try: () => JSON.parse(input.expectedContext!), catch: () => new SessionExecution.OperationError({ operation: "compact", reason: "invalid", message: "Invalid captured context projection" }) })
    if (canonicalHash(expected) !== fingerprint) return yield* stale()
  }
  const sourceCurrent = () => Effect.gen(function* () {
    if (!(yield* owned())) return false
    const current = yield* sessions.get(input.sessionID)
    if (!current || canonicalHash(current.location) !== canonicalHash(session.location)) return false
    if ((yield* SessionInput.listPending(db, input.sessionID, "steer")).length || (yield* SessionInput.listPending(db, input.sessionID, "queue")).length) return false
    return canonicalHash(encode(yield* sessions.context(input.sessionID))) === fingerprint
  }).pipe(Effect.orDie)
  if (!(yield* sourceCurrent())) return yield* stale()
  const epoch = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, input.sessionID)).get().pipe(Effect.orDie)
  const entries = yield* SessionHistory.entriesForRunner(db, input.sessionID, epoch?.baseline_seq ?? -1)
  // Revalidate after all reads and before resolving any provider credential.
  if (!(yield* sourceCurrent())) return yield* stale()
  const model = yield* models.resolve({ ...session, ...(input.model ? { model: input.model } : {}) })
  const compaction = SessionCompaction.make({
    db, events, llm, invariants, config: yield* config.entries(),
    checkpoints: {
      append: (id, checkpoint) => SessionCompactionCheckpoint.append(db, id, checkpoint, invariants),
      reconcile: (id, operationID) => SessionCompactionCheckpoint.reconcile(db, id, operationID, invariants),
      recoverPublished: id => SessionCompactionCheckpoint.recoverPublished(db, events, id, invariants),
    },
    commit: settle => db.transaction(() => Effect.gen(function* () {
      if (!(yield* sourceCurrent())) return yield* stale()
      // Keep the source check and durable summary projection in one transaction.
      yield* settle
    })).pipe(Effect.orDie),
  })
  const committed = yield* compaction.compactManual({
    sessionID: input.sessionID, entries, model,
    request: LLM.request({ model, messages: [], tools: [] }),
    surfaceEpoch: epoch?.baseline_seq ?? 0,
    sourceCurrent,
    executeProvider: ({ execute }) => SessionRunnerModel.validateCredential(model).pipe(Effect.andThen(execute), Effect.as(0)),
  })
  if (!committed) {
    if (!(yield* sourceCurrent())) return yield* stale()
    return yield* unavailable()
  }
})

export class Service extends Context.Service<Service, {
  readonly run: (input: SessionExecution.CompactInput) => Effect.Effect<void, Effect.Error<ReturnType<typeof run>>>
}>()("@arforge/SessionManualCompaction") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const sessions = yield* SessionStore.Service
  const models = yield* SessionRunnerModel.Service
  const config = yield* Config.Service
  const llm = yield* LLMClient.Service
  const invariants = yield* RuntimeInvariants.Service
  // Supply services individually; never replace the caller's principal or
  // transaction-effects context with a cached location construction context.
  return Service.of({ run: input => run(input).pipe(
    Effect.provideService(Database.Service, database), Effect.provideService(EventV2.Service, events),
    Effect.provideService(SessionStore.Service, sessions), Effect.provideService(SessionRunnerModel.Service, models),
    Effect.provideService(Config.Service, config), Effect.provideService(LLMClient.Service, llm),
    Effect.provideService(RuntimeInvariants.Service, invariants),
  ) })
}))

export const node = makeLocationNode({
  service: Service, layer,
  deps: [Database.node, EventV2.node, SessionStore.node, SessionRunnerModel.node, Config.node, llmClient, RuntimeInvariants.node],
})
