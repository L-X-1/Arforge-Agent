import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { SkillCompiler, SkillCompileError } from "@arforge-ai/core/skill-compiler"

const experience = AgentRuntime.ExperienceRecord.make({
  id: AgentRuntime.ExperienceID.make("exp_release_compiler"),
  runID: AgentRuntime.RunID.make("run_release_compiler"),
  outcome: "success",
  summary: "verified release checks",
  evidenceIDs: [AgentRuntime.EvidenceID.make("evd_release_compiler")],
  reusable: true,
  createdAt: DateTime.makeUnsafe(1_725_000_000_000),
})

const input = {
  skillID: "release-compiler",
  version: "1.0.0",
  purpose: "Run verified release checks",
  triggers: ["release"],
  allowedTools: ["read"],
  allowedCapabilities: [],
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  instructions: "# Release\nRun the verified release checklist.",
  assets: [{ path: "notes.txt", content: "release notes" }],
  scripts: [{ path: "check.txt", content: "safe deterministic fixture" }],
  experiences: [experience],
  testCases: [{ id: "release-basic", input: { task: "release" }, expected: { success: true } }],
  evaluationID: "eva_release_compiler",
  policyVersion: "skill-policy-v1",
  now: 1_725_000_000_000,
}

describe("SkillCompiler", () => {
  test("writes only a deterministic candidate artifact and pending gates", () => {
    const root = join(process.env.TEMP ?? process.cwd(), `arforge-skill-compiler-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
    try {
      const compiler = new SkillCompiler({ root })
      const first = compiler.compile(input)
      const second = compiler.compile(input)
      expect(second.skill.digest).toBe(first.skill.digest)
      expect(first.skill.status).toBe("candidate")
      expect(first.scan.passed).toBe(true)
      expect(first.evaluationRequest).toMatchObject({ status: "pending", evaluationID: "eva_release_compiler" })
      expect(first.approvalRequest).toMatchObject({ status: "pending", requiredActor: "human" })
      expect(readFileSync(join(first.candidatePath, "SKILL.md"), "utf8")).toContain("verified release")
      const manifest = JSON.parse(readFileSync(join(first.candidatePath, "manifest.json"), "utf8"))
      expect(manifest.skill.status).toBe("candidate")
      expect(manifest.tests).toHaveLength(1)
      expect(readdirSync(join(root, "candidates"))).toEqual(["release-compiler"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects unverified sources and unsafe path/script/network content", () => {
    const root = join(process.env.TEMP ?? process.cwd(), `arforge-skill-compiler-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
    try {
      const compiler = new SkillCompiler({ root })
      expect(() => compiler.compile({ ...input, experiences: [] })).toThrow("at least one verified Experience")
      expect(() => compiler.compile({ ...input, scripts: [{ path: "../escape.js", content: "safe" }] })).toThrow(
        "unsafe artifact path",
      )
      expect(() =>
        compiler.compile({ ...input, scripts: [{ path: "network.js", content: "fetch('https://example.com')" }] }),
      ).toThrow(SkillCompileError)
      expect(() =>
        compiler.compile({
          ...input,
          scripts: [{ path: "secret.js", content: "token=sk-abcdefghijklmnopqrstuvwxyz123456" }],
        }),
      ).toThrow("candidate security scan failed")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
