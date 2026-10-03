import * as pg from "drizzle-orm/pg-core"
import * as sqlite from "drizzle-orm/sqlite-core"

/**
 * Production uses the owner's PostgreSQL database. Tests and explicit
 * ARFORGE_DB overrides keep SQLite so isolated in-memory fixtures remain fast.
 *
 * The exported surface intentionally matches sqlite-core. Existing feature
 * modules therefore share one query model while the runtime tables use the
 * correct dialect.
 */
/**
 * Recognise only PostgreSQL connection URLs as the PostgreSQL backend.
 *
 * The Python compatibility test harness (and a number of local integrations)
 * deliberately use `ARFORGE_DB_URL=sqlite://...` to describe an isolated
 * SQLite store. Treating every non-empty value as PostgreSQL makes the TS
 * process try to open the PostgreSQL pool and schema gate for those callers,
 * even though no PostgreSQL connection was requested. Keeping the protocol
 * check here also prevents a malformed/unknown URL from silently changing the
 * SQL dialect at module load time.
 */
export const isPostgresUrl = (value: string | undefined): boolean =>
  typeof value === "string" && /^(?:postgres|postgresql):\/\//i.test(value.trim())

export const usesPostgres = !process.env.ARFORGE_DB && isPostgresUrl(process.env.ARFORGE_DB_URL)

const pgJsonText = pg.customType<{
  data: unknown
  driverData: string
  driverOutput: string
}>({
  dataType() {
    return "text"
  },
  toDriver(value) {
    return JSON.stringify(value)
  },
  fromDriver(value) {
    return JSON.parse(value)
  },
})

function pgInteger(config?: { mode?: string }) {
  if (config?.mode === "boolean") return pg.boolean()
  // Epoch millisecond values exceed PostgreSQL's 32-bit integer range.
  return pg.bigint({ mode: "number" })
}

function pgText(config?: { mode?: string }) {
  if (config?.mode === "json") return pgJsonText()
  return pg.text()
}

export const sqliteTable: typeof sqlite.sqliteTable = (
  usesPostgres ? pg.pgTable : sqlite.sqliteTable
) as typeof sqlite.sqliteTable
export const text: typeof sqlite.text = (usesPostgres ? pgText : sqlite.text) as typeof sqlite.text
export const integer: typeof sqlite.integer = (usesPostgres ? pgInteger : sqlite.integer) as typeof sqlite.integer
export const real: typeof sqlite.real = (usesPostgres ? pg.doublePrecision : sqlite.real) as typeof sqlite.real
export const index: typeof sqlite.index = (usesPostgres ? pg.index : sqlite.index) as typeof sqlite.index
export const uniqueIndex: typeof sqlite.uniqueIndex = (
  usesPostgres ? pg.uniqueIndex : sqlite.uniqueIndex
) as typeof sqlite.uniqueIndex
export const check: typeof sqlite.check = (usesPostgres ? pg.check : sqlite.check) as typeof sqlite.check
export const foreignKey: typeof sqlite.foreignKey = (
  usesPostgres ? pg.foreignKey : sqlite.foreignKey
) as typeof sqlite.foreignKey
export const primaryKey: typeof sqlite.primaryKey = (
  usesPostgres ? pg.primaryKey : sqlite.primaryKey
) as typeof sqlite.primaryKey
export const customType: typeof sqlite.customType = (
  usesPostgres ? pg.customType : sqlite.customType
) as typeof sqlite.customType
