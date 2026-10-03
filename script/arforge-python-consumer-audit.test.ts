import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildPythonConsumerAudit,
  validatePythonConsumerAudit,
  writePythonConsumerAudit,
} from "./arforge-python-consumer-audit"

const reportPath = "docs/evidence/implementation/python-leaf-consumers.v1.json"
const attestationPath = "docs/evidence/implementation/attestations/python-leaf-consumers.v1.sha256"
const pythonLedgerAttestationPath = "docs/evidence/implementation/attestations/python-ledger.v1.sha256"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-python-consumer-audit-"))
  await mkdir(path.join(root, "arforge"), { recursive: true })
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "tests"), { recursive: true })
  await mkdir(path.join(root, "packages/core/src"), { recursive: true })
  await mkdir(path.join(root, "packages/arforge/src/cli/cmd"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation/attestations"), { recursive: true })
  await writeFile(path.join(root, "arforge/trust_screen.py"), "def is_workspace_trusted():\n    return True\n")
  await writeFile(
    path.join(root, "arforge/workspace_roots.py"),
    "from arforge.trust_screen import is_workspace_trusted\n\ndef authorized_workspace_roots():\n    return []\n",
  )
  await writeFile(
    path.join(root, "arforge/consumer.py"),
    "from arforge.trust_screen import is_workspace_trusted\nfrom arforge.workspace_roots import authorized_workspace_roots\n",
  )
  await writeFile(path.join(root, "tests/test_workspace.py"), "import arforge.workspace_roots\n")
  await writeFile(path.join(root, "arforge/cli.py"), "from arforge.cli_bridge import main as unified_main\n")
  await writeFile(path.join(root, "arforge/__main__.py"), "from arforge.cli_bridge import main\n")
  await writeFile(path.join(root, "main.py"), "from arforge.cli_bridge import main\n")
  await writeFile(
    path.join(root, "packages/core/src/workspace-roots.ts"),
    "export function isPersistedWorkspaceTrusted() {}\nexport function isWorkspaceTrusted() {}\nexport function configuredWorkspaceRoots() {}\nexport function authorizedWorkspaceRoots() {}\nexport function workspaceRootsReport() {}\n",
  )
  await writeFile(path.join(root, "packages/arforge/src/cli/cmd/workspace.ts"), "export const WorkspaceCommand = {}\n")
  await writeFile(path.join(root, pythonLedgerAttestationPath), "sha256:" + "0".repeat(64) + "\n")
  await writeFile(path.join(root, attestationPath), "sha256:" + "0".repeat(64) + "\n")
  return root
}

test("audit records remaining legacy consumers and binds the TS owners", async () => {
  const root = await fixture()
  const generated = await writePythonConsumerAudit(root)
  expect(generated.target_count).toBe(2)
  expect(generated.remaining_consumer_count).toBe(4)
  const artifact = JSON.parse(await readFile(path.join(root, reportPath), "utf8")) as {
    targets: Array<{ module: string; consumers: Array<{ path: string; lane: string }> }>
    ts_runtime_python_imports: string[]
    retirement_review: { status: string; consumer_free: boolean; deletion_authorized: boolean; blockers: string[] }
    retirement_policy: { current_decision: string }
  }
  expect(artifact.ts_runtime_python_imports).toEqual([])
  expect(artifact.retirement_review.status).toBe("blocked")
  expect(artifact.retirement_review.consumer_free).toBe(false)
  expect(artifact.retirement_review.deletion_authorized).toBe(false)
  expect(artifact.retirement_review.blockers).toEqual([
    "legacy-consumers-remain",
    "compatibility-boundary-retained",
    "workspace-writer-gate-disabled",
  ])
  expect(artifact.retirement_policy.current_decision).toBe("retain-compatibility-boundary")
  expect(artifact.targets.find((target) => target.module === "arforge.trust_screen")?.consumers).toContainEqual({
    path: "arforge/consumer.py",
    line: 1,
    reference_kind: "from-import",
    lane: "legacy-python-runtime",
  })
  const report = await validatePythonConsumerAudit(root)
  expect(report.valid).toBe(true)
  expect(report.findings).toHaveLength(0)
})

test("TS runtime Python imports fail closed", async () => {
  const root = await fixture()
  await writePythonConsumerAudit(root)
  await writeFile(path.join(root, "packages/core/src/forbidden.ts"), 'import "arforge.trust_screen"\n')
  const report = await validatePythonConsumerAudit(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY016-015")).toBe(true)
})

test("detects dynamically assembled legacy module references", async () => {
  const root = await fixture()
  await writeFile(
    path.join(root, "scripts/legacy-audit.py"),
    'TRUST = "arforge." + "trust_screen"\nWORKSPACE = "arforge." + "workspace_roots"\n',
  )
  const artifact = await buildPythonConsumerAudit(root)
  expect(artifact.remaining_consumer_count).toBe(6)
  expect(artifact.targets.find((target) => target.module === "arforge.trust_screen")?.consumers).toContainEqual({
    path: "scripts/legacy-audit.py",
    line: 1,
    reference_kind: "dynamic-module-string",
    lane: "governance-script",
  })
  expect(artifact.targets.find((target) => target.module === "arforge.workspace_roots")?.consumers).toContainEqual({
    path: "scripts/legacy-audit.py",
    line: 2,
    reference_kind: "dynamic-module-string",
    lane: "governance-script",
  })
})

test("source drift and a stale attestation are rejected", async () => {
  const root = await fixture()
  await writePythonConsumerAudit(root)
  await writeFile(path.join(root, "arforge/trust_screen.py"), "def changed():\n    return False\n")
  const report = await validatePythonConsumerAudit(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY016-011" || finding.code === "PY016-014")).toBe(true)
  await writeFile(path.join(root, attestationPath), "sha256:" + "1".repeat(64) + "\n")
  const stale = await validatePythonConsumerAudit(root)
  expect(stale.findings.some((finding) => finding.code === "PY016-016")).toBe(true)
})

test("the audit builder is deterministic", async () => {
  const root = await fixture()
  const first = await buildPythonConsumerAudit(root)
  const second = await buildPythonConsumerAudit(root)
  expect(JSON.stringify(first)).toBe(JSON.stringify(second))
})

test("retirement review digest fails closed when deletion evidence is tampered", async () => {
  const root = await fixture()
  await writePythonConsumerAudit(root)
  const report = JSON.parse(await readFile(path.join(root, reportPath), "utf8")) as {
    retirement_review: { deletion_authorized: boolean }
  }
  report.retirement_review.deletion_authorized = true
  await writeFile(path.join(root, reportPath), JSON.stringify(report, null, 2) + "\n")
  const validation = await validatePythonConsumerAudit(root)
  expect(validation.valid).toBe(false)
  expect(validation.findings.some((finding) => finding.code === "PY016-014" || finding.code === "PY016-019")).toBe(true)
})
