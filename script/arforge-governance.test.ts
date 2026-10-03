import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  canonicalJson,
  CasConflictError,
  compareAndSwapFile,
  sha256Text,
  validateBootstrap,
  validateClaim,
  validateManifest,
} from "./arforge-governance"

const manifestPath = "docs/evidence/implementation/protocol-bootstrap.v1.json"
const statePath = "docs/evidence/implementation/state.json"
const claimPath = "docs/evidence/implementation/claims/BOOTSTRAP-PROTOCOL-001.json"
const baselinePath = "docs/evidence/implementation/bootstrap/baseline-dirty-manifest.v1.json"
const cardPath = "docs/evidence/implementation/cards/BOOTSTRAP-PROTOCOL-001.md"
const attestationPath = "docs/evidence/implementation/attestations/protocol-bootstrap.v1.sha256"
const canonicalPaths = {
  cards_root: "docs/evidence/implementation/cards",
  state_root: statePath,
  claims_root: "docs/evidence/implementation/claims",
  evidence_root: "docs/evidence/implementation",
}

const validManifest = {
  schema_version: "1.0",
  protocol: "arforge-development-governance",
  plan_revision: "v1.3",
  source_revision: "test-source",
  ledger_owner: "manual-dispatcher-bootstrap",
  ledger_writer: "manual-dispatcher-bootstrap",
  ...canonicalPaths,
  claim_protocol: "CAS",
  claim_version_field: "version",
  pre_review_claim_whitelist: [
    "BOOTSTRAP-PROTOCOL-001",
    "PY-001-OWNER-REGISTRY-001",
    "PY-002-CAPABILITY-LEDGER-001",
    "PY-005-TEST-FIXTURE-LEDGER-001",
    "PY-007-DEPENDENCY-ARTIFACT-LEDGER-001",
  ],
  validators: ["LP-001", "LP-002", "LP-003", "LP-004"],
  gate_owner: "Plan Owner",
  detached_attestation_ref: attestationPath,
}

const validBaseline = {
  schema_version: "1.0",
  captured_at_utc: "2026-08-24T00:00:00.000Z",
  repository_root: "E:/Arforge-Agent",
  branch: "test-branch",
  head_commit: "test-source",
  status_digest: "a".repeat(64),
  entry_count: 0,
  entries: [],
  target_paths: [manifestPath, statePath, claimPath, baselinePath, cardPath, attestationPath],
  dispatcher_artifacts: [],
}

async function writeFixture(overrides?: {
  readonly state?: Record<string, unknown>
  readonly claim?: Record<string, unknown>
  readonly manifest?: Record<string, unknown>
  readonly baseline?: Record<string, unknown>
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-governance-"))
  await mkdir(path.join(root, "docs/evidence/implementation/bootstrap"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation/cards"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation/claims"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation/attestations"), { recursive: true })

  const manifest = { ...validManifest, ...overrides?.manifest }
  const cardText = "# fixture card\n"
  const manifestDigest = sha256Text(canonicalJson(manifest))
  const cardDigest = sha256Text(cardText)
  const claim = {
    schema_version: "1.0",
    claim_id: "BOOTSTRAP-PROTOCOL-001",
    owner: "manual-dispatcher-bootstrap",
    version: 1,
    status: "ACTIVE",
    protocol_manifest: manifestPath,
    protocol_manifest_digest: sha256Text(canonicalJson(manifest)),
    baseline_manifest: baselinePath,
    allowed_paths: [
      manifestPath,
      statePath,
      claimPath,
      baselinePath,
      cardPath,
      attestationPath,
      "script/arforge-governance.ts",
      "script/arforge-governance.test.ts",
    ],
    ...overrides?.claim,
  }
  const state = {
    schema_version: "1.0",
    manifest_path: manifestPath,
    card_path: cardPath,
    manifest_digest: manifestDigest,
    card_digest: cardDigest,
    status: "REVIEW_PENDING",
    canonical_paths: canonicalPaths,
    active_claim: { claim_id: "BOOTSTRAP-PROTOCOL-001", version: 1, claim_path: claimPath },
    ...overrides?.state,
  }

  await writeFile(path.join(root, manifestPath), JSON.stringify(manifest, null, 2))
  await writeFile(path.join(root, statePath), JSON.stringify(state, null, 2))
  await writeFile(path.join(root, claimPath), JSON.stringify(claim, null, 2))
  await writeFile(path.join(root, baselinePath), JSON.stringify({ ...validBaseline, ...overrides?.baseline }, null, 2))
  await writeFile(path.join(root, cardPath), cardText)
  await writeFile(path.join(root, attestationPath), "sha256:" + manifestDigest + "\n")
  return root
}

test("canonicalJson is deterministic across object insertion order", () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }))
})

test("validateManifest rejects path and schema drift", () => {
  const findings = validateManifest(
    { ...validManifest, schema_version: "2.0", cards_root: "../outside" },
    "E:/Arforge-Agent",
  )
  expect(findings.map((finding) => finding.code)).toContain("LP-001")
  expect(findings.map((finding) => finding.code)).toContain("LP-002")
})

