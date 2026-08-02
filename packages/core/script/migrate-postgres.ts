#!/usr/bin/env bun

import { loadProductEnv } from "../src/config/product-env"

loadProductEnv()

const adminUrl = process.env.ARFORGE_DB_ADMIN_URL?.trim()
if (!adminUrl) {
  throw new Error(
    "ARFORGE_DB_ADMIN_URL is required for PostgreSQL schema migrations. Keep it in the private Arforge environment file, never in source control.",
  )
}

const { Database } = await import("../src/database/database")
const { Effect } = await import("effect")
const result = await Effect.runPromise(Database.migratePostgresSchema(adminUrl))

console.log(
  result.applied.length === 0
    ? `PostgreSQL schema is current (${result.current}).`
    : `Applied ${result.applied.length} PostgreSQL migration(s); schema is now ${result.current}.`,
)
