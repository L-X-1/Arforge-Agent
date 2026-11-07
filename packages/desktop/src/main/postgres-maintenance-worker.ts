import { Effect, Logger } from "effect"
import { loadProductEnv } from "@arforge-ai/core/config/product-env"
import { migrateConfiguredPostgres, type PostgresMaintenanceResult } from "./postgres-maintenance"

type ParentPort = {
  postMessage(value: PostgresMaintenanceResult): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

const port = process.parentPort as ParentPort | undefined
if (!port) throw new Error("PostgreSQL maintenance requires its owned utility parent")
const controller = new AbortController()
port.on("message", ({ data }) => {
  if (data && typeof data === "object" && "type" in data && data.type === "cancel") controller.abort()
})

void migrateConfiguredPostgres({
  loadEnvironment: () => { loadProductEnv({ override: true }) },
  adminURL: () => process.env.ARFORGE_DB_ADMIN_URL,
  signal: controller.signal,
  loadMigrator: async () => {
    // Do not construct Database.Service, Server.listen, doctor or CLI bootstrap.
    const { Database } = await import("virtual:arforge-server")
    return (url, signal) => Effect.runPromise(
      Database.migratePostgresSchema(url).pipe(Effect.provide(Logger.layer([]))),
      { signal },
    )
  },
}).then((result) => {
  port.postMessage(result)
  setImmediate(() => process.exit(result.ok ? 0 : result.code === "cancelled" ? 2 : 1))
}, () => {
  port.postMessage({ ok: false, code: "migration-failed" })
  setImmediate(() => process.exit(1))
})
