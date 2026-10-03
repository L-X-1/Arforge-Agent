import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { expect, test } from "bun:test"
import { composeStage8ReleaseEvidence } from "../../../script/compose-stage8-release-evidence"

const root = resolve(import.meta.dir, "../../..")

async function digest(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function repoRelative(path: string) {
  return relative(root, path).replaceAll("\\", "/")
}

test("stage 8 signed release evidence composer requires bound signed and rollback inputs", async () => {
  const directory = await mkdtemp(join(root, "artifacts", "stage8-release-evidence-test-"))
  try {
    const manifestPath = join(directory, "release-manifest.json")
    const canaryPath = join(directory, "canary.json")
    const gatePath = join(directory, "gate.json")
    const outputPath = join(directory, "evidence.json")
    await writeFile(
      manifestPath,
      JSON.stringify({ schema_version: 1, status: "signed", signature: { status: "signed", verified: true } }),
      "utf8",
    )
    await writeFile(
      canaryPath,
      JSON.stringify({
        schema_version: 1,
        status: "passed",
        artifact_path: "artifact/app.exe",
        artifact_digest: "a".repeat(64),
        rollback_artifact_digest: "b".repeat(64),
        endpoint: "/global/health",
        observed_requests: 10,
        successful_requests: 10,
        critical_alerts: 0,
        failure_reasons: [],
      }),
      "utf8",
    )
    await writeFile(
      gatePath,
      JSON.stringify({
        schema_version: 1,
        decision: "SHIP",
        checks: { signedReleaseEvidence: true, slo: true, canary: true, releaseOwner: true },
        reasons: [],
        evidence_digests: {
          release_manifest_sha256: await digest(manifestPath),
          slo_report_sha256: "c".repeat(64),
          canary_receipt_sha256: await digest(canaryPath),
        },
      }),
      "utf8",
    )

    const passed = await composeStage8ReleaseEvidence({
      root,
      releaseGate: repoRelative(gatePath),
      releaseManifest: repoRelative(manifestPath),
      canaryReceipt: repoRelative(canaryPath),
      output: repoRelative(outputPath),
    })
    expect(passed.status).toBe("pass")
    expect(passed.failures).toEqual([])

    await writeFile(
      gatePath,
      JSON.stringify({
        schema_version: 1,
        decision: "DO_NOT_SHIP",
        checks: { signedReleaseEvidence: false, slo: true, canary: true, releaseOwner: true },
        reasons: ["signature missing"],
        evidence_digests: {
          release_manifest_sha256: await digest(manifestPath),
          slo_report_sha256: "c".repeat(64),
          canary_receipt_sha256: await digest(canaryPath),
        },
      }),
      "utf8",
    )
    const blocked = await composeStage8ReleaseEvidence({
      root,
      releaseGate: repoRelative(gatePath),
      releaseManifest: repoRelative(manifestPath),
      canaryReceipt: repoRelative(canaryPath),
      output: repoRelative(outputPath),
    })
    expect(blocked.status).toBe("fail")
    expect(blocked.failures).toContain("release gate is not a complete SHIP report")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
