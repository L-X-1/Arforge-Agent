import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@arforge-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@arforge-ai/core/database/migration"
import { migrations } from "@arforge-ai/core/database/migration.gen"
import { read as readKernel } from "@arforge-ai/core/memory/kernel-reader"
import { Memory } from "@arforge-ai/schema/memory"
import * as MemoryRetention from "@arforge-ai/schema/memory-retention"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const kernelMigration = migrations.find((migration) => migration.id === "20260812045709_memory_kernel_persistence")!
const legacyMigrations = migrations.filter((migration) => migration.id !== kernelMigration.id)
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
type Backup = { readonly id: string; readonly content: string; readonly source: string }
const isBackup = (value: unknown): value is Backup => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "content" in value &&
    typeof value.content === "string" &&
    "source" in value &&
    typeof value.source === "string"
  )
}
const parseBackup = (value: string): Backup => {
  const parsed: unknown = JSON.parse(value)
  if (!isBackup(parsed)) throw new Error("invalid memory backup")
  return { id: parsed.id, content: parsed.content, source: parsed.source }
}

describe("Memory Step 5.11 additive migration", () => {
  test("backfills legacy lifecycle metadata, preserves rows, and records a restorable ledger", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE memory (
            tenant_id TEXT NOT NULL DEFAULT 'ten_local',
            owner_user_id TEXT NOT NULL DEFAULT 'usr_local',
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            type TEXT NOT NULL,
            tags TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL,
            scope TEXT NOT NULL,
            project_id TEXT,
            workspace_path TEXT,
            related_to TEXT,
            strength REAL NOT NULL DEFAULT 0.5,
            review_level INTEGER NOT NULL DEFAULT 0,
            time_reviewed INTEGER,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL
          )
        `)
        yield* Effect.forEach(legacyMigrations, (migration) =>
          db.run(sql`INSERT INTO migration (id, time_completed) VALUES (${migration.id}, 1)`),
        )
        yield* db.run(sql`
          INSERT INTO memory (
            tenant_id, owner_user_id, id, content, type, tags, importance, source, scope,
            strength, review_level, time_created, time_updated
          ) VALUES (
            'ten_local', 'usr_local', 'mem_legacy', 'legacy fact', 'fact', '[]', 2, 'quarantined:model', 'global',
            0.5, 0, 10, 10
          )
        `)
        const before = yield* db.get<{ id: string; content: string; source: string }>(sql`
          SELECT id, content, source FROM memory WHERE id = 'mem_legacy'
        `)
        if (!before) throw new Error("legacy fixture was not created")
        const backup = JSON.stringify(before)
        const backupDigest = digest(before)
        const beforeCount = yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM memory`)

        yield* DatabaseMigration.applyOnly(db, [kernelMigration])

        const after = yield* db.get<{
          id: string
          content: string
          source: Memory.Source
          lifecycle: MemoryRetention.Lifecycle
          memory_version: number
          provenance_status: "legacy_unknown" | "verified"
          retention_mode: MemoryRetention.RetentionMode
        }>(sql`
          SELECT id, content, source, lifecycle, memory_version, provenance_status, retention_mode
          FROM memory WHERE id = 'mem_legacy'
        `)
        const afterCount = yield* db.get<{ count: number }>(sql`SELECT COUNT(*) AS count FROM memory`)
        const ledger = yield* db.get<{ id: string }>(sql`SELECT id FROM migration WHERE id = ${kernelMigration.id}`)
        const columns = yield* db.all<{ name: string }>(sql`PRAGMA table_info(memory)`)
        const candidateTable = yield* db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_candidate'`)
        const revisionTable = yield* db.get<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_revision'`)
        if (!after || !beforeCount || !afterCount || !ledger || !candidateTable || !revisionTable) throw new Error("migration evidence row missing")

        const restored = parseBackup(backup)
        const restoredDigest = digest(restored)
        const kernel = readKernel({
          id: Memory.ID.make(after.id),
          content: Memory.Content.make(after.content),
          source: Memory.Source.make(after.source),
          scope: Memory.Scope.make("global"),
          lifecycle: MemoryRetention.Lifecycle.make(after.lifecycle),
          memory_version: after.memory_version,
          provenance_status: after.provenance_status === "verified" ? "verified" : "legacy_unknown",
          retention_mode: MemoryRetention.RetentionMode.make(after.retention_mode),
        })
        return {
          backupBytes: backup.length,
          backupDigest,
          restoredDigest,
          beforeCount: beforeCount.count,
          afterCount: afterCount.count,
          ledgerID: ledger.id,
          columns: columns.map((column) => column.name),
          candidateTable: candidateTable.name,
          revisionTable: revisionTable.name,
          kernel,
        }
      }),
    )

    expect(result.restoredDigest).toBe(result.backupDigest)
    expect(result.beforeCount).toBe(result.afterCount)
    expect(result.ledgerID).toBe(kernelMigration.id)
    expect(result.columns).toEqual(expect.arrayContaining(["lifecycle", "memory_version", "provenance_status", "retention_mode"]))
    expect(result.candidateTable).toBe("memory_candidate")
    expect(result.revisionTable).toBe("memory_revision")
    expect(result.kernel).toMatchObject({ lifecycle: "quarantined", version: 1, provenanceStatus: "legacy_unknown", retentionMode: "indefinite" })
  })
})
