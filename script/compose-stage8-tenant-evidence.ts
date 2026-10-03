import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const root = resolve(import.meta.dir, "..")

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function argumentValue(args: ReadonlyArray<string>, flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

function rootRelativePath(input: string) {
  if (isAbsolute(input)) throw new Error("evidence inputs and output must be repository-relative")
  const absolute = resolve(root, input)
  const value = relative(root, absolute).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("evidence path must stay inside repository root")
  }
  return { absolute, relative: value }
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function readObject(path: string) {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(parsed)) throw new Error("evidence report must be a JSON object")
  return parsed
}

function booleanChecks(record: JsonRecord, key: string) {
  const value = record[key]
  return isRecord(value) && Object.values(value).every((item) => item === true)
}

function numberValue(record: JsonRecord, key: string) {
  return typeof record[key] === "number" ? record[key] : null
}

async function main() {
  const args = process.argv.slice(2)
  const rlsInput = argumentValue(args, "--rls-report")
  const recoveryInput = argumentValue(args, "--recovery-report")
  const outputInput = argumentValue(args, "--output")
  if (!rlsInput || !recoveryInput || !outputInput) {
    throw new Error("--rls-report, --recovery-report and --output are required")
  }

  const rlsPath = rootRelativePath(rlsInput)
  const recoveryPath = rootRelativePath(recoveryInput)
  const outputPath = rootRelativePath(outputInput)
  const rls = await readObject(rlsPath.absolute)
  const recovery = await readObject(recoveryPath.absolute)
  const rlsPassed = rls.status === "pass" && booleanChecks(rls, "checks")
  const recoveryPassed =
    recovery.passed === true &&
    recovery.checksumVerified === true &&
    recovery.authenticationVerified === true &&
    recovery.restoreListVerified === true &&
    numberValue(recovery, "mismatchCount") === 0
  const checks = {
    rls_delete_drill_passed: rlsPassed,
    backup_restore_drill_passed: recoveryPassed,
    no_recovery_row_mismatch: numberValue(recovery, "mismatchCount") === 0,
    no_secret_values_printed: isRecord(rls.safety) && rls.safety.secrets_printed === false,
    no_business_data_committed: isRecord(rls.safety) && rls.safety.business_data_committed === false,
  }
  const passed = Object.values(checks).every(Boolean)
  const report = {
    schema_version: 1,
    evidence_type: "tenant_rls_backup_delete_drill",
    status: passed ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    checks,
    reports: {
      rls_delete: { path: rlsPath.relative, sha256: await sha256(rlsPath.absolute), status: rls.status ?? null },
      backup_recovery: {
        path: recoveryPath.relative,
        sha256: await sha256(recoveryPath.absolute),
        passed: recovery.passed ?? null,
        mismatch_count: recovery.mismatchCount ?? null,
      },
    },
    safety: { secrets_printed: false, business_data_committed: false },
  }
  await writeFile(outputPath.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      status: report.status,
      output: outputPath.absolute,
      failedChecks: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([key]) => key),
    }),
  )
  if (!passed) process.exitCode = 1
}

if (import.meta.main) await main()
