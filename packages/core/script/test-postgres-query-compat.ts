import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { loadProductEnv } from "../src/config/product-env"

// Use the application's own configuration loader. No credentials are printed,
// copied or persisted. This probe issues SELECTs only and skips schema writes.
loadProductEnv()
process.env.ARFORGE_DB_READ_ONLY = "1"
const { Database } = await import("../src/database/database")
const url = process.env.ARFORGE_DB_URL?.trim()
if (!url) throw new Error("The configured PostgreSQL application connection is unavailable")

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.get<{ value: number }>(sql`SELECT 42::integer AS value`)
    const rows = yield* db.all<{ value: number }>(sql`SELECT 43::integer AS value`)
    yield* db.run(sql`SELECT 44::integer AS value`)
    const transactionRow = yield* db.transaction((transaction) =>
      transaction.get<{ value: number }>(sql`SELECT 45::integer AS value`),
    )
    if (row?.value !== 42 || rows[0]?.value !== 43 || transactionRow?.value !== 45)
      throw new Error("PostgreSQL query compatibility did not preserve its results")
    return { passed: true, checks: ["raw get", "raw all", "raw run", "transaction raw get"], writes: 0 }
  }).pipe(Effect.provide(Database.layerFromPostgresUrl(url))),
)
console.log(JSON.stringify(result))
