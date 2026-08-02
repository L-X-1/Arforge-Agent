import { Database as SqliteDatabase } from "bun:sqlite"
import { PgClient } from "@effect/sql-pg"
import { Effect, Redacted } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

const url = process.env.ARFORGE_DB_URL?.trim()
if (!url) throw new Error("ARFORGE_DB_URL is required")

const sources = [
  join(homedir(), ".local", "share", "arforge", "arforge.db"),
  join(homedir(), ".local", "share", "arforge", "arforge-local.db"),
] as const

// Parent tables precede children so PostgreSQL foreign keys stay enabled.
const tables = ["project", "session", "message", "part", "event_sequence", "event"] as const
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`

const program = Effect.gen(function* () {
  const client = yield* PgClient.PgClient
  const imported: Record<string, number> = Object.fromEntries(tables.map((table) => [table, 0]))

  yield* client.withTransaction(
    Effect.gen(function* () {
      yield* client.unsafe(`
        CREATE TABLE IF NOT EXISTS arforge_sqlite_import (
          source text PRIMARY KEY,
          time_completed bigint NOT NULL
        )
      `)

      for (const source of sources) {
        const sqlite = new SqliteDatabase(source, { readonly: true })
        try {
          for (const table of tables) {
            const exists = sqlite
              .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(table)
            if (!exists) continue

            const rows = sqlite.query(`SELECT * FROM ${identifier(table)}`).all() as Array<Record<string, unknown>>
            for (const row of rows) {
              const columns = Object.keys(row)
              if (!columns.length) continue
              const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ")
              const result = yield* client.unsafe(
                `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")})
                 VALUES (${placeholders})
                 ON CONFLICT DO NOTHING
                 RETURNING 1 AS inserted`,
                columns.map((column) => row[column]),
              )
              imported[table] += result.length
            }
          }

          yield* client.unsafe(
            `INSERT INTO arforge_sqlite_import (source, time_completed)
             VALUES ($1, $2)
             ON CONFLICT (source) DO UPDATE SET time_completed = EXCLUDED.time_completed`,
            [source, Date.now()],
          )
        } finally {
          sqlite.close()
        }
      }
    }),
  )

  console.log(JSON.stringify({ backend: "postgresql", imported }))
})

await Effect.runPromise(program.pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })), Effect.scoped))
