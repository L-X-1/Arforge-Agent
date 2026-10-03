import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  buildTsRunnerNegativeArtifact,
  validateTsRunnerNegativeArtifact,
  writeTsRunnerNegativeArtifact,
} from "./arforge-ts-runner-negative"
import { writeTsCompositionArtifact } from "./arforge-ts-composition-ledger"

const topologyPath = "docs/evidence/implementation/ts-session-composition.v1.json"
const negativePath = "docs/evidence/implementation/ts-runner-negative.v1.json"

const writeFixture = async (rootSource: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-ts-runner-negative-"))
  await mkdir(path.join(root, "docs/evidence/implementation/attestations"), { recursive: true })
  await writeFile(
    path.join(root, "docs/evidence/implementation/owner-registry.v1.json"),
    JSON.stringify({ schema_version: "1.0", registry_id: "ts-owner-registry", entries: [{ domain: "session", public_entrypoints: [] }] }, null, 2) + "\n",
  )
  const files: Record<string, string> = {
    "packages/arforge/src/server/root.ts": rootSource,
    "packages/arforge/src/session/execution.ts": "export const drainScoped = true\n",
  }
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, source)
  }
  await writeTsCompositionArtifact(root)
  return root
}

const singleBinding = [
  'import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"',
  'import { SessionExecution } from "@arforge-ai/core/session/execution"',
  'import { SessionExecutionMature } from "@/session/execution"',
  "export const layer = AppNodeBuilderV1.build(AppNodeBuilderV1.node, [[SessionExecution.node, SessionExecutionMature.node]])",
].join("\n")

test("valid shared-topology negative artifact allows only transitional drainScoped", async () => {
  const root = await writeFixture(singleBinding)
  await writeTsRunnerNegativeArtifact(root)
  const artifact = await buildTsRunnerNegativeArtifact(root)
  const report = await validateTsRunnerNegativeArtifact(root)
  expect(report.valid).toBe(true)
  expect(artifact.selector_signals).toHaveLength(0)
  expect(artifact.transitional_signals.length).toBeGreaterThan(0)
  expect(artifact.duplicate_provider_bindings).toHaveLength(0)
})

test("forbidden option selector is reported from AST, not string matching", async () => {
  const root = await writeFixture(singleBinding.replace("export const layer", "const options = { executionMode: \"local\" }\nexport const layer"))
  await writeTsRunnerNegativeArtifact(root)
  const report = await validateTsRunnerNegativeArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY105-004")).toBe(true)
})

test("duplicate SessionExecution providers in one builder call are rejected", async () => {
  const duplicate = singleBinding.replace(
    "[[SessionExecution.node, SessionExecutionMature.node]]",
    "[[SessionExecution.node, SessionExecutionMature.node], [SessionExecution.node, SessionExecutionMature.node]]",
  )
  const root = await writeFixture(duplicate)
  await writeTsRunnerNegativeArtifact(root)
  const report = await validateTsRunnerNegativeArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY105-005")).toBe(true)
})

test("validator rejects stale negative artifact bytes or attestation", async () => {
  const root = await writeFixture(singleBinding)
  await writeTsRunnerNegativeArtifact(root)
  const artifactPath = path.join(root, negativePath)
  await writeFile(artifactPath, (await readFile(artifactPath, "utf8")).replace('"status": "OPEN"', '"status": "CLOSED"'))
  const report = await validateTsRunnerNegativeArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY105-002")).toBe(true)
  expect(report.findings.some((finding) => finding.code === "PY105-007")).toBe(true)
  expect(await readFile(path.join(root, topologyPath), "utf8")).toContain('"ledger_id": "ts-session-composition"')
})
