import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/database/schema.postgres.ts",
  out: "./src/database/postgres-migrations",
})
