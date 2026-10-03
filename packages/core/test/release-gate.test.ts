import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { evaluateSloWindow } from "../src/runtime/slo"
import { buildReleaseEvidence } from "../../../script/release-evidence"
import { evaluateReleaseGate } from "../../../script/release-gate"

const root = resolve(import.meta.dir, "../../..")

const passingWindow = {
  startAt: 1_700_000_000_000,
  endAt: 1_700_000_360_000,
  api: { totalRequests: 10_000, goodRequests: 9_995, p95LatencyMs: 420 },
  tenantIsolation: { probeCount: 38, crossScopeViolations: 0, policyBypasses: 0 },
  backupRestore: { attempts: 1, successful: 1, mismatchCount: 0, temporaryDatabaseCleanup: true },
  migrationIntegrity: {
    attempts: 1,
    successful: 1,
    rowCountMismatch: 0,
    rlsChecksPassed: true,
    schemaRevision: "20260814091000",
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isArtifactManifest(value: unknown): value is { files: Array<{ path: string; kind: string; sha256: string }> } {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.kind === "string" &&
        typeof entry.sha256 === "string",
    )
  )
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

test("release gate accepts only mutually digest-bound signed, SLO, canary, and owner evidence", async () => {
  const artifactDir = await mkdtemp(join(root, "artifacts", "release-gate-test-"))
  const evidenceDir = await mkdtemp(join(tmpdir(), "arforge-release-gate-evidence-"))
  const auxiliaryDir = await mkdtemp(join(tmpdir(), "arforge-release-gate-input-"))
  try {
    const artifactPath = join(artifactDir, "candidate.exe")
    await writeFile(artifactPath, "signed-release-gate-fixture", "utf8")
    const artifactDigest = await sha256(artifactPath)
    const artifactName = artifactPath.slice(root.length + 1).replaceAll("\\", "/")
    await writeFile(
      join(artifactDir, "signed-candidate.json"),
      JSON.stringify({
        schema_version: 2,
        status: "pass",
        private_key_export_blocked: true,
        required_reviewers_approved: true,
        signing_material_removed: true,
        artifacts: [
          {
            name: artifactName,
            sha256: artifactDigest,
            signature_status: "Valid",
            timestamped: true,
            signer_subject: "CN=Arforge Test Signer",
          },
        ],
      }),
      "utf8",
    )
    await buildReleaseEvidence({
      root,
      outputDir: evidenceDir,
      artifacts: [artifactPath],
      signatureEvidence: join(artifactDir, "signed-candidate.json"),
      allowDirty: true,
      sourceDateEpoch: "0",
      requireSigned: true,
    })

    const parsedManifest: unknown = JSON.parse(await readFile(join(evidenceDir, "release-manifest.json"), "utf8"))
    if (!isArtifactManifest(parsedManifest)) throw new Error("test release manifest is invalid")
    const manifest = parsedManifest
    const artifactEntry = manifest.files.find((entry) => entry.kind === "artifact")
    if (!artifactEntry) throw new Error("test release manifest has no artifact")
    const sloPath = join(auxiliaryDir, "slo-report.json")
    const canaryPath = join(auxiliaryDir, "canary-receipt.json")
    const ownerPath = join(auxiliaryDir, "release-owner-evidence.json")
    await writeFile(sloPath, JSON.stringify(evaluateSloWindow(passingWindow), null, 2) + "\n", "utf8")
    await writeFile(
      canaryPath,
      JSON.stringify({
        schema_version: 1,
        status: "passed",
        artifact_path: artifactEntry.path,
        artifact_digest: artifactEntry.sha256,
        rollback_artifact_digest: "b".repeat(64),
        cohort: {
          id: "test-cohort",
          traffic_percent: 5,
          observation_start: 1_700_000_000_000,
          observation_end: 1_700_000_360_000,
        },
        target_origin: "https://staging.example.test",
        endpoint: "/global/health",
        observed_requests: 10,
        successful_requests: 10,
        p95_latency_ms: 420,
        error_budget_burn: 0,
        critical_alerts: 0,
        failure_reasons: [],
      }),
      "utf8",
    )
    await writeFile(
      ownerPath,
      JSON.stringify({
        schema_version: 1,
        decision: "SHIP",
        release_owner: "release-owner-test",
        approved_at: "2026-08-14T00:00:00Z",
        artifact_path: artifactEntry.path,
        artifact_digest: artifactEntry.sha256,
        release_manifest_sha256: await sha256(join(evidenceDir, "release-manifest.json")),
        slo_report_sha256: await sha256(sloPath),
        canary_receipt_sha256: await sha256(canaryPath),
        reviewer_ids: ["reviewer-test"],
        checklist: {
          sbom_license_reviewed: true,
          signature_verified: true,
          canary_passed: true,
          slo_passed: true,
          backup_restore_drill_passed: true,
          rollback_artifact_ready: true,
          incident_contact_confirmed: true,
        },
      }),
      "utf8",
    )

    const report = await evaluateReleaseGate({
      root,
      releaseEvidenceDir: evidenceDir,
      sloReportPath: sloPath,
      canaryReceiptPath: canaryPath,
      ownerEvidencePath: ownerPath,
    })
    expect(report).toMatchObject({
      decision: "SHIP",
      checks: { signedReleaseEvidence: true, slo: true, canary: true, releaseOwner: true },
    })
  } finally {
    await rm(artifactDir, { recursive: true, force: true })
    await rm(evidenceDir, { recursive: true, force: true })
    await rm(auxiliaryDir, { recursive: true, force: true })
  }
})

test("release gate remains blocked when any external evidence is absent", async () => {
  const report = await evaluateReleaseGate({
    root,
    releaseEvidenceDir: "artifacts/does-not-exist",
    sloReportPath: "artifacts/does-not-exist/slo.json",
    canaryReceiptPath: "artifacts/does-not-exist/canary.json",
    ownerEvidencePath: "artifacts/does-not-exist/owner.json",
  })

  expect(report.decision).toBe("DO_NOT_SHIP")
  expect(report.checks).toEqual({ signedReleaseEvidence: false, slo: false, canary: false, releaseOwner: false })
  expect(report.reasons.length).toBeGreaterThan(0)
})
