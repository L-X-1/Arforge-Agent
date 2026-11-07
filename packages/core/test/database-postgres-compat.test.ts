import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sql, type SQL } from "drizzle-orm"
import { postgresCompat } from "../src/database/database"

type Result = { id: string }
type Compatible = {
  run: (query?: SQL | string) => Effect.Effect<readonly Result[]>
  all: (query?: SQL | string) => Effect.Effect<readonly Result[]>
  get: (query?: SQL | string) => Effect.Effect<Result | undefined>
}

describe("PostgreSQL feature-facing query compatibility", () => {
  for (const method of ["run", "all", "get"] as const) {
    test(`${method} forwards raw queries and preserves the native handle`, async () => {
      const calls: unknown[][] = []
      const target = {
        execute(query: SQL | string) {
          expect(this === target).toBe(true)
          // The real EffectPgDatabase dereferences query.getSQL(). The old
          // compatibility wrapper dropped this argument before any SQL ran.
          if (typeof query !== "string") query.getSQL()
          calls.push([query])
          return Effect.succeed([{ id: "admitted-run" }])
        },
      }
      const db = postgresCompat(target) as unknown as Compatible
      for (const query of [sql`SELECT ${"session"} FOR UPDATE`, "SELECT 1"]) {
        const result = await Effect.runPromise<Result | readonly Result[] | undefined, never>(db[method](query))
        expect(calls.at(-1)?.[0] === query).toBe(true)
        expect(result).toEqual(method === "get" ? { id: "admitted-run" } : [{ id: "admitted-run" }])
      }
    })

    test(`${method} keeps a prepared builder's zero-argument execution`, async () => {
      const calls: number[] = []
      const builder = { execute(...args: unknown[]) { calls.push(args.length); return Effect.succeed([{ id: "row" }]) } }
      const db = postgresCompat({ select: () => builder })
      const prepared = db.select() as unknown as Compatible
      const result = await Effect.runPromise<Result | readonly Result[] | undefined, never>(prepared[method]())
      expect(calls).toEqual([0])
      expect(result).toEqual(method === "get" ? { id: "row" } : [{ id: "row" }])
    })
  }

  test("transaction callbacks retain raw query arguments and wrapper identity", async () => {
    const calls: unknown[] = []
    const transaction = { execute(query: SQL) { calls.push(query.getSQL()); return Effect.succeed([]) } }
    const target = {
      transaction: (callback: (handle: object) => Effect.Effect<void>) => callback(transaction),
    }
    const db = postgresCompat(target)
    const query = sql`SELECT ${"tenant"} FOR UPDATE`
    await Effect.runPromise(db.transaction((handle) => {
      expect(handle === postgresCompat(transaction)).toBe(true)
      return (handle as Compatible).run(query).pipe(Effect.asVoid)
    }))
    expect(calls.length).toBe(1)
    expect(calls[0] === query).toBe(true)
  })

  test("get returns undefined for an empty result", async () => {
    const db = postgresCompat({ execute: () => Effect.succeed([]) }) as unknown as Compatible
    expect(await Effect.runPromise(db.get())).toBeUndefined()
  })
})