test("validateClaim rejects version drift and unsafe paths", () => {
  const findings = validateClaim(
    {
      claim_id: "BOOTSTRAP-PROTOCOL-001",
      owner: "manual-dispatcher-bootstrap",
      version: 2,
      status: "ACTIVE",
      allowed_paths: ["../outside"],
    },
    validManifest,
    { active_claim: { claim_id: "BOOTSTRAP-PROTOCOL-001", version: 1 } },
    "E:/Arforge-Agent",
  )
  expect(findings.map((finding) => finding.code)).toContain("LP-006")
  expect(findings.map((finding) => finding.code)).toContain("LP-002")
})

test("valid bootstrap fixture passes structural validation", async () => {
  const root = await writeFixture()
  const report = await validateBootstrap(root)
  expect(report.valid).toBe(true)
  expect(report.status).toBe("REVIEW_PENDING")
})

test("closed status is not accepted as a bootstrap pre-review state", async () => {
  const root = await writeFixture({ state: { status: "CLOSED" } })
  const report = await validateBootstrap(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.path === statePath)).toBe(true)
})

test("review-pending claim is valid after an explicit dispatcher handoff", () => {
  const findings = validateClaim(
    {
      ...{
        schema_version: "1.0",
        claim_id: "BOOTSTRAP-PROTOCOL-001",
        owner: "manual-dispatcher-bootstrap",
        version: 1,
        status: "REVIEW_PENDING",
        protocol_manifest: manifestPath,
        protocol_manifest_digest: sha256Text(canonicalJson(validManifest)),
        baseline_manifest: baselinePath,
        allowed_paths: [manifestPath, statePath, claimPath, baselinePath, cardPath, attestationPath],
      },
    },
    validManifest,
    {
      active_claim: { claim_id: "PY-001-OWNER-REGISTRY-001", version: 1, claim_path: "docs/evidence/implementation/claims/PY-001-OWNER-REGISTRY-001.json" },
      review_pending_claims: [{ claim_id: "BOOTSTRAP-PROTOCOL-001", version: 1, claim_path: claimPath }],
    },
    "E:/Arforge-Agent",
    claimPath,
    "BOOTSTRAP-PROTOCOL-001",
  )
  expect(findings.filter((finding) => finding.code === "LP-006")).toHaveLength(0)
})

test("accepted claim is valid after an independent review settlement", () => {
  const findings = validateClaim(
    {
      schema_version: "1.0",
      claim_id: "BOOTSTRAP-PROTOCOL-001",
      owner: "manual-dispatcher-bootstrap",
      version: 1,
      status: "ACCEPTED",
      protocol_manifest: manifestPath,
      protocol_manifest_digest: sha256Text(canonicalJson(validManifest)),
      baseline_manifest: baselinePath,
      allowed_paths: [manifestPath, statePath, claimPath, baselinePath, cardPath, attestationPath],
    },
    validManifest,
    { accepted_claims: [{ claim_id: "BOOTSTRAP-PROTOCOL-001", version: 1, claim_path: claimPath }] },
    "E:/Arforge-Agent",
    claimPath,
    "BOOTSTRAP-PROTOCOL-001",
  )
  expect(findings.filter((finding) => finding.code === "LP-006")).toHaveLength(0)
})

test("baseline rejects unsafe paths and unverifiable file metadata", async () => {
  const root = await writeFixture({
    baseline: {
      entry_count: 1,
      entries: [{ path: "../outside", kind: "file", content_digest: "stale", size: -1 }],
    },
  })
  const report = await validateBootstrap(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "LP-002")).toBe(true)
  expect(report.findings.filter((finding) => finding.code === "LP-004").length).toBeGreaterThanOrEqual(2)
})

test("state card reference rejects a stale card digest", async () => {
  const root = await writeFixture({
    state: {
      active_card: {
        card_id: "BOOTSTRAP-PROTOCOL-001",
        card_path: cardPath,
        card_digest: "0".repeat(64),
        status: "REVIEW_PENDING",
      },
    },
  })
  const report = await validateBootstrap(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "LP-004" && finding.path.includes("active_card"))).toBe(true)
})

test("compare-and-swap rejects a stale writer and commits an expected version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-governance-cas-"))
  await writeFile(path.join(root, "state.json"), JSON.stringify({ version: 1 }) + "\n")
  const current = await readFile(path.join(root, "state.json"), "utf8")
  const digest = sha256Text(current)
  const nextDigest = await compareAndSwapFile(root, "state.json", digest, { version: 2 })
  expect(nextDigest).toBe(sha256Text(JSON.stringify({ version: 2 }, null, 2) + "\n"))
  await expect(compareAndSwapFile(root, "state.json", digest, { version: 3 })).rejects.toBeInstanceOf(CasConflictError)
})
