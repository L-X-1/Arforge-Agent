import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge db-current Python compatibility (TS Core owner)", () => {
  cliIt.concurrent(
    "reports the read-only TypeScript migration ledger through both spellings",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const database = join(home, "db-current.sqlite")
        const env = { ARFORGE_DB: database, ARFORGE_DB_URL: "", ARFORGE_DB_ADMIN_URL: "" }

        const bootstrap = yield* arforge.spawn(["db", "select 1"], { env, timeoutMs: 60_000 })
        arforge.expectExit(bootstrap, 0, "db bootstrap")
        const beforeRead = yield* Effect.promise(() => Bun.file(database).arrayBuffer())

        const direct = yield* arforge.spawn(["db", "current", "--json"], { env, timeoutMs: 60_000 })
        arforge.expectExit(direct, 0, "db current")
        const legacy = yield* arforge.spawn(["db-current", "--json"], { env, timeoutMs: 60_000 })
        arforge.expectExit(legacy, 0, "db-current")

        const directPayload = JSON.parse(direct.stdout) as {
          database: string
          schema_version: number
          current: string | null
          applied: string[]
          pending: string[]
          unknown: string[]
          source: string
        }
        const legacyPayload = JSON.parse(legacy.stdout)
        expect(legacyPayload).toEqual(directPayload)
        expect(directPayload).toMatchObject({
          database: "main",
          schema_version: 1,
          pending: [],
          unknown: [],
          source: "typescript-migration-ledger",
        })
        expect(directPayload.current).toBe(directPayload.applied.at(-1) ?? null)
        expect(direct.stderr).toBe("")
        expect(legacy.stderr).toBe("")

        const human = yield* arforge.spawn(["db-current"], { env, timeoutMs: 60_000 })
        arforge.expectExit(human, 0, "db-current human")
        expect(human.stdout).toBe(`main: ${directPayload.current}\n`)

        const blocked = yield* arforge.spawn(["db-current", "multiagent", "--json"], {
          env,
          timeoutMs: 30_000,
        })
        arforge.expectExit(blocked, 2, "db-current multiagent")
        expect(blocked.stdout).toBe("")
        expect(blocked.stderr).toContain("multiagent")
        expect(blocked.stderr).toContain("TypeScript")

        const missingDatabase = join(home, "missing-db.sqlite")
        const missing = yield* arforge.spawn(["db", "current", "--json"], {
          env: { ...env, ARFORGE_DB: missingDatabase },
          timeoutMs: 60_000,
        })
        arforge.expectExit(missing, 0, "db current missing")
        const missingPayload = JSON.parse(missing.stdout)
        expect(missingPayload).toMatchObject({
          database: "main",
          current: null,
          applied: [],
          source: "unversioned",
        })
        expect(missingPayload.pending.length).toBeGreaterThan(0)
        expect(yield* Effect.promise(() => Bun.file(missingDatabase).exists())).toBe(false)
        const afterRead = yield* Effect.promise(() => Bun.file(database).arrayBuffer())
        expect(Buffer.from(afterRead).equals(Buffer.from(beforeRead))).toBe(true)
      }),
    120_000,
  )
})
