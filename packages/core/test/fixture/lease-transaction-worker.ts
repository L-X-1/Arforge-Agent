// Test-only independent process over one temporary SQLite database.
const [databasePath, mode, storedRunID] = Bun.argv.slice(2)
if (!databasePath || !["holder", "contender"].includes(mode ?? "")) throw new Error("Invalid lease fixture arguments")
process.env.ARFORGE_DB = databasePath
process.env.ARFORGE_DB_URL = ""
process.env.ARFORGE_DB_ADMIN_URL = ""
process.env.ARFORGE_HOME = databasePath.slice(
  0,
  Math.max(databasePath.lastIndexOf("/"), databasePath.lastIndexOf("\\")),
)
const commands: unknown[] = []
let receive: ((command: unknown) => void) | undefined
process.on("message", (command: unknown) => {
  if (receive) {
    const notify = receive
    receive = undefined
    notify(command)
  } else commands.push(command)
})
const command = () =>
  commands.length
    ? Promise.resolve(commands.shift())
    : new Promise<unknown>((resolve) => {
        receive = resolve
      })
const send = (event: string, value: unknown) => process.send?.({ event, value })
const { Effect, Exit, Cause } = await import("effect")
const { sql } = await import("drizzle-orm")
const { AppNodeBuilder } = await import("@arforge-ai/core/effect/app-node-builder")
const { LayerNode } = await import("@arforge-ai/core/effect/layer-node")
const { Database } = await import("@arforge-ai/core/database/database")
const { DurableRun } = await import("@arforge-ai/core/runtime/durable-run")
const { EventV2 } = await import("@arforge-ai/core/event")
const { AgentRuntime } = await import("@arforge-ai/schema/agent-runtime")
const { SessionSchema } = await import("@arforge-ai/core/session/schema")
const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, DurableRun.node]))
await Effect.runPromise(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const runtime = yield* DurableRun.Service
    const { db } = database
    let runID = storedRunID ? AgentRuntime.RunID.make(storedRunID) : undefined
    if (mode === "holder") {
      yield* db.run(sql`CREATE TABLE lease_commit_probe (value INTEGER NOT NULL)`).pipe(Effect.orDie)
      const created = yield* runtime.create({
        sessionID: SessionSchema.ID.create(),
        initiator: "user",
        authority: "automatic",
        riskTier: "L0",
        reasonSummary: "test cross-process transaction lock",
        traceID: "lease-lock-fixture",
        visibility: "details",
        budget: AgentRuntime.Budget.make({
          maxAttempts: 3,
          maxDurationMs: 60_000,
          maxCostMicros: 1000,
          maxTokens: 1000,
          attemptsUsed: 0,
          durationMsUsed: 0,
          costMicrosUsed: 0,
          tokensUsed: 0,
        }),
      })
      runID = created.run.id
      yield* runtime.acquireLease({ runID, ownerID: "original-owner", ttlMs: 60_000 })
    }
    if (!runID) throw new Error("Missing fixture run ID")
    const before = yield* runtime.load(runID)
    if (!before.lease) throw new Error("Missing original lease")
    const binding = { runID, leaseID: before.lease.id, ownerID: before.lease.ownerID }
    // Fail promptly on actual lock contention; no sleep-based readiness inference.
    yield* db.run(sql`PRAGMA busy_timeout = 0`).pipe(Effect.orDie)
    send("ready", runID)
    if (mode === "holder") {
      if ((yield* Effect.promise(command)) !== "hold") throw new Error("Expected hold command")
      const held = yield* database
        .transactionAsPrincipal(Database.DefaultLocalPrincipal, (transaction) =>
          Effect.gen(function* () {
            yield* runtime.validateLease({ ...binding, transaction })
            send("locked", true)
            const finish = yield* Effect.promise(command)
            // Write after the competitor's attempt: proves the lock itself, not this
            // probe insert, prevented takeover while the transaction was suspended.
            yield* transaction.run(sql`INSERT INTO lease_commit_probe(value) VALUES (1)`).pipe(Effect.orDie)
            if (finish === "rollback") yield* Effect.fail("fixture rollback")
            if (finish !== "commit") throw new Error("Unexpected transaction command")
          }),
        )
        .pipe(Effect.exit)
      send("result", {
        committed: Exit.isSuccess(held),
        rows: yield* db.all(sql`SELECT value FROM lease_commit_probe`).pipe(Effect.orDie),
      })
    } else {
      if ((yield* Effect.promise(command)) !== "contend") throw new Error("Expected contender command")
      const attempted = yield* runtime.releaseLease({ ...binding, reason: "competing process" }).pipe(Effect.exit)
      if (Exit.isSuccess(attempted) || !Cause.pretty(attempted.cause).toLowerCase().includes("locked"))
        throw new Error("Lease takeover did not encounter the held SQLite lock")
      const unchanged = JSON.stringify(yield* runtime.load(runID)) === JSON.stringify(before)
      const probe = yield* db.all(sql`SELECT value FROM lease_commit_probe`).pipe(Effect.orDie)
      send("blocked", { unchanged, probe })
      if ((yield* Effect.promise(command)) !== "retry") throw new Error("Expected retry command")
      yield* runtime.releaseLease({ ...binding, reason: "after holder transaction ended" })
      const replacement = yield* runtime.acquireLease({ runID, ownerID: "replacement-owner", ttlMs: 60_000 })
      send("result", {
        ownerID: replacement.lease?.ownerID,
        rows: yield* db.all(sql`SELECT value FROM lease_commit_probe`).pipe(Effect.orDie),
      })
    }
  }).pipe(Effect.provide(layer), Effect.scoped),
)
process.disconnect?.()
