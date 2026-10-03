import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { canonicalJson, sha256Text } from "./arforge-governance"
import { validateOwnerRegistry } from "./arforge-owner-registry"

const domains = ["session", "action", "tool", "memory", "workflow", "mcp", "subagent", "cli", "context", "sandbox", "invariant"]
const manifestPath = "docs/evidence/implementation/protocol-bootstrap.v1.json"
const registryPath = "docs/evidence/implementation/owner-registry.v1.json"
const attestationPath = "docs/evidence/implementation/attestations/owner-registry.v1.sha256"

const validManifest = {
  schema_version: "1.0",
  protocol: "arforge-development-governance",
  plan_revision: "v1.3",
  source_revision: "test-source",
}

const makeRegistry = (manifestDigest: string) => ({
  schema_version: "1.0",
  registry_id: "ts-owner-registry",
  plan_revision: "v1.3",
  protocol_manifest: manifestPath,
  manifest_digest: manifestDigest,
  source_revision: "test-source",
  ledger_writer: "manual-dispatcher-bootstrap",
  status: "REGISTERED",
  required_domains: domains,
  forbidden_parallel_names: ["DeepSeekLoop", "DeepSeekToolPipeline", "DeepSeekCheckpoint", "PythonCompatRuntime"],
  entries: domains.map((domain) => ({
    domain,
    status: "REGISTERED",
    disposition: "MERGE",
    schema_owner: { path: "src/owner.ts", symbols: ["Schema"] },
    service_owner: { path: "src/owner.ts", symbols: ["Service"] },
    store_owner: { path: "src/owner.ts", symbols: ["Store"] },
    writer_owner: { path: "src/owner.ts", symbols: ["Writer"] },
    executor_owner: { path: "src/owner.ts", symbols: ["Executor"] },
    public_entrypoints: ["src/owner.ts"],
    forbidden_parallel_truths: ["second owner"],
    evidence_refs: ["evidence.md"],
  })),
})

async function writeFixture(registryOverride?: (registry: ReturnType<typeof makeRegistry>) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-owner-registry-"))
  await mkdir(path.join(root, "docs/evidence/implementation/attestations"), { recursive: true })
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(
    path.join(root, "src/owner.ts"),
    "export const Schema = true\nexport const Service = true\nexport const Store = true\nexport const Writer = true\nexport const Executor = true\nexport const owner = true\n",
  )
  await writeFile(path.join(root, "evidence.md"), "fixture evidence\n")
  const manifestDigest = sha256Text(canonicalJson(validManifest))
  const registry = makeRegistry(manifestDigest)
  registryOverride?.(registry)
  await writeFile(path.join(root, manifestPath), JSON.stringify(validManifest, null, 2))
  await writeFile(path.join(root, registryPath), JSON.stringify(registry, null, 2))
  await writeFile(path.join(root, attestationPath), "sha256:" + sha256Text(canonicalJson(registry)) + "\n")
  return root
}

test("valid owner registry passes and binds to manifest", async () => {
  const report = await validateOwnerRegistry(await writeFixture())
  expect(report.valid).toBe(true)
  expect(report.findings).toHaveLength(0)
})

test("duplicate domain is rejected", async () => {
  const report = await validateOwnerRegistry(
    await writeFixture((registry) => {
      registry.entries.push({ ...registry.entries[0] })
    }),
  )
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY001-003")).toBe(true)
})

test("Python runtime owner and missing path are rejected", async () => {
  const report = await validateOwnerRegistry(
    await writeFixture((registry) => {
      registry.entries[0].executor_owner.path = "arforge/legacy.py"
    }),
  )
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY001-009")).toBe(true)
  expect(report.findings.some((finding) => finding.code === "PY001-002")).toBe(true)
})

test("stale detached attestation is rejected", async () => {
  const root = await writeFixture()
  await writeFile(path.join(root, attestationPath), "sha256:stale\n")
  const report = await validateOwnerRegistry(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY001-004")).toBe(true)
})

test("owner symbol drift is rejected even when the file still exists", async () => {
  const report = await validateOwnerRegistry(
    await writeFixture((registry) => {
      registry.entries[0].service_owner.symbols = ["MissingService"]
    }),
  )
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY001-010")).toBe(true)
})

test("governed source rejects a forbidden parallel Python bridge export", async () => {
  const root = await writeFixture()
  await writeFile(path.join(root, "src/owner.ts"), "export const Schema = true\nexport const Service = true\nexport const Store = true\nexport const Writer = true\nexport const Executor = true\nexport const PythonBridge = true\n")
  const report = await validateOwnerRegistry(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY001-011")).toBe(true)
})
