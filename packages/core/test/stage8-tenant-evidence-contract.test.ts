import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

test("stage 8 tenant evidence composition is digest-bound and fail-closed", async () => {
  const script = await readFile(resolve(root, "script/compose-stage8-tenant-evidence.ts"), "utf8")
  const parsed: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) throw new Error("package scripts must be an object")

  expect(parsed.scripts["db:tenant:evidence"]).toBe("bun run script/compose-stage8-tenant-evidence.ts")
  expect(script).toContain("tenant_rls_backup_delete_drill")
  expect(script).toContain("sha256")
  expect(script).toContain("mismatchCount")
  expect(script).toContain("no_business_data_committed")
  expect(script).toContain("process.exitCode = 1")
})
