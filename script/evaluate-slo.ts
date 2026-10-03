import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { evaluateSloWindow, type SloWindowEvidence } from "../packages/core/src/runtime/slo"

type SloEvidenceDocument = {
  schema_version: 1
  service: string
  window: SloWindowEvidence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasNumber(record: Record<string, unknown>, key: string) {
  return typeof record[key] === "number"
}

function isApiEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumber(value, "totalRequests") &&
    hasNumber(value, "goodRequests") &&
    hasNumber(value, "p95LatencyMs")
  )
}

function isTenantEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumber(value, "probeCount") &&
    hasNumber(value, "crossScopeViolations") &&
    hasNumber(value, "policyBypasses")
  )
}

function isBackupEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumber(value, "attempts") &&
    hasNumber(value, "successful") &&
    hasNumber(value, "mismatchCount") &&
    typeof value.temporaryDatabaseCleanup === "boolean"
  )
}

function isMigrationEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasNumber(value, "attempts") &&
    hasNumber(value, "successful") &&
    hasNumber(value, "rowCountMismatch") &&
    typeof value.rlsChecksPassed === "boolean" &&
    typeof value.schemaRevision === "string"
  )
}

function isSloWindowEvidence(value: unknown): value is SloWindowEvidence {
  if (!isRecord(value) || !hasNumber(value, "startAt") || !hasNumber(value, "endAt")) return false
  if (value.api !== undefined && !isApiEvidence(value.api)) return false
  if (value.tenantIsolation !== undefined && !isTenantEvidence(value.tenantIsolation)) return false
  if (value.backupRestore !== undefined && !isBackupEvidence(value.backupRestore)) return false
  if (value.migrationIntegrity !== undefined && !isMigrationEvidence(value.migrationIntegrity)) return false
  return value.rateOrBudgetUnexpected === undefined || typeof value.rateOrBudgetUnexpected === "boolean"
}

function isSloEvidenceDocument(value: unknown): value is SloEvidenceDocument {
  return (
    isRecord(value) &&
    value.schema_version === 1 &&
    typeof value.service === "string" &&
    isSloWindowEvidence(value.window)
  )
}

function argumentValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

const args = process.argv.slice(2)
const inputPath = argumentValue(args, "--input")
if (!inputPath) throw new Error("--input is required")
const outputPath = argumentValue(args, "--output")
const parsed: unknown = JSON.parse(await readFile(resolve(process.cwd(), inputPath), "utf8"))
if (!isSloEvidenceDocument(parsed)) throw new Error("invalid SLO evidence document")
const document = parsed

const report = evaluateSloWindow(document.window)
if (outputPath) await writeFile(resolve(process.cwd(), outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8")
console.log(
  JSON.stringify({
    service: document.service,
    decision: report.releaseGate.decision,
    activeAlerts: report.alerts.filter((alert) => alert.status === "active").length,
  }),
)
if (args.includes("--require-pass") && report.releaseGate.decision !== "SHIP") process.exitCode = 1
