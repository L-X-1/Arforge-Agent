import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validatePythonDependenciesLedger, writePythonDependenciesLedger } from "./arforge-python-dependencies-ledger"

const ledgerPath = "docs/evidence/implementation/legacy-python-dependencies.json"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-python-dependencies-"))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await mkdir(path.join(root, "packages/desktop/resources/agent-python-dist"), { recursive: true })
  await mkdir(path.join(root, ".venv/Scripts"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation"), { recursive: true })
  await writeFile(path.join(root, "fixture-owner.ts"), "export const Service = true\n")
  await writeFile(path.join(root, "pyproject.toml"), "[project]\ndependencies = ['pytest']\n")
  await writeFile(path.join(root, "scripts/run.ps1"), "python -m arforge --spawn\n")
  await writeFile(path.join(root, "packages/desktop/package.json"), '{"script":"launch python bridge"}\n')
  await writeFile(path.join(root, "packages/desktop/resources/agent-python-dist/marker.txt"), "artifact\n")
  await writeFile(
    path.join(root, "docs/evidence/implementation/owner-registry.v1.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        registry_id: "ts-owner-registry",
        entries: [
          "session",
          "action",
          "tool",
          "memory",
          "workflow",
          "mcp",
          "subagent",
          "cli",
          "context",
          "sandbox",
          "invariant",
        ].map((domain) => ({ domain, service_owner: { path: "fixture-owner.ts", symbols: ["Service"] } })),
      },
      null,
      2,
    ),
  )
  return root
}

test("generator records dependency, launch and artifact footprints without executing them", async () => {
  const root = await fixture()
  const generated = await writePythonDependenciesLedger(root)
  expect(generated.scanned_file_count).toBeGreaterThan(0)
  expect(generated.dependency_leaf_count).toBeGreaterThan(0)
  expect(generated.asset_count).toBe(6)
  const report = await validatePythonDependenciesLedger(root)
  expect(report.valid).toBe(true)
  expect(report.findings).toHaveLength(0)
})

test("dependency source drift is rejected", async () => {
  const root = await fixture()
  await writePythonDependenciesLedger(root)
  await writeFile(path.join(root, "scripts/run.ps1"), "python -m changed\n")
  const report = await validatePythonDependenciesLedger(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY007-006")).toBe(true)
})

test("directory footprint detects same-size replacement through tree digest", async () => {
  const root = await fixture()
  await writePythonDependenciesLedger(root)
  await writeFile(path.join(root, "packages/desktop/resources/agent-python-dist/marker.txt"), "content\n")
  const report = await validatePythonDependenciesLedger(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY007-008")).toBe(true)
})

test("tampered artifact and attestation are rejected", async () => {
  const root = await fixture()
  await writePythonDependenciesLedger(root)
  const artifact = JSON.parse(await readFile(path.join(root, ledgerPath), "utf8")) as {
    dependency_leaves: Array<Record<string, unknown>>
  }
  artifact.dependency_leaves[0].status = "CLOSED"
  await writeFile(path.join(root, ledgerPath), JSON.stringify(artifact, null, 2))
  const report = await validatePythonDependenciesLedger(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY007-007" || finding.code === "PY007-010")).toBe(true)
})

test("volatile Playwright test outputs are excluded from the dependency source ledger", async () => {
  const root = await fixture()
  await mkdir(path.join(root, "packages/app/e2e/test-results/performance/traces/resources"), { recursive: true })
  await mkdir(path.join(root, "packages/app/e2e/playwright-report/performance/data"), { recursive: true })
  await writeFile(
    path.join(root, "packages/app/e2e/test-results/performance/traces/resources/volatile.json"),
    '{"python":"generated trace"}\n',
  )
  await writeFile(
    path.join(root, "packages/app/e2e/playwright-report/performance/data/volatile.md"),
    "generated python report\n",
  )

  await writePythonDependenciesLedger(root)
  const artifact = JSON.parse(await readFile(path.join(root, ledgerPath), "utf8")) as {
    scanned_files: Array<{ path: string }>
  }
  expect(artifact.scanned_files.some((entry) => entry.path.includes("test-results"))).toBe(false)
  expect(artifact.scanned_files.some((entry) => entry.path.includes("playwright-report"))).toBe(false)
  expect((await validatePythonDependenciesLedger(root)).valid).toBe(true)
})
