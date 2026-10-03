import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { canonicalJson, sha256Text } from "./arforge-governance"
import {
  buildTsCompositionArtifact,
  validateTsCompositionArtifact,
  writeTsCompositionArtifact,
} from "./arforge-ts-composition-ledger"

const ownerPath = "docs/evidence/implementation/owner-registry.v1.json"
const topologyPath = "docs/evidence/implementation/ts-session-composition.v1.json"
const attestationPath = "docs/evidence/implementation/attestations/ts-session-composition.v1.sha256"

const writeFixture = async (files: Record<string, string>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-ts-composition-"))
  await mkdir(path.join(root, "docs/evidence/implementation/attestations"), { recursive: true })
  const registry = {
    schema_version: "1.0",
    registry_id: "ts-owner-registry",
    entries: [{ domain: "session", public_entrypoints: ["packages/arforge/src/session/entry.ts"] }],
  }
  await writeFile(path.join(root, ownerPath), JSON.stringify(registry, null, 2) + "\n")
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, source)
  }
  return root
}

const validFiles = {
  "packages/arforge/src/session/entry.ts": "export const entry = true\n",
  "packages/arforge/src/server/root.ts": [
    'import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"',
    'import { SessionExecution } from "@arforge-ai/core/session/execution"',
    'import { SessionExecutionFormal } from "@/session/execution-formal"',
    "export const layer = AppNodeBuilderV1.build(AppNodeBuilderV1.node, [[SessionExecution.node, SessionExecutionFormal.node]])",
  ].join("\n"),
  "packages/arforge/src/session/execution-formal.ts":
    "import { SessionRunner } from '@arforge-ai/core/session/runner'\nexport const run = SessionRunner.Service\n",
}

test("deterministic topology artifact records a single service binding and canonical Formal adapter", async () => {
  const root = await writeFixture(validFiles)
  const first = await buildTsCompositionArtifact(root)
  const second = await buildTsCompositionArtifact(root)
  expect(canonicalJson(first)).toBe(canonicalJson(second))
  expect(first.composition_root_count).toBe(1)
  expect(first.composition_binding_count).toBe(1)
  expect(first.invariants.composition_bindings_have_one_provider).toBe(true)
  expect(first.invariants.no_external_runner_service_use).toBe(true)
  expect(first.contract.transitional_runner_paths).toEqual([])
})

test("composition provider resolution follows the builder span instead of line proximity", async () => {
  const root = await writeFixture({
    ...validFiles,
    "packages/arforge/src/server/root.ts": [
      'import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"',
      'import { SessionExecution } from "@arforge-ai/core/session/execution"',
      'import { SessionExecutionFormal } from "@/session/execution-formal"',
      "export const layer = AppNodeBuilderV1.build(",
      "  AppNodeBuilderV1.node,",
      "  [",
      "    [SessionExecution.node, SessionExecutionFormal.node],",
      "  ],",
      ")",
    ].join("\\n"),
  })
  const artifact = await buildTsCompositionArtifact(root)
  expect(artifact.composition_binding_count).toBe(1)
  expect(artifact.invariants.composition_bindings_have_one_provider).toBe(true)
})

test("validator rejects a direct runner service bypass outside canonical executor files", async () => {
  const root = await writeFixture({
    ...validFiles,
    "packages/arforge/src/session/caller.ts":
      "import { SessionRunner } from '@arforge-ai/core/session/runner'\nexport const bypass = SessionRunner.Service\n",
  })
  await writeTsCompositionArtifact(root)
  const report = await validateTsCompositionArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY101-006")).toBe(true)
})

test("validator rejects a restored Mature provider and runner even at the old privileged path", async () => {
  const root = await writeFixture({
    ...validFiles,
    "packages/arforge/src/server/root.ts": validFiles["packages/arforge/src/server/root.ts"]
      .replaceAll("SessionExecutionFormal", "SessionExecutionMature")
      .replaceAll("execution-formal", "execution"),
    "packages/arforge/src/session/execution.ts":
      "import { SessionRunner } from '@arforge-ai/core/session/runner'; export const run = SessionRunner.Service",
  })
  await writeTsCompositionArtifact(root)
  const report = await validateTsCompositionArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY101-005")).toBe(true)
  expect(report.findings.some((finding) => finding.code === "PY101-006")).toBe(true)
})

test("validator rejects an unresolved composition provider", async () => {
  const root = await writeFixture({
    "packages/arforge/src/session/entry.ts": validFiles["packages/arforge/src/session/entry.ts"],
    "packages/arforge/src/server/root.ts":
      'import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"\nimport { SessionExecution } from "@arforge-ai/core/session/execution"\nexport const layer = AppNodeBuilder.build(AppNodeBuilder.node, [[SessionExecution.node]])\n',
  })
  await writeTsCompositionArtifact(root)
  const report = await validateTsCompositionArtifact(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "PY101-005")).toBe(true)
})

test("validator binds the detached topology attestation and catches stale bytes", async () => {
  const root = await writeFixture(validFiles)
  await writeTsCompositionArtifact(root)
  const valid = await validateTsCompositionArtifact(root)
  expect(valid.valid).toBe(true)
  await writeFile(
    path.join(root, topologyPath),
    (await readFile(path.join(root, topologyPath), "utf8")).replace('"status": "OPEN"', '"status": "CLOSED"'),
  )
  const stale = await validateTsCompositionArtifact(root)
  expect(stale.valid).toBe(false)
  expect(stale.findings.some((finding) => finding.code === "PY101-002")).toBe(true)
  expect(await readFile(path.join(root, attestationPath), "utf8")).toBe(
    "sha256:" + sha256Text(canonicalJson(await buildTsCompositionArtifact(root))) + "\n",
  )
})
