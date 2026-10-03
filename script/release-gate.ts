import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { SLO_IDS } from "../packages/core/src/runtime/slo"
import { verifyReleaseEvidence, type ReleaseEvidenceReport } from "./release-evidence"

type JsonRecord = Record<string, unknown>

export type ReleaseGateInput = {
  readonly root?: string
  readonly releaseEvidenceDir: string
  readonly sloReportPath: string
  readonly canaryReceiptPath: string
  readonly ownerEvidencePath: string
}

export type ReleaseGateReport = {
  readonly schema_version: 1
  readonly decision: "SHIP" | "DO_NOT_SHIP"
  readonly checks: {
    readonly signedReleaseEvidence: boolean
    readonly slo: boolean
    readonly canary: boolean
    readonly releaseOwner: boolean
  }
  readonly evidence_digests: {
    readonly release_manifest_sha256: string | null
    readonly slo_report_sha256: string | null
    readonly canary_receipt_sha256: string | null
  }
  readonly reasons: ReadonlyArray<string>
}

type ArtifactReference = { readonly path: string; readonly sha256: string }

const ALERT_IDS = [
  "critical.tenant-isolation",
  "critical.migration-or-backup",
  "warning.api-burn",
  "warning.rate-or-budget",
] as const

const OWNER_CHECKS = [
  "sbom_license_reviewed",
  "signature_verified",
  "canary_passed",
  "slo_passed",
  "backup_restore_drill_passed",
  "rollback_artifact_ready",
  "incident_contact_confirmed",
] as const

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
}

function isSafeOrigin(value: unknown): value is string {
  if (!nonEmptyString(value)) return false
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === "/" || url.pathname === "") &&
      url.origin === value
    )
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function artifactReference(report: ReleaseEvidenceReport): ArtifactReference | null {
  if (!Array.isArray(report.manifest.files)) return null
  const records = report.manifest.files.filter(isRecord)
  const artifacts = records.filter((entry) => entry.kind === "artifact")
  if (artifacts.length !== 1) return null
  const artifact = artifacts[0]
  if (!artifact || !nonEmptyString(artifact.path) || !isSha256(artifact.sha256)) return null
  return { path: artifact.path, sha256: artifact.sha256.toLowerCase() }
}

function passingSloReport(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.releaseGate) ||
    value.releaseGate.decision !== "SHIP"
  )
    return false
  const slos = value.slos
  if (!Array.isArray(slos) || slos.length !== SLO_IDS.length) return false
  if (
    !SLO_IDS.every((id, index) => {
      const item = slos[index]
      return isRecord(item) && item.id === id
    })
  )
    return false
  if (!slos.every((item) => isRecord(item) && item.status === "pass" && item.evidenceComplete === true)) return false
  const alerts = value.alerts
  if (!Array.isArray(alerts) || alerts.length !== ALERT_IDS.length) return false
  if (
    !ALERT_IDS.every((id, index) => {
      const item = alerts[index]
      return isRecord(item) && item.id === id
    })
  )
    return false
  return alerts.every((item) => isRecord(item) && item.status === "inactive")
}

function passingCanaryReceipt(value: unknown, artifact: ArtifactReference): boolean {
  if (!isRecord(value)) return false
  if (value.schema_version !== 1 || value.status !== "passed") return false
  if (value.artifact_path !== artifact.path || value.artifact_digest !== artifact.sha256) return false
  if (!isSha256(value.rollback_artifact_digest) || value.rollback_artifact_digest.toLowerCase() === artifact.sha256)
    return false
  const cohort = value.cohort
  if (!isRecord(cohort)) return false
  if (
    !nonEmptyString(cohort.id) ||
    !isFiniteNonNegative(cohort.traffic_percent) ||
    cohort.traffic_percent <= 0 ||
    cohort.traffic_percent > 100
  )
    return false
  const observationStart = cohort.observation_start
  const observationEnd = cohort.observation_end
  if (
    !isFiniteNonNegative(observationStart) ||
    !isFiniteNonNegative(observationEnd) ||
    observationEnd <= observationStart
  )
    return false
  if (value.endpoint !== "/global/health" || !isSafeOrigin(value.target_origin)) return false
  if (!isPositiveInteger(value.observed_requests) || value.successful_requests !== value.observed_requests) return false
  if (!isFiniteNonNegative(value.p95_latency_ms) || value.p95_latency_ms > 750) return false
  if (!isFiniteNonNegative(value.error_budget_burn) || value.critical_alerts !== 0) return false
  return Array.isArray(value.failure_reasons) && value.failure_reasons.length === 0
}

