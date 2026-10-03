import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@arforge-ai/core/database/database"
import { usesPostgres } from "@arforge-ai/core/database/dialect"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd, fail } from "../effect-cmd"

const DatabaseTargets = ["main", "multiagent"] as const

const CurrentCommand = effectCmd({
  command: "current [database]",
  describe: "read the applied TypeScript migration revision",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("database", {
        type: "string",
        choices: DatabaseTargets,
        default: "main",
        describe: "database target (only main has a TypeScript owner)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Output machine-readable JSON",
      }),
  handler: Effect.fn("Cli.db.current")(function* (args: { database: string; json: boolean }) {
    if (args.database === "multiagent") {
      return yield* fail(
        "db current multiagent is not owned by the TypeScript database runtime yet; use the migration compatibility command.",
        2,
      )
    }
    if (usesPostgres) {
      return yield* fail(
        "db current is a local SQLite ledger view; PostgreSQL revision inspection is still a deferred read-only contract.",
        2,
      )
    }
    const status = yield* Database.currentAtPath().pipe(Effect.orDie)
    if (args.json) {
      process.stdout.write(JSON.stringify({ database: "main", ...status }) + "\n")
      return
    }
    process.stdout.write(`main: ${status.current ?? "unversioned"}\n`)
  }),
})

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs.command(QueryCommand).command(PathCommand).command(CurrentCommand).demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
