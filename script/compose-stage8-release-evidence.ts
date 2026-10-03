import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

type JsonRecord = Record<string, unknown>

export type Stage8ReleaseEvidenceOptions = {
  readonly root?: string
  readonly releaseGate: string
  readonly releaseManifest: string
  readonly canaryReceipt: string
  readonly output: string
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function rootRelativePath(root: string, input: string) {
  if (isAbsolute(input)) throw new Error("stage 8 evidence paths must be repository-relative")
  const absolute = resolve(root, input)
  const value = relative(root, absolute).split(sep).join("/")
  if (!value || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    throw new Error("stage 8 evidence path must stay inside repository root")
  }
  return { absolute, relative: value }
}

async function readObject(path: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isRecord(parsed)) throw new Error("stage 8 release input must be a JSON object")
  return parsed
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function gateChecksPass(value: JsonRecord) {
  if (value.schema_version !== 1 || value.decision !== "SHIP") return false
  const checks = value.checks
  if (
    !isRecord(checks) ||
    checks.signedReleaseEvidence !== true ||
    checks.slo !== true ||
    checks.canary !== true ||
    checks.releaseOwner !== true
  ) {
    return false
  }
  return Array.isArray(value.reasons) && value.reasons.length === 0
}

function gateDigests(value: JsonRecord) {
  const digests = value.evidence_digests
  if (!isRecord(digests)) return null
  if (
    !isSha256(digests.release_manifest_sha256) ||
    !isSha256(digests.slo_report_sha256) ||
    !isSha256(digests.canary_receipt_sha256)
  ) {
    return null
  }
  return digests
}

function signedManifest(value: JsonRecord) {
  if (value.schema_version !== 1 || value.status !== "signed") return false
  const signature = value.signature
  return isRecord(signature) && signature.status === "signed" && signature.verified === true
}

function passingCanary(value: JsonRecord) {
  if (value.schema_version !== 1 || value.status !== "passed") return false
  if (!isSha256(value.artifact_digest) || !isSha256(value.rollback_artifact_digest)) return false
  if (value.artifact_digest === value.rollback_artifact_digest) return false
  return (
    typeof value.artifact_path === "string" &&
    value.artifact_path.length > 0 &&
    value.endpoint === "/global/health" &&
    value.successful_requests === value.observed_requests &&
    Array.isArray(value.failure_reasons) &&
    value.failure_reasons.length === 0 &&
    value.critical_alerts === 0
  )
}

export async function composeStage8ReleaseEvidence(options: Stage8ReleaseEvidenceOptions) {
  const root = resolve(options.root ?? process.cwd())
  const gatePath = rootRelativePath(root, options.releaseGate)
  const manifestPath = rootRelativePath(root, options.releaseManifest)
  const canaryPath = rootRelativePath(root, options.canaryReceipt)
  const outputPath = rootRelativePath(root, options.output)
  const failures: string[] = []
  const gate = await readObject(gatePath.absolute)
  const manifest = await readObject(manifestPath.absolute)
  const canary = await readObject(canaryPath.absolute)
  const gateDigest = await sha256(gatePath.absolute)
  const manifestDigest = await sha256(manifestPath.absolute)
  const canaryDigest = await sha256(canaryPath.absolute)
  const digests = gateDigests(gate)

  if (!gateChecksPass(gate)) failures.push("release gate is not a complete SHIP report")
  if (!signedManifest(manifest)) failures.push("release manifest is not verified signed evidence")
  if (!passingCanary(canary)) failures.push("canary receipt is not a passing rollback-bound receipt")
  if (!digests) failures.push("release gate evidence digests are incomplete")
  else {
    if (digests.release_manifest_sha256 !== manifestDigest) failures.push("release manifest digest does not match gate")
    if (digests.canary_receipt_sha256 !== canaryDigest) failures.push("canary receipt digest does not match gate")
  }
  if (isSha256(canary.artifact_digest) && isSha256(canary.rollback_artifact_digest)) {
    if (canary.artifact_digest === canary.rollback_artifact_digest) failures.push("rollback digest must differ from artifact digest")
  }

  const report = {
    schema_version: 1,
    evidence_type: "signed_release_rollback",
    evidence_class: "release-gate",
    status: failures.length === 0 ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    source_report_path: gatePath.relative,
    source_report_sha256: gateDigest,
    release_gate: gate,
    source_inputs: {
      release_manifest: { path: manifestPath.relative, sha256: manifestDigest },
      canary_receipt: { path: canaryPath.relative, sha256: canaryDigest },
    },
    rollback: {
      artifact_digest: typeof canary.artifact_digest === "string" ? canary.artifact_digest : "",
      rollback_artifact_digest: typeof canary.rollback_artifact_digest === "string" ? canary.rollback_artifact_digest : "",
    },
    safety: { secrets_printed: false },
    failures,
  }
  await writeFile(outputPath.absolute, JSON.stringify(report, null, 2) + "\n", "utf8")
  return report
}

function argumentValue(args: ReadonlyArray<string>, flag: string) {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1] : undefined
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const releaseGate = argumentValue(args, "--release-gate")
  const releaseManifest = argumentValue(args, "--release-manifest")
  const canaryReceipt = argumentValue(args, "--canary-receipt")
  const output = argumentValue(args, "--output")
  if (!releaseGate || !releaseManifest || !canaryReceipt || !output) {
    throw new Error("--release-gate, --release-manifest, --canary-receipt and --output are required")
  }
  const report = await composeStage8ReleaseEvidence({ releaseGate, releaseManifest, canaryReceipt, output })
  console.log(JSON.stringify({ status: report.status, output, failedChecks: report.failures.length }))
  if (report.status !== "pass") process.exitCode = 1
}
