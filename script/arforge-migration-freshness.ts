import path from "node:path"

import { validatePythonDependenciesLedger } from "./arforge-python-dependencies-ledger"
import { validatePythonLedgers } from "./arforge-python-ledger"
import { validatePythonTestsLedger } from "./arforge-python-tests-ledger"
import { validateTsCompositionArtifact } from "./arforge-ts-composition-ledger"
import { validateTsBoot } from "./arforge-ts-boot-gate"
import { validateSourceSnapshot, writeSourceSnapshot } from "./arforge-source-snapshot"
import { validateCapabilityLinks } from "./arforge-capability-links"

type JsonRecord = Record<string, unknown>

export type MigrationFreshnessFinding = {
  readonly code: string
  readonly path: string
  readonly detail: string
}

export type MigrationFreshnessCheck = {
  readonly id:
    | "python-capabilities"
    | "python-tests"
    | "python-dependencies"
    | "ts-composition"
    | "ts-boot"
    | "source-inputs"
    | "capability-links"
  readonly valid: boolean
  readonly findings: readonly MigrationFreshnessFinding[]
  readonly metrics: Readonly<Record<string, number>>
}

export type MigrationFreshnessReport = {
  readonly schema_version: "1.0"
  readonly valid: boolean
  readonly checks: readonly MigrationFreshnessCheck[]
}

const CHECKS = [
  ["python-capabilities", validatePythonLedgers],
  ["python-tests", validatePythonTestsLedger],
  ["python-dependencies", validatePythonDependenciesLedger],
  ["ts-composition", validateTsCompositionArtifact],
  ["ts-boot", validateTsBoot],
  ["source-inputs", validateSourceSnapshot],
  ["capability-links", validateCapabilityLinks],
] as const

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const numericMetrics = (value: unknown): Readonly<Record<string, number>> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => entry[0] !== "schema_version" && typeof entry[1] === "number",
    ),
  )
}

const findingsFrom = (value: unknown, id: string): MigrationFreshnessFinding[] => {
  if (!isRecord(value) || !Array.isArray(value.findings)) {
    return [{ code: "MIG-001", path: id, detail: "validator did not return a findings array" }]
  }
  return value.findings.flatMap((finding): MigrationFreshnessFinding[] => {
    if (!isRecord(finding)) {
      return [{ code: "MIG-002", path: id, detail: "validator returned a malformed finding" }]
    }
    return [
      {
        code: typeof finding.code === "string" ? finding.code : "MIG-003",
        path: typeof finding.path === "string" ? finding.path : id,
        detail: typeof finding.detail === "string" ? finding.detail : "validator finding has no detail",
      },
    ]
  })
}

const validFrom = (value: unknown) => isRecord(value) && value.valid === true

/**
 * Validate every migration ledger that can become stale after a TypeScript change.
 * The function is deliberately read-only: individual generators require an explicit
 * `--write`, while this gate only compares checked-in artifacts with deterministic scans.
 */
export async function validateMigrationFreshness(rootInput: string): Promise<MigrationFreshnessReport> {
  const root = path.resolve(rootInput)
  const checks: MigrationFreshnessCheck[] = []

  for (const [id, validator] of CHECKS) {
    try {
      const result = await validator(root)
      const findings = findingsFrom(result, id)
      checks.push({
        id,
        valid: validFrom(result) && findings.length === 0,
        findings,
        metrics: numericMetrics(result),
      })
    } catch (error) {
      checks.push({
        id,
        valid: false,
        findings: [{ code: "MIG-004", path: id, detail: "validator threw: " + String(error) }],
        metrics: {},
      })
    }
  }

  return {
    schema_version: "1.0",
    valid: checks.every((check) => check.valid),
    checks,
  }
}

const parseRoot = (args: readonly string[]) => {
  const index = args.indexOf("--root")
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : process.cwd()
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "validate-capability-links") {
    const report = await validateCapabilityLinks(parseRoot(args))
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  if (args[0] === "generate-source-snapshot") {
    if (!args.includes("--write")) {
      console.error("snapshot generation requires explicit --write; no files changed")
      process.exit(2)
    }
    console.log(JSON.stringify(await writeSourceSnapshot(parseRoot(args)), null, 2))
    process.exit(0)
  }
  if (args[0] === "validate-source-snapshot") {
    const report = await validateSourceSnapshot(parseRoot(args))
    console.log(JSON.stringify(report, null, 2))
    process.exit(report.valid ? 0 : 1)
  }
  if (args[0] !== "validate-migration-freshness") {
    console.error(
      "usage: bun run script/arforge-migration-freshness.ts <validate-migration-freshness | validate-capability-links | validate-source-snapshot | generate-source-snapshot --write> --root <repo>",
    )
    process.exit(2)
  }
  const report = await validateMigrationFreshness(parseRoot(args))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.valid ? 0 : 1)
}
