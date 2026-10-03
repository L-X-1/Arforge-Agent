import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validatePythonTestsLedger, writePythonTestsLedger } from "./arforge-python-tests-ledger"

const ledgerPath = "docs/evidence/implementation/legacy-python-tests.json"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-python-tests-ledger-"))
  await mkdir(path.join(root, "tests/legacy_script"), { recursive: true })
  await mkdir(path.join(root, "arforge/acceptance/projects/demo/tests/integration"), { recursive: true })
  await mkdir(path.join(root, ".codex-tmp/tests"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation"), { recursive: true })
  await writeFile(path.join(root, "fixture-owner.ts"), "export const Service = true\n")
  await writeFile(path.join(root, "tests/test_sample.py"), "def test_unit():\n    assert True\n")
  await writeFile(path.join(root, "tests/legacy_script/legacy_case.py"), "def legacy_case():\n    return True\n")
  await writeFile(path.join(root, "arforge/acceptance/projects/demo/tests/integration/test_api.py"), "class TestApi:\n    def test_integration(self):\n        assert True\n")
  await writeFile(path.join(root, ".codex-tmp/tests/test_hidden.py"), "def test_hidden():\n    raise RuntimeError\n")
  const domains = ["session", "action", "tool", "memory", "workflow", "mcp", "subagent", "cli", "context", "sandbox", "invariant"]
  await writeFile(
    path.join(root, "docs/evidence/implementation/owner-registry.v1.json"),
    JSON.stringify({
      schema_version: "1.0",
      registry_id: "ts-owner-registry",
      manifest_digest: "fixture",
      entries: domains.map((domain) => ({ domain, service_owner: { path: "fixture-owner.ts", symbols: ["Service"] } })),
    }, null, 2),
  )
  return root
}

test("generator scopes test and acceptance assets and excludes snapshots", async () => {
  const root = await fixture()
  const generated = await writePythonTestsLedger(root)
  expect(generated.python_file_count).toBe(3)
  expect(generated.test_leaf_count).toBeGreaterThan(0)
  const report = await validatePythonTestsLedger(root)
  expect(report.valid).toBe(true)
  expect(report.findings).toHaveLength(0)
})

test("source drift is rejected", async () => {
  const root = await fixture()
  await writePythonTestsLedger(root)
  await writeFile(path.join(root, "tests/test_sample.py"), "def test_changed():\n    assert False\n")
  const report = await validatePythonTestsLedger(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY005-006")).toBe(true)
})

test("tampered leaf projection and stale attestation are rejected", async () => {
  const root = await fixture()
  await writePythonTestsLedger(root)
  const artifact = JSON.parse(await readFile(path.join(root, ledgerPath), "utf8")) as { test_leaves: Array<Record<string, unknown>> }
  artifact.test_leaves[0].leaf_id = artifact.test_leaves[1].leaf_id
  await writeFile(path.join(root, ledgerPath), JSON.stringify(artifact, null, 2))
  const report = await validatePythonTestsLedger(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY005-003" || finding.code === "PY005-010")).toBe(true)
})
