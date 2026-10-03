import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "../../..")

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error("expected JSON object")
  return value
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string")
}

function hasStringID(value: unknown): value is { id: string } {
  return isRecord(value) && typeof value.id === "string"
}

function hasStringAlert(value: unknown): value is { id: string; severity: string } {
  return isRecord(value) && typeof value.id === "string" && typeof value.severity === "string"
}

test("Step 8.10 release operations keep signed release fail-closed", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/desktop-signed-candidate.yml"), "utf8")
  const runbook = await readFile(resolve(root, "docs/RELEASE_OPERATIONS_RUNBOOK.md"), "utf8")
  const onboarding = await readFile(resolve(root, "docs/RELEASE_ENVIRONMENT_ONBOARDING.md"), "utf8")
  const packageManifest = parseRecord(await readFile(resolve(root, "package.json"), "utf8"))
  const gateSpec = parseRecord(await readFile(resolve(root, "specs/release-gate-v1.json"), "utf8"))
  const canarySpec = parseRecord(await readFile(resolve(root, "specs/canary-receipt-v1.json"), "utf8"))
  const preflightSpec = parseRecord(
    await readFile(resolve(root, "specs/release-environment-preflight-v1.json"), "utf8"),
  )
  const stage8Spec = parseRecord(await readFile(resolve(root, "specs/stage-8-exit-v1.json"), "utf8"))
  const stage8Runbook = await readFile(resolve(root, "docs/STAGE_8_EXIT_GATE.md"), "utf8")
  if (!isStringRecord(packageManifest.scripts)) throw new Error("package scripts must be a string record")

  expect(workflow).toContain("--signature-evidence desktop/release-evidence/signed-candidate.json")
  expect(workflow).toContain("--require-clean")
  expect(workflow).toContain("--require-signed")
  expect(workflow).toContain("desktop/release-evidence/sbom.cdx.json")
  expect(runbook).toContain("candidate 不等于 signed")
  expect(runbook).toContain("没有 DigiCert/其他受信 provider 的真实证据时")
  expect(onboarding).toContain("desktop-release-candidate")
  expect(onboarding).toContain("SM_CLIENT_CERT_FILE_B64")
  expect(onboarding).toContain("ARFORGE_STAGING_CREDENTIAL_SCOPE")
  expect(onboarding).toContain("不能进入 Stage 8 退出 manifest")
  expect(workflow).toContain("SM_CLIENT_CERT_FILE_B64")
  expect(workflow).toContain("ARFORGE_WINDOWS_KEYPAIR_ALIAS")
  expect(workflow).toContain("ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT")
  expect(runbook).toContain("ops:slo:evaluate")
  expect(runbook).toContain("ops:release:gate")
  expect(packageManifest.scripts["ops:slo:evaluate"]).toBe("bun run script/evaluate-slo.ts")
  expect(packageManifest.scripts["ops:canary:run"]).toBe("bun run script/run-canary.ts")
  expect(packageManifest.scripts["ops:release:gate"]).toBe("bun run script/release-gate.ts")
  expect(gateSpec.default_cli_policy).toContain("DO_NOT_SHIP exits nonzero")
  expect(canarySpec.endpoint).toBe("/global/health")
  expect(canarySpec.safety).toMatchObject({ base_url_credentials: false, business_payloads: false, max_requests: 100 })
  expect(preflightSpec.safety).toMatchObject({
    values_logged: false,
    secret_values_logged: false,
    default_missing_status: "blocked",
  })
  expect(stage8Spec.default_missing_status).toBe("DO_NOT_EXIT")
  expect(stage8Runbook).toContain("audit:stage8:exit")
})

test("Step 8.10 SLO specification contains critical isolation and recovery alerts", async () => {
  const specification = parseRecord(await readFile(resolve(root, "specs/ops-slo-v1.json"), "utf8"))
  if (typeof specification.schema_version !== "number") throw new Error("SLO schema version must be numeric")
  if (!Array.isArray(specification.slos) || !specification.slos.every(hasStringID))
    throw new Error("SLO ids are invalid")
  if (!Array.isArray(specification.alerts) || !specification.alerts.every(hasStringAlert))
    throw new Error("SLO alerts are invalid")
  if (!isRecord(specification.evidence_contract)) throw new Error("SLO evidence contract is invalid")
  if (
    typeof specification.evidence_contract.evaluator !== "string" ||
    typeof specification.evidence_contract.missing_or_invalid_data !== "string"
  ) {
    throw new Error("SLO evidence contract fields are invalid")
  }

  expect(specification.schema_version).toBe(1)
  expect(specification.slos.map((item) => item.id)).toEqual([
    "api.availability",
    "api.latency.p95",
    "tenant.isolation",
    "backup.restore",
    "migration.integrity",
  ])
  expect(specification.alerts.filter((item) => item.severity === "page").map((item) => item.id)).toEqual([
    "critical.tenant-isolation",
    "critical.migration-or-backup",
  ])
  expect(specification.evidence_contract).toMatchObject({
    evaluator: "@arforge-ai/core/runtime/slo",
    missing_or_invalid_data: "unknown_and_do_not_ship",
  })
})