function passingOwnerEvidence(
  value: unknown,
  artifact: ArtifactReference,
  digests: NonNullable<ReleaseGateReport["evidence_digests"]>,
): boolean {
  if (!isRecord(value)) return false
  if (value.schema_version !== 1 || value.decision !== "SHIP") return false
  if (
    !nonEmptyString(value.release_owner) ||
    !nonEmptyString(value.approved_at) ||
    Number.isNaN(Date.parse(value.approved_at))
  )
    return false
  if (value.artifact_path !== artifact.path || value.artifact_digest !== artifact.sha256) return false
  if (
    value.release_manifest_sha256 !== digests.release_manifest_sha256 ||
    value.slo_report_sha256 !== digests.slo_report_sha256 ||
    value.canary_receipt_sha256 !== digests.canary_receipt_sha256
  )
    return false
  if (
    !Array.isArray(value.reviewer_ids) ||
    value.reviewer_ids.length === 0 ||
    !value.reviewer_ids.every(nonEmptyString)
  )
    return false
  const checklist = value.checklist
  if (!isRecord(checklist)) return false
  return OWNER_CHECKS.every((key) => checklist[key] === true)
}

export async function evaluateReleaseGate(input: ReleaseGateInput): Promise<ReleaseGateReport> {
  const root = resolve(input.root ?? process.cwd())
  const releaseEvidenceDir = resolve(root, input.releaseEvidenceDir)
  const sloReportPath = resolve(root, input.sloReportPath)
  const canaryReceiptPath = resolve(root, input.canaryReceiptPath)
  const ownerEvidencePath = resolve(root, input.ownerEvidencePath)
  const reasons: string[] = []
  let releaseReport: ReleaseEvidenceReport | undefined

  try {
    releaseReport = await verifyReleaseEvidence(releaseEvidenceDir, true, root)
  } catch (error) {
    reasons.push(
      `signed release evidence failed verification: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const artifact = releaseReport ? artifactReference(releaseReport) : null
  if (!artifact) reasons.push("signed release evidence does not contain a digest-bound artifact")

  const digests = {
    release_manifest_sha256: null as string | null,
    slo_report_sha256: null as string | null,
    canary_receipt_sha256: null as string | null,
  }
  try {
    digests.release_manifest_sha256 = await sha256(join(releaseEvidenceDir, "release-manifest.json"))
  } catch {
    reasons.push("release manifest digest is unavailable")
  }

  let sloValue: unknown
  try {
    sloValue = await readJson(sloReportPath)
    digests.slo_report_sha256 = await sha256(sloReportPath)
  } catch {
    reasons.push("SLO report is unavailable or invalid JSON")
  }
  const sloPass = passingSloReport(sloValue)
  if (!sloPass) reasons.push("SLO report is not a complete passing report")

  let canaryValue: unknown
  try {
    canaryValue = await readJson(canaryReceiptPath)
    digests.canary_receipt_sha256 = await sha256(canaryReceiptPath)
  } catch {
    reasons.push("canary receipt is unavailable or invalid JSON")
  }
  const canaryPass = artifact !== null && passingCanaryReceipt(canaryValue, artifact)
  if (!canaryPass) reasons.push("canary receipt is not a passing receipt bound to the release artifact")

  let ownerValue: unknown
  try {
    ownerValue = await readJson(ownerEvidencePath)
  } catch {
    reasons.push("release owner evidence is unavailable or invalid JSON")
  }
  const ownerPass = artifact !== null && passingOwnerEvidence(ownerValue, artifact, digests)
  if (!ownerPass) reasons.push("release owner evidence is incomplete or digest binding does not match")

  const uniqueReasons = [...new Set(reasons)]
  return {
    schema_version: 1,
    decision: uniqueReasons.length === 0 ? "SHIP" : "DO_NOT_SHIP",
    checks: {
      signedReleaseEvidence: releaseReport !== undefined && artifact !== null,
      slo: sloPass,
      canary: canaryPass,
      releaseOwner: ownerPass,
    },
    evidence_digests: digests,
    reasons: uniqueReasons,
  }
}

function argumentValue(args: string[], flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const releaseEvidenceDir = argumentValue(args, "--release-evidence")
  const sloReportPath = argumentValue(args, "--slo-report")
  const canaryReceiptPath = argumentValue(args, "--canary-receipt")
  const ownerEvidencePath = argumentValue(args, "--owner-evidence")
  if (!releaseEvidenceDir || !sloReportPath || !canaryReceiptPath || !ownerEvidencePath) {
    throw new Error("--release-evidence, --slo-report, --canary-receipt and --owner-evidence are required")
  }
  const report = await evaluateReleaseGate({ releaseEvidenceDir, sloReportPath, canaryReceiptPath, ownerEvidencePath })
  const outputPath = argumentValue(args, "--output")
  if (outputPath) await writeFile(resolve(process.cwd(), outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(
    JSON.stringify({
      decision: report.decision,
      failedChecks: Object.entries(report.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name),
    }),
  )
  if (!args.includes("--report-only") && report.decision !== "SHIP") process.exitCode = 1
}
