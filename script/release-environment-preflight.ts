import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

export type PreflightStatus = "pass" | "missing" | "invalid"

export type ReleaseEnvironmentCheck = {
  readonly id: string
  readonly status: PreflightStatus
  readonly required: true
  readonly detail: string
}

export type ReleaseEnvironmentReport = {
  readonly schema_version: 1
  readonly status: "ready" | "blocked"
  readonly secretsPrinted: false
  readonly checks: ReadonlyArray<ReleaseEnvironmentCheck>
  readonly missing: ReadonlyArray<string>
  readonly invalid: ReadonlyArray<string>
}

export type ReleaseEnvironmentOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly fileExists?: (path: string) => boolean
}

const SIGNING_FIELDS = [
  "SM_HOST",
  "SM_API_KEY",
  "SM_CLIENT_CERT_FILE",
  "SM_CLIENT_CERT_PASSWORD",
  "ARFORGE_WINDOWS_KEYPAIR_ALIAS",
  "ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT",
] as const

function valueOf(env: Readonly<Record<string, string | undefined>>, name: string) {
  const value = env[name]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function checkPresence(
  env: Readonly<Record<string, string | undefined>>,
  id: string,
  name: string,
): ReleaseEnvironmentCheck {
  return valueOf(env, name)
    ? { id, status: "pass", required: true, detail: name + " is configured" }
    : { id, status: "missing", required: true, detail: name + " is missing" }
}

function checkOrigin(
  env: Readonly<Record<string, string | undefined>>,
  id: string,
  name: string,
): ReleaseEnvironmentCheck {
  const value = valueOf(env, name)
  if (!value) return { id, status: "missing", required: true, detail: name + " is missing" }
  try {
    const url = new URL(value)
    const valid =
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "") &&
      url.origin === value
    return valid
      ? { id, status: "pass", required: true, detail: name + " is a safe origin" }
      : { id, status: "invalid", required: true, detail: name + " must be a credential-free origin" }
  } catch {
    return { id, status: "invalid", required: true, detail: name + " is not a valid URL" }
  }
}

function checkDatabaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  id: string,
  name: string,
): ReleaseEnvironmentCheck {
  const value = valueOf(env, name)
  if (!value) return { id, status: "missing", required: true, detail: name + " is missing" }
  try {
    const url = new URL(value)
    const valid = url.protocol === "postgres:" || url.protocol === "postgresql:"
    return valid
      ? { id, status: "pass", required: true, detail: name + " has a PostgreSQL scheme" }
      : { id, status: "invalid", required: true, detail: name + " must use PostgreSQL" }
  } catch {
    return { id, status: "invalid", required: true, detail: name + " is not a valid database URL" }
  }
}

function checkCertificateFile(
  env: Readonly<Record<string, string | undefined>>,
  fileExists: (path: string) => boolean,
): ReleaseEnvironmentCheck {
  const name = "SM_CLIENT_CERT_FILE"
  const value = valueOf(env, name)
  if (!value)
    return { id: "signing.client_certificate_file", status: "missing", required: true, detail: name + " is missing" }
  return fileExists(value)
    ? {
        id: "signing.client_certificate_file",
        status: "pass",
        required: true,
        detail: name + " points to an existing file",
      }
    : {
        id: "signing.client_certificate_file",
        status: "invalid",
        required: true,
        detail: name + " points to a missing file",
      }
}

export function evaluateReleaseEnvironment(options: ReleaseEnvironmentOptions = {}): ReleaseEnvironmentReport {
  const env = options.env ?? process.env
  const fileExists = options.fileExists ?? existsSync
  const checks: ReleaseEnvironmentCheck[] = [
    {
      id: "signing.provider",
      status:
        valueOf(env, "ARFORGE_WINDOWS_SIGNING_PROVIDER") === "digicert-keylocker"
          ? "pass"
          : valueOf(env, "ARFORGE_WINDOWS_SIGNING_PROVIDER")
            ? "invalid"
            : "missing",
      required: true,
      detail:
        valueOf(env, "ARFORGE_WINDOWS_SIGNING_PROVIDER") === "digicert-keylocker"
          ? "configured provider is digicert-keylocker"
          : "ARFORGE_WINDOWS_SIGNING_PROVIDER must be digicert-keylocker",
    },
    ...SIGNING_FIELDS.map((name) => checkPresence(env, "signing." + name.toLowerCase(), name)),
    checkCertificateFile(env, fileExists),
    checkOrigin(env, "staging.origin", "ARFORGE_STAGING_URL"),
    checkOrigin(env, "telemetry.otlp_endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"),
    checkDatabaseUrl(env, "database.application_url", "ARFORGE_DB_URL"),
    checkDatabaseUrl(env, "database.admin_url", "ARFORGE_DB_ADMIN_URL"),
  ]
  const missing = checks.filter((check) => check.status === "missing").map((check) => check.id)
  const invalid = checks.filter((check) => check.status === "invalid").map((check) => check.id)
  return {
    schema_version: 1,
    status: missing.length === 0 && invalid.length === 0 ? "ready" : "blocked",
    secretsPrinted: false,
    checks,
    missing,
    invalid,
  }
}

function argumentValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(flag + " requires a value")
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const outputPath = argumentValue(args, "--output")
  const report = evaluateReleaseEnvironment()
  if (outputPath) await writeFile(resolve(process.cwd(), outputPath), JSON.stringify(report, null, 2) + "\n", "utf8")
  console.log(
    JSON.stringify({
      status: report.status,
      missing: report.missing,
      invalid: report.invalid,
      secretsPrinted: report.secretsPrinted,
    }),
  )
  if (!args.includes("--report-only") && report.status !== "ready") process.exitCode = 1
}
