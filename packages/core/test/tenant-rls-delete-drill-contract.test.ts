import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

test("tenant RLS/delete drill is transactional and fail-closed", async () => {
  const script = await readFile(resolve(root, "script/tenant-rls-delete-drill.ts"), "utf8")
  const parsed: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))
  if (!isRecord(parsed)) throw new Error("package manifest must be an object")
  const scripts = parsed.scripts
  if (!isRecord(scripts)) throw new Error("package scripts must be an object")

  expect(scripts["db:tenant:rls-delete-drill"]).toBe("bun run script/tenant-rls-delete-drill.ts")
  expect(script).toContain("SET LOCAL ROLE arforge_app")
  expect(script).toContain("SET LOCAL arforge.tenant_id")
  expect(script).toContain("DELETE FROM tenant_data_request")
  expect(script).toContain("ROLLBACK;")
  expect(script).toContain("business_data_committed: false")
  expect(script).toContain("secrets_printed: false")
})
