import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"

import { validateMigrationFreshness } from "./arforge-migration-freshness"

test(
  "migration freshness gate validates the checked-in ledgers as one contract",
  async () => {
    const report = await validateMigrationFreshness(path.resolve(import.meta.dir, ".."))

    expect(report.schema_version).toBe("1.0")
    expect(report.valid).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([
      "python-capabilities",
      "python-tests",
      "python-dependencies",
      "ts-composition",
      "ts-boot",
      "source-inputs",
      "capability-links",
    ])
    expect(report.checks.every((check) => check.valid && check.findings.length === 0)).toBe(true)
  },
  { timeout: 90_000 },
)

test("migration freshness gate fails closed when the repository root is unavailable", async () => {
  const report = await validateMigrationFreshness(path.join(os.tmpdir(), "arforge-missing-migration-root"))

  expect(report.valid).toBe(false)
  expect(report.checks).toHaveLength(7)
  expect(report.checks.every((check) => !check.valid && check.findings.length > 0)).toBe(true)
})
