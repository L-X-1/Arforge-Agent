import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { expect, test } from "bun:test"
import { STAGE8_EXIT_CHECK_IDS, auditStage8Exit, type Stage8EvidenceItem } from "../../../script/audit-stage8-exit"

const root = resolve(import.meta.dir, "../../..")

async function digest(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

function missingEvidence(): Record<(typeof STAGE8_EXIT_CHECK_IDS)[number], Stage8EvidenceItem> {
  return {
    baseline_and_multi_agent_gain: { status: "missing", note: "not supplied" },
    child_remote_capability_revocation: { status: "missing", note: "not supplied" },
    background_task_visibility_stop_audit: { status: "missing", note: "not supplied" },
    tenant_rls_backup_delete_drill: { status: "missing", note: "not supplied" },
    signed_release_rollback: { status: "missing", note: "not supplied" },
  }
}

function validEvidenceReport(id: (typeof STAGE8_EXIT_CHECK_IDS)[number]) {
  if (id === "child_remote_capability_revocation" || id === "background_task_visibility_stop_audit") {
    return {
      schema_version: 1,
      evidence_type: id,
      evidence_class: "local-integration",
      status: "pass",
      checks: {
        test_process_succeeded: true,
        expected_suite_pass_count: true,
        required_behavior_tests_exercised: true,
        no_secret_values_printed: true,
      },
      safety: { secrets_printed: false, external_network: false, production_data_changed: false },
    }
  }
  if (id === "tenant_rls_backup_delete_drill") {
    return {
      schema_version: 1,
      evidence_type: id,
      status: "pass",
      checks: {
        rls_delete_drill_passed: true,
        backup_restore_drill_passed: true,
        no_recovery_row_mismatch: true,
        no_secret_values_printed: true,
        no_business_data_committed: true,
      },
      reports: {
        rls_delete: { path: "artifacts/rls.json", sha256: "a".repeat(64) },
        backup_recovery: { path: "artifacts/recovery.json", sha256: "b".repeat(64) },
      },
      safety: { secrets_printed: false, business_data_committed: false },
    }
  }
  if (id === "baseline_and_multi_agent_gain") {
    return {
      schema_version: 1,
      evidence_type: id,
      evidence_class: "deepseek-live-experiment",
      status: "pass",
      source: "live",
      baseline: { sampleSize: 3, succeeded: 3 },
      multi: { sampleSize: 3, succeeded: 3 },
      comparison: { status: "pass", quantitative_gain: true, metric: "p95_duration_ms" },
      safety: { secrets_printed: false, production_data_changed: false, staging_data_changed: false },
    }
  }
  return {
    schema_version: 1,
    evidence_type: id,
    evidence_class: "release-gate",
    status: "pass",
    source_report_path: "artifacts/release-gate.json",
    source_report_sha256: "a".repeat(64),
    release_gate: {
      schema_version: 1,
      decision: "SHIP",
      checks: { signedReleaseEvidence: true, slo: true, canary: true, releaseOwner: true },
      evidence_digests: {
        release_manifest_sha256: "a".repeat(64),
        slo_report_sha256: "b".repeat(64),
        canary_receipt_sha256: "c".repeat(64),
      },
      reasons: [],
    },
    rollback: { artifact_digest: "d".repeat(64), rollback_artifact_digest: "e".repeat(64) },
    safety: { secrets_printed: false },
  }
}

test("stage 8 exit audit stays blocked when required evidence is missing", async () => {
  const report = await auditStage8Exit(root, {
    schema_version: 1,
    checkpoint: { commit: "a".repeat(40), tree: "b".repeat(40) },
    evidence: missingEvidence(),
  })

  expect(report.decision).toBe("DO_NOT_EXIT")
  expect(report.checks).toHaveLength(5)
  expect(report.checks.every((check) => check.status === "missing" && !check.digest_verified)).toBe(true)
  expect(report.reasons).toHaveLength(5)
})

test("stage 8 exit audit requires every pass item to bind an existing file digest", async () => {
  const directory = await mkdtemp(join(root, "artifacts", "stage8-exit-test-"))
  try {
    const evidence = missingEvidence()
    for (const [index, id] of STAGE8_EXIT_CHECK_IDS.entries()) {
      const path = join(directory, index + ".json")
      await writeFile(path, JSON.stringify(validEvidenceReport(id)), "utf8")
      evidence[id] = {
        status: "pass",
        evidence_path: path.slice(root.length + 1).replaceAll("\\", "/"),
        sha256: await digest(path),
      }
    }
    const report = await auditStage8Exit(root, {
      schema_version: 1,
      checkpoint: { commit: "c".repeat(40), tree: "d".repeat(40) },
      evidence,
    })

    expect(report).toMatchObject({ decision: "EXIT", reasons: [] })
    expect(report.checks.every((check) => check.status === "pass" && check.digest_verified)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stage 8 exit audit rejects an arbitrary status pass document", async () => {
  const directory = await mkdtemp(join(root, "artifacts", "stage8-exit-contract-test-"))
  try {
    const evidence = missingEvidence()
    for (const [index, id] of STAGE8_EXIT_CHECK_IDS.entries()) {
      const path = join(directory, index + ".json")
      await writeFile(path, JSON.stringify({ status: "pass" }), "utf8")
      evidence[id] = {
        status: "pass",
        evidence_path: path.slice(root.length + 1).replaceAll("\\", "/"),
        sha256: await digest(path),
      }
    }
    const report = await auditStage8Exit(root, {
      schema_version: 1,
      checkpoint: { commit: "a".repeat(40), tree: "b".repeat(40) },
      evidence,
    })

    expect(report.decision).toBe("DO_NOT_EXIT")
    expect(report.checks.every((check) => check.status === "fail" && check.digest_verified)).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("stage 8 exit audit rejects tampered and outside-root evidence", async () => {
  const directory = await mkdtemp(join(root, "artifacts", "stage8-exit-tamper-test-"))
  try {
    const evidence = missingEvidence()
    const tamperedPath = join(directory, "tampered.json")
    await writeFile(tamperedPath, "actual", "utf8")
    evidence.baseline_and_multi_agent_gain = {
      status: "pass",
      evidence_path: tamperedPath.slice(root.length + 1).replaceAll("\\", "/"),
      sha256: "e".repeat(64),
    }
    evidence.child_remote_capability_revocation = {
      status: "pass",
      evidence_path: "../outside.json",
      sha256: "f".repeat(64),
    }
    const report = await auditStage8Exit(root, {
      schema_version: 1,
      checkpoint: { commit: "e".repeat(40), tree: "f".repeat(40) },
      evidence,
    })

    expect(report.decision).toBe("DO_NOT_EXIT")
    expect(report.checks.find((check) => check.id === "baseline_and_multi_agent_gain")).toMatchObject({
      status: "fail",
      digest_verified: false,
    })
    expect(report.checks.find((check) => check.id === "child_remote_capability_revocation")).toMatchObject({
      status: "fail",
      digest_verified: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
