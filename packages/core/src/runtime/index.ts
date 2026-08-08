export * as RuntimeCompiler from "./compiler"
export * as RuntimeEmbedding from "./embedding"
export * as RuntimeStrategy from "./strategy"
export * as RuntimeVerifier from "./verifier"
export * as RuntimeRouter from "./router"
export * from "./sql"
export * from "./insight"

import { RuntimeInsight } from "./insight"
import { AuditEntryTable, SessionRunTable } from "./sql"
import { desc } from "drizzle-orm"

// Structural adapter bound: this module only needs insert/select chains, and
// the host database may be Effect Drizzle or a plain SQLite client. The `any`
// parameters are deliberate to keep the boundary compatible with either.
type Db = {
  insert(table: any): {
    values(value: Record<string, unknown>): { run(): unknown }
  }
  select(): {
    from(table: any): {
      orderBy(column: any): { limit(count: number): { all(): Promise<unknown[]> | unknown[] | unknown } }
    }
  }
}

/**
 * Bridge the in-memory runtime insight to the database (best-effort).
 * Call once from a location that owns the Database service (e.g. the server
 * bootstrap). Audit persistence is append-only; run status is upserted.
 */
export function attachRuntimePersistence(db: Db): void {
  RuntimeInsight.attachPersistence({
    insertAudit: (entries) => {
      void Promise.all(
        entries.map((entry) =>
          db
            .insert(AuditEntryTable)
            .values({
              id: `audit_${entry.seq}_${entry.recordHash.slice(0, 8)}`,
              seq: entry.seq,
              recorded_at: entry.recordedAt,
              actor: entry.actor,
              action: entry.action,
              resource: entry.resource,
              reason: entry.reason ?? null,
              metadata: entry.metadata,
              previous_hash: entry.previousHash,
              record_hash: entry.recordHash,
            })
            .run(),
        ),
      ).catch(() => {
        // best-effort persistence; the in-memory chain remains authoritative
      })
    },
    upsertRun: (run) => {
      void db
        .insert(SessionRunTable)
        .values({
          id: run.runID,
          session_id: run.sessionID,
          status: run.status,
          started_at: run.startedAt,
          finished_at: run.finishedAt ?? 0,
          last_seq: run.lastSeq ?? 0,
          error: run.error,
        })
        .run()
    },
  })
}

export async function listPersistedRuns(db: Db, limit = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(SessionRunTable).orderBy(desc(SessionRunTable.started_at)).limit(limit).all()
  return rows as Array<Record<string, unknown>>
}
