type JsonRecord = Record<string, unknown>

export type Stage8EvidenceContractID =
  | "baseline_and_multi_agent_gain"
  | "child_remote_capability_revocation"
  | "background_task_visibility_stop_audit"
  | "tenant_rls_backup_delete_drill"
  | "signed_release_rollback"

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

function requiredTrue(record: JsonRecord, keys: ReadonlyArray<string>, prefix: string) {
  return keys.flatMap((key) => (record[key] === true ? [] : [`${prefix}.${key} must be true`]))
}

function requiredFalse(record: JsonRecord, keys: ReadonlyArray<string>, prefix: string) {
  return keys.flatMap((key) => (record[key] === false ? [] : [`${prefix}.${key} must be false`]))
}

function requireEnvelope(value: JsonRecord, evidenceType: Stage8EvidenceContractID) {
  const reasons: string[] = []
  if (value.schema_version !== 1) reasons.push("schema_version must be 1")
  if (value.status !== "pass") reasons.push("status must be pass")
  if (value.evidence_type !== evidenceType) reasons.push(`evidence_type must be ${evidenceType}`)
  return reasons
}

function validateLocalIntegration(value: JsonRecord, evidenceType: Stage8EvidenceContractID) {
  const reasons = requireEnvelope(value, evidenceType)
  if (value.evidence_class !== "local-integration") reasons.push("evidence_class must be local-integration")
  const checks = value.checks
  if (!isRecord(checks)) reasons.push("checks must be an object")
  else {
    reasons.push(
      ...requiredTrue(
        checks,
        [
          "test_process_succeeded",
          "expected_suite_pass_count",
          "required_behavior_tests_exercised",
          "no_secret_values_printed",
        ],
        "checks",
      ),
    )
  }
  const safety = value.safety
  if (!isRecord(safety)) reasons.push("safety must be an object")
  else reasons.push(...requiredFalse(safety, ["secrets_printed", "external_network", "production_data_changed"], "safety"))
  return reasons
}

function validateTenant(value: JsonRecord) {
  const reasons = requireEnvelope(value, "tenant_rls_backup_delete_drill")
  const checks = value.checks
  if (!isRecord(checks)) reasons.push("checks must be an object")
  else {
    reasons.push(
      ...requiredTrue(
        checks,
        [
          "rls_delete_drill_passed",
          "backup_restore_drill_passed",
          "no_recovery_row_mismatch",
          "no_secret_values_printed",
          "no_business_data_committed",
        ],
        "checks",
      ),
    )
  }
  const reports = value.reports
  if (!isRecord(reports)) reasons.push("reports must be an object")
  else {
    for (const key of ["rls_delete", "backup_recovery"]) {
      const report = reports[key]
      if (!isRecord(report)) {
        reasons.push(`reports.${key} must be an object`)
        continue
      }
      if (typeof report.path !== "string" || report.path.length === 0) reasons.push(`reports.${key}.path is required`)
      if (!isSha256(report.sha256)) reasons.push(`reports.${key}.sha256 must be SHA-256`)
    }
  }
  const safety = value.safety
  if (!isRecord(safety)) reasons.push("safety must be an object")
  else reasons.push(...requiredFalse(safety, ["secrets_printed", "business_data_committed"], "safety"))
  return reasons
}

