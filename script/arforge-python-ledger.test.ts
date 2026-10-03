import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { canonicalJson } from "./arforge-governance"
import { validatePythonLedgers, writeLedgers } from "./arforge-python-ledger"

const capabilitiesPath = "docs/evidence/implementation/legacy-python-capabilities.json"
const filesPath = "docs/evidence/implementation/legacy-python-files.json"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-python-ledger-"))
  await mkdir(path.join(root, "arforge"), { recursive: true })
  await mkdir(path.join(root, "docs/evidence/implementation"), { recursive: true })
  await writeFile(
    path.join(root, "arforge/session.py"),
    "import os\n\nclass Session:\n    def run(self):\n        return open('x').read()\n",
  )
  await writeFile(path.join(root, "arforge/misc.py"), "def helper(value):\n    return value\n")
  const ownerRegistry = {
    schema_version: "1.0",
    registry_id: "ts-owner-registry",
    manifest_digest: "manifest-fixture",
    entries: [
      { domain: "session", service_owner: { path: "packages/core/src/session.ts", symbols: ["Session.Service"] } },
      { domain: "invariant", service_owner: { path: "packages/core/src/session.ts", symbols: ["Session.Service"] } },
    ],
  }
  await writeFile(
    path.join(root, "docs/evidence/implementation/owner-registry.v1.json"),
    JSON.stringify(ownerRegistry, null, 2),
  )
  return root
}

test("generator creates a complete open ledger and validator accepts it", async () => {
  const root = await fixture()
  const generated = await writeLedgers(root)
  expect(generated.python_file_count).toBe(2)
  expect(generated.capability_leaf_count).toBe(3)
  const report = await validatePythonLedgers(root)
  expect(report.valid).toBe(true)
  expect(report.findings).toHaveLength(0)
})

test("source drift is rejected until the ledger is regenerated", async () => {
  const root = await fixture()
  await writeLedgers(root)
  await writeFile(path.join(root, "arforge/session.py"), "def changed():\n    return False\n")
  const report = await validatePythonLedgers(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY002-006")).toBe(true)
})

test("tampered leaf projection is rejected", async () => {
  const root = await fixture()
  await writeLedgers(root)
  const artifact = JSON.parse(await readFile(path.join(root, capabilitiesPath), "utf8")) as {
    capabilities: Array<Record<string, unknown>>
  }
  artifact.capabilities[0].leaf_id = artifact.capabilities[1].leaf_id
  await writeFile(path.join(root, capabilitiesPath), JSON.stringify(artifact, null, 2))
  const report = await validatePythonLedgers(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY002-003" || finding.code === "PY002-010")).toBe(true)
})

test("file projection remains derived from leaf ids", async () => {
  const root = await fixture()
  await writeLedgers(root)
  const artifact = JSON.parse(await readFile(path.join(root, filesPath), "utf8")) as {
    files: Array<Record<string, unknown>>
  }
  const first = artifact.files[0]
  first.leaf_ids = []
  first.leaf_count = 0
  await writeFile(path.join(root, filesPath), JSON.stringify(artifact, null, 2))
  const report = await validatePythonLedgers(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY002-007" || finding.code === "PY002-010")).toBe(true)
  expect(canonicalJson(artifact).length).toBeGreaterThan(0)
})

test("reverse consumer evidence resolves imported package members", async () => {
  const root = await fixture()
  await mkdir(path.join(root, "arforge/tools"), { recursive: true })
  await writeFile(path.join(root, "arforge/tools/__init__.py"), "")
  await writeFile(path.join(root, "arforge/tools/lsp_tools.py"), "def language_service_status():\n    return {}\n")
  await writeFile(
    path.join(root, "consumer.py"),
    [
      "from arforge.tools import lsp_tools",
      "from arforge.tools import (",
      "    lsp_tools as imported_lsp,",
      ")",
      "import arforge.tools.lsp_tools as direct_lsp",
      "registry = 'arforge.tools.lsp_tools'",
      "assert lsp_tools and imported_lsp and direct_lsp",
      "",
    ].join("\n"),
  )

  await writeLedgers(root)
  const artifact = JSON.parse(await readFile(path.join(root, filesPath), "utf8")) as {
    files: Array<{ file_path: string; consumer_refs: string[] }>
  }
  const lsp = artifact.files.find((file) => file.file_path === "arforge/tools/lsp_tools.py")
  expect(lsp?.consumer_refs).toContain("consumer.py")
})
