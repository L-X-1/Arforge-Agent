import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { auditToolPipelineTopology } from "./arforge-tool-pipeline-topology"

async function fixture(files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arforge-tool-topology-"))
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return root
}

test("rejects new Native, Sandbox and AI SDK executable owners", async () => {
  const root = await fixture({
    "packages/arforge/src/rogue.ts": `
      import { tool } from "ai"
      declare const NativeTool: { make(input: unknown): unknown }
      declare const SandboxTool: { make(input: unknown): unknown }
      NativeTool.make({})
      SandboxTool.make({})
      tool({})
    `,
  })
  const report = await auditToolPipelineTopology(root, { enforceRequiredSeams: false })
  expect(report.valid).toBe(false)
  expect(report.findings.filter((finding) => finding.code === "ATP-001")).toHaveLength(3)
})

test("uses declaration provenance to reject a renamed mature Tool.Def executor", async () => {
  const root = await fixture({
    "packages/arforge/src/tool/tool.ts": `export interface Def { execute(input: unknown): unknown }`,
    "packages/arforge/src/rogue.ts": `
      import type { Def } from "./tool/tool"
      export const bypass = (candidate: Def) => candidate.execute({})
    `,
  })
  const report = await auditToolPipelineTopology(root, { enforceRequiredSeams: false })
  expect(report.valid).toBe(false)
  expect(report.findings).toContainEqual(
    expect.objectContaining({ code: "ATP-002", path: "packages/arforge/src/rogue.ts" }),
  )
})

test("accepts the sole provenance-bearing plugin source definition adapter", async () => {
  const root = await fixture({
    "packages/plugin/src/tool.ts": `export interface ToolDefinition { execute(input: unknown): unknown }`,
    "packages/arforge/src/tool/plugin-source-adapter.ts": `
      import type { ToolDefinition } from "../../../plugin/src/tool"
      export const make = (definition: ToolDefinition) => ({
        origin: { kind: "plugin", permission: "plugin_tool" },
        execute: (input: unknown) => definition.execute(input),
      })
    `,
  })
  const report = await auditToolPipelineTopology(root, { enforceRequiredSeams: false })
  expect(report.valid).toBe(true)
  expect(report.counts.definitions).toBe(1)
  expect(report.sites).toContainEqual(
    expect.objectContaining({ kind: "plugin-source-definition", disposition: "definition" }),
  )
})

test("records the Core-backed provider adapter as transport-only and structured output as transitional", async () => {
  const root = await fixture({
    "packages/arforge/src/session/tools.ts": `import { tool } from "ai"; materialized.settle({}); tool({})`,
    "packages/arforge/src/session/prompt.ts": `import { tool } from "ai"; tool({})`,
  })
  const report = await auditToolPipelineTopology(root, { enforceRequiredSeams: false })
  expect(report.valid).toBe(true)
  expect(report.fully_canonical).toBe(false)
  expect(report.counts.transport_only).toBe(1)
  expect(report.counts.transitional).toBe(1)
  expect(report.sites.map((site) => site.kind)).toEqual([
    "structured-output-adapter",
    "provider-tool-transport-adapter",
  ])
})

test("fails closed when the canonical bridge and runner ordering seams are absent", async () => {
  const root = await fixture({ "packages/arforge/src/empty.ts": "export {}" })
  const report = await auditToolPipelineTopology(root)
  expect(report.valid).toBe(false)
  expect(report.findings.some((finding) => finding.code === "ATP-003")).toBe(true)
  expect(report.findings.some((finding) => finding.path === "packages/arforge/src/session/execution-formal.ts")).toBe(
    true,
  )
})

test("requires the source resolver on both Formal paths and rejects the old shared-registration seam", async () => {
  const run = "SessionRunner.Service.use(runner => runner.run({}))"
  const bind = "Effect.provideService(SessionRunner.ExternalTools, toolBridge.snapshot)"
  for (const [source, rejected] of [
    [`${run}.pipe(${bind}); ${run}.pipe(${bind})`, false],
    [`${run}.pipe(${bind}); ${run}`, true],
    [`toolBridge.register(sessionID); ${run}; ${run}`, true],
  ] as const) {
    const root = await fixture({ "packages/arforge/src/session/execution-formal.ts": source })
    const report = await auditToolPipelineTopology(root)
    expect(report.findings.some((finding) => finding.path === "packages/arforge/src/session/execution-formal.ts")).toBe(
      rejected,
    )
  }
})
