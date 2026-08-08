import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { Database } from "@arforge-ai/core/database/database"
import { RuntimeInsight } from "@arforge-ai/core/runtime/insight"
import { attachRuntimePersistence } from "@arforge-ai/core/runtime"

export const RuntimeInsightHandler = HttpApiBuilder.group(Api, "server.runtimeInsight", (handlers) =>
  handlers
    .handle("runtimeInsight.snapshot", Effect.fn(function* (ctx) {
      const limit = Number(ctx.query.limit ?? "50")
      const bounded = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50
      const audit = RuntimeInsight.auditList(bounded)
      return {
        contextLayers: RuntimeInsight.contextLayers(20),
        routing: RuntimeInsight.routingDecisions(bounded),
        verifications: RuntimeInsight.verifications(bounded),
        audit: audit.entries.map((entry) => ({ ...entry, reason: entry.reason ?? null })),
        auditDropped: audit.dropped,
        auditVerify: RuntimeInsight.auditVerify(),
        runs: RuntimeInsight.runs(bounded),
        recalls: RuntimeInsight.memoryRecalls(bounded),
      }
    }))
    .handle("runtimeInsight.auditVerify", Effect.fn(function* () {
      return RuntimeInsight.auditVerify()
    })),
)

export const RuntimeInsightPersistence = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database.Service
    const client = db.db as {
      insert(table: unknown): { values(value: Record<string, unknown>): { run(): Effect.Effect<unknown, unknown, never> } }
      select(): {
        from(table: unknown): {
          orderBy(column: unknown): {
            limit(count: number): { all(): Effect.Effect<unknown[], unknown, never> }
          }
        }
      }
    }
    // Effect Drizzle query builders return Effects; run them at this boundary
    // so the best-effort persistence actually executes.
    const adapter = {
      insert: (table: unknown) => ({
        values: (value: Record<string, unknown>) => ({
          run: () => Effect.runPromise(client.insert(table).values(value).run()),
        }),
      }),
      select: () => ({
        from: (table: unknown) => ({
          orderBy: (column: unknown) => ({
            limit: (count: number) => ({
              all: () => Effect.runPromise(client.select().from(table).orderBy(column).limit(count).all()),
            }),
          }),
        }),
      }),
    }
    yield* Effect.sync(() => attachRuntimePersistence(adapter))
  }),
)