function validateBaseline(value: JsonRecord) {
  const reasons = requireEnvelope(value, "baseline_and_multi_agent_gain")
  const evidenceClass = value.evidence_class
  if (evidenceClass !== "deepseek-live-experiment" && evidenceClass !== "staging-integration") {
    reasons.push("evidence_class must identify a real live/staging experiment")
  }
  if (value.source !== "live" && value.source !== "staging") reasons.push("source must be live or staging")
  for (const mode of ["baseline", "multi"]) {
    const metrics = value[mode]
    if (!isRecord(metrics)) {
      reasons.push(`${mode} must be an object`)
      continue
    }
    const sampleSize = metrics.sampleSize
    const succeeded = metrics.succeeded
    if (!isSafeInteger(sampleSize) || sampleSize < 3) {
      reasons.push(`${mode}.sampleSize must be at least 3`)
    }
    if (!isSafeInteger(succeeded) || succeeded !== sampleSize) {
      reasons.push(`${mode}.succeeded must equal sampleSize`)
    }
  }
  const comparison = value.comparison
  if (!isRecord(comparison)) reasons.push("comparison must be an object")
  else {
    if (comparison.status !== "pass") reasons.push("comparison.status must be pass")
    if (comparison.quantitative_gain !== true) reasons.push("comparison.quantitative_gain must be true")
    if (typeof comparison.metric !== "string" || comparison.metric.length === 0) reasons.push("comparison.metric is required")
  }
  const safety = value.safety
  if (!isRecord(safety)) reasons.push("safety must be an object")
  else reasons.push(...requiredFalse(safety, ["secrets_printed", "production_data_changed", "staging_data_changed"], "safety"))
  return reasons
}

function validateSignedRelease(value: JsonRecord) {
  const reasons = requireEnvelope(value, "signed_release_rollback")
  if (value.evidence_class !== "release-gate") reasons.push("evidence_class must be release-gate")
  if (typeof value.source_report_path !== "string" || value.source_report_path.length === 0) {
    reasons.push("source_report_path is required")
  }
  if (!isSha256(value.source_report_sha256)) reasons.push("source_report_sha256 must be SHA-256")
  const gate = value.release_gate
  if (!isRecord(gate)) reasons.push("release_gate must be an object")
  else {
    if (gate.schema_version !== 1) reasons.push("release_gate.schema_version must be 1")
    if (gate.decision !== "SHIP") reasons.push("release_gate.decision must be SHIP")
    const checks = gate.checks
    if (!isRecord(checks)) reasons.push("release_gate.checks must be an object")
    else reasons.push(...requiredTrue(checks, ["signedReleaseEvidence", "slo", "canary", "releaseOwner"], "release_gate.checks"))
    if (!Array.isArray(gate.reasons) || gate.reasons.length !== 0) reasons.push("release_gate.reasons must be empty")
    const digests = gate.evidence_digests
    if (!isRecord(digests)) reasons.push("release_gate.evidence_digests must be an object")
    else {
      reasons.push(
        ...["release_manifest_sha256", "slo_report_sha256", "canary_receipt_sha256"].flatMap((key) =>
          isSha256(digests[key]) ? [] : [`release_gate.evidence_digests.${key} must be SHA-256`],
        ),
      )
    }
  }
  const rollback = value.rollback
  if (!isRecord(rollback)) reasons.push("rollback must be an object")
  else {
    if (!isSha256(rollback.artifact_digest)) reasons.push("rollback.artifact_digest must be SHA-256")
    if (!isSha256(rollback.rollback_artifact_digest)) reasons.push("rollback.rollback_artifact_digest must be SHA-256")
    if (rollback.artifact_digest === rollback.rollback_artifact_digest) reasons.push("rollback digests must differ")
  }
  const safety = value.safety
  if (!isRecord(safety)) reasons.push("safety must be an object")
  else reasons.push(...requiredFalse(safety, ["secrets_printed"], "safety"))
  return reasons
}

export function validateStage8EvidenceContract(id: Stage8EvidenceContractID, value: unknown): ReadonlyArray<string> {
  if (!isRecord(value)) return ["evidence report is not a JSON object"]
  switch (id) {
    case "child_remote_capability_revocation":
    case "background_task_visibility_stop_audit":
      return validateLocalIntegration(value, id)
    case "tenant_rls_backup_delete_drill":
      return validateTenant(value)
    case "baseline_and_multi_agent_gain":
      return validateBaseline(value)
    case "signed_release_rollback":
      return validateSignedRelease(value)
  }
  return ["unsupported evidence contract"]
}
