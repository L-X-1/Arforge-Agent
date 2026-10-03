import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { canonicalJson, sha256Text } from "./arforge-governance"
import { validateCapabilityLinks, CAPABILITY_LINKS_PATH } from "./arforge-capability-links"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-capability-links-"))
  const inputs = ["old.py", "owner.ts", "test.ts"]
  for (const file of inputs) await writeFile(path.join(root, file), file)
  await writeFile(path.join(root, "result.json"), '{"result":"fixture-only"}')
  const record = {
    id: "CLI-UNKNOWN",
    behavior: "Unknown commands preserve stderr and exit code",
    aliases: ["old unknown", "new unknown"],
    classification: "equivalent-needs-verification",
    legacy: [{ path: "old.py", symbol: "main" }],
    owner: { path: "owner.ts", symbol: "main" },
    scenarios: [{ id: "error", kind: "error", test_path: "test.ts", selector: "unknown command", expected: "exit 2" }],
    limitations: ["Error boundary only; no normal or recovery acceptance"],
  }
  const receipt = {
    contract_digest: sha256Text(canonicalJson(record)),
    inputs: inputs.map((file) => ({ path: file, digest: sha256Text(file) })),
    artifact: { path: "result.json", digest: sha256Text('{"result":"fixture-only"}') },
    scenario_ids: ["error"],
    outcome: "passed",
    command: "fixture test only",
    environment: "isolated synthetic fixture",
    scope: "error boundary only",
  }
  const manifest = { schema_version: "1.0", records: [{ ...record, receipt }] }
  const save = async () => {
    await mkdir(path.dirname(path.join(root, CAPABILITY_LINKS_PATH)), { recursive: true })
    await writeFile(path.join(root, CAPABILITY_LINKS_PATH), JSON.stringify(manifest))
  }
  await save()
  return { root, manifest, save }
}

test("fresh reported results never become functional acceptance", async () => {
  const { root } = await fixture()
  const report = await validateCapabilityLinks(root)
  expect(report.valid).toBe(true)
  expect(report.records[0]?.evidence_state).toBe("current-reported-pass")
  expect(report.records[0]?.accepted).toBe(false)
})

test("unrelated edits do not expire declared capability inputs; related same-size edits do", async () => {
  const { root } = await fixture()
  await writeFile(path.join(root, "unrelated.ts"), "change")
  expect((await validateCapabilityLinks(root)).valid).toBe(true)
  await writeFile(path.join(root, "owner.ts"), "OWNER.TS")
  const report = await validateCapabilityLinks(root)
  expect(report.valid).toBe(false)
  expect(report.records[0]?.evidence_state).toBe("invalid")
})

test("manifest validation is read-only, pending records stay pending", async () => {
  const { root, manifest, save } = await fixture()
  Reflect.deleteProperty(manifest.records[0]!, "receipt")
  await save()
  const before = await readFile(path.join(root, CAPABILITY_LINKS_PATH), "utf8")
  expect((await validateCapabilityLinks(root)).records[0]?.evidence_state).toBe("missing")
  expect(await readFile(path.join(root, CAPABILITY_LINKS_PATH), "utf8")).toBe(before)
})

test("changed expectation invalidates a receipt even when sources are unchanged", async () => {
  const { root, manifest, save } = await fixture()
  manifest.records[0]!.scenarios[0]!.expected = "exit 0"
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
})

test("duplicate acceptance IDs and aliases cannot double count", async () => {
  const { root, manifest, save } = await fixture()
  manifest.records.push(manifest.records[0]!)
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
  manifest.records[1] = { ...manifest.records[0]!, id: "OTHER" }
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
})

test("missing input bindings, evidence tamper and unbound scenarios fail closed", async () => {
  const { root, manifest, save } = await fixture()
  const receipt = manifest.records[0]!.receipt
  receipt.inputs.pop()
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
  receipt.inputs.push({ path: "test.ts", digest: sha256Text("test.ts") })
  receipt.scenario_ids = ["nonexistent"]
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
  receipt.scenario_ids = ["error"]
  await save()
  await writeFile(path.join(root, "result.json"), "tampered")
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
})

test("malformed documents and traversal return findings instead of throwing", async () => {
  const { root, manifest, save } = await fixture()
  manifest.records[0]!.owner.path = "../outside.ts"
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
  await writeFile(path.join(root, CAPABILITY_LINKS_PATH), '{"records":[null]}')
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
})

test("linked parent paths cannot bind external source inputs", async () => {
  const { root, manifest, save } = await fixture()
  const outside = await mkdtemp(path.join(os.tmpdir(), "arforge-link-outside-"))
  await writeFile(path.join(outside, "owner.ts"), "external")
  await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir")
  manifest.records[0]!.owner.path = "linked/owner.ts"
  Reflect.deleteProperty(manifest.records[0]!, "receipt")
  await save()
  const report = await validateCapabilityLinks(root)
  expect(report.valid).toBe(false)
  expect(report.findings[0]?.detail).toContain("link")
  expect(await readFile(path.join(outside, "owner.ts"), "utf8")).toBe("external")
})

test("unknown acceptance flags are rejected, failed results are reported without accepting", async () => {
  const { root, manifest, save } = await fixture()
  Object.assign(manifest.records[0]!, { accepted: true })
  await save()
  expect((await validateCapabilityLinks(root)).valid).toBe(false)
  Reflect.deleteProperty(manifest.records[0]!, "accepted")
  manifest.records[0]!.receipt.outcome = "failed"
  await save()
  const report = await validateCapabilityLinks(root)
  expect(report.valid).toBe(true) // structurally current, NOT a test-success gate
  expect(report.records[0]).toMatchObject({ accepted: false, evidence_state: "current-reported-failure" })
})

test("user-facing read-only CLI emits parseable reports and nonzero for broken bindings", async () => {
  const { root, manifest, save } = await fixture()
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(import.meta.dir, "arforge-migration-freshness.ts"), "validate-capability-links", "--root", root],
      { encoding: "utf8", timeout: 30_000, windowsHide: true },
    )
  const first = run()
  expect(first.status).toBe(0)
  expect(JSON.parse(first.stdout).records[0].accepted).toBe(false)
  manifest.records[0]!.owner.path = "missing.ts"
  await save()
  const second = run()
  expect(second.status).toBe(1)
  expect(JSON.parse(second.stdout).findings.length).toBeGreaterThan(0)
})
