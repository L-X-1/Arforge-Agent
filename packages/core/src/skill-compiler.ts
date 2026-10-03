export * as SkillCompilerV1 from "./skill-compiler"

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DateTime } from "effect"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import * as SkillContract from "@arforge-ai/schema/skill-v1"
import { createCandidate } from "./skill-v1"
import { canonicalHash } from "./util/canonical-hash"

export interface CompilerFile {
  readonly path: string
  readonly content: string
}

export interface CompilerTestCase {
  readonly id: string
  readonly input: Readonly<Record<string, unknown>>
  readonly expected: Readonly<Record<string, unknown>>
}

export interface CompileInput {
  readonly skillID: string
  readonly version: string
  readonly purpose: string
  readonly triggers: ReadonlyArray<string>
  readonly allowedTools: ReadonlyArray<string>
  readonly allowedCapabilities: ReadonlyArray<string>
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly outputSchema: Readonly<Record<string, unknown>>
  readonly instructions: string
  readonly assets?: ReadonlyArray<CompilerFile>
  readonly scripts?: ReadonlyArray<CompilerFile>
  readonly experiences: ReadonlyArray<AgentRuntime.ExperienceRecord>
  readonly testCases: ReadonlyArray<CompilerTestCase>
  readonly evaluationID?: string
  readonly policyVersion: string
  readonly now?: number
}

export interface ScanFinding {
  readonly kind: "path" | "command" | "secret" | "network"
  readonly path: string
  readonly rule: string
  readonly detail: string
}

export interface SecurityScan {
  readonly passed: boolean
  readonly findings: ReadonlyArray<ScanFinding>
  readonly digest: string
}

export interface DeterministicTest {
  readonly testID: string
  readonly input: Readonly<Record<string, unknown>>
  readonly expected: Readonly<Record<string, unknown>>
  readonly digest: string
}

export interface CompiledCandidate {
  readonly skill: SkillContract.Skill
  readonly candidatePath: string
  readonly tests: ReadonlyArray<DeterministicTest>
  readonly scan: SecurityScan
  readonly evaluationRequest: {
    readonly status: "pending"
    readonly candidateDigest: string
    readonly evaluationID?: string
    readonly testIDs: ReadonlyArray<string>
  }
  readonly approvalRequest: {
    readonly status: "pending"
    readonly candidateDigest: string
    readonly requiredActor: "human"
  }
}

/** Database-ready compiler result. This path performs no filesystem writes. */
export interface CompiledArtifact {
  readonly skill: SkillContract.Skill
  readonly files: ReadonlyArray<CompilerFile>
  readonly tests: ReadonlyArray<DeterministicTest>
  readonly scan: SecurityScan
  readonly manifest: Readonly<Record<string, unknown>>
  readonly evaluationRequest: CompiledCandidate["evaluationRequest"]
  readonly approvalRequest: CompiledCandidate["approvalRequest"]
}

export class SkillCompileError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = "SkillCompileError"
  }
}

export interface SkillCompilerOptions {
  readonly root: string
  readonly maxFiles?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

const defaultLimits = { maxFiles: 64, maxFileBytes: 100_000, maxTotalBytes: 1_000_000 } as const
type CompilerLimits = { readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number }

const compilerLimits = (options: Omit<SkillCompilerOptions, "root"> = {}): CompilerLimits => {
  const limits = {
    maxFiles: options.maxFiles ?? defaultLimits.maxFiles,
    maxFileBytes: options.maxFileBytes ?? defaultLimits.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes ?? defaultLimits.maxTotalBytes,
  }
  if (
    !Number.isInteger(limits.maxFiles) ||
    !Number.isInteger(limits.maxFileBytes) ||
    !Number.isInteger(limits.maxTotalBytes) ||
    limits.maxFiles < 1 ||
    limits.maxFileBytes < 1 ||
    limits.maxTotalBytes < 1
  )
    throw new SkillCompileError("compiler limits must be positive integers")
  return limits
}

const safeRelativePath = (value: string): string => {
  const normalized = value.trim().replaceAll("\\", "/")
  const segments = normalized.split("/")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    normalized.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new SkillCompileError(`unsafe artifact path: ${value}`)
  return normalized
}

const fileDigest = (content: string) => createHash("sha256").update(content, "utf8").digest("hex")

const assertExperience = (experience: AgentRuntime.ExperienceRecord) => {
  if (!experience.reusable || !String(experience.runID).startsWith("run_") || experience.evidenceIDs.length === 0)
    throw new SkillCompileError("compiler requires reusable verified Experience records with evidence")
}

const scan = (files: ReadonlyArray<CompilerFile>): SecurityScan => {
  const findings: ScanFinding[] = []
  const secretPatterns: ReadonlyArray<[string, RegExp]> = [
    ["secret-token", /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/],
    ["authorization", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i],
    ["credential-assignment", /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]/i],
  ]
  const commandPatterns: ReadonlyArray<[string, RegExp]> = [
    ["child-process", /\b(?:child_process|execFile|spawn|fork)\b/],
    ["shell-execution", /\b(?:powershell|cmd\.exe|bash\s+-c|sh\s+-c|rm\s+-rf)\b/i],
  ]
  const networkPatterns: ReadonlyArray<[string, RegExp]> = [
    ["network-url", /\bhttps?:\/\//i],
    ["network-client", /\b(?:fetch|axios|WebSocket|net\.connect|Invoke-WebRequest)\b/i],
  ]
  for (const file of files) {
    const content = file.content
    for (const [rule, pattern] of secretPatterns) {
      if (pattern.test(content))
        findings.push({ kind: "secret", path: file.path, rule, detail: "secret-like content detected" })
    }
    if (file.path.startsWith("scripts/")) {
      for (const [rule, pattern] of commandPatterns) {
        if (pattern.test(content))
          findings.push({ kind: "command", path: file.path, rule, detail: "unsafe command execution detected" })
      }
      for (const [rule, pattern] of networkPatterns) {
        if (pattern.test(content))
          findings.push({ kind: "network", path: file.path, rule, detail: "network access detected" })
      }
    }
  }
  const digest = canonicalHash(findings) ?? ""
  return Object.freeze({ passed: findings.length === 0, findings: Object.freeze(findings), digest })
}

const normalizeTest = (value: CompilerTestCase): DeterministicTest => {
  const id = value.id.trim()
  if (!id) throw new SkillCompileError("test case ID is required")
  const digest = canonicalHash({ id, input: value.input, expected: value.expected })
  if (!digest) throw new SkillCompileError(`test case is not canonicalizable: ${id}`)
  return { testID: `st_${digest.slice(0, 24)}`, input: value.input, expected: value.expected, digest }
}

const encodeSkill = (skill: SkillContract.Skill) => ({
  ...skill,
  skillID: String(skill.skillID),
  digest: skill.digest,
  sourceExperienceIDs: skill.sourceExperienceIDs.map(String),
  ...(skill.evaluationID === undefined ? {} : { evaluationID: String(skill.evaluationID) }),
  createdAt: DateTime.toEpochMillis(skill.createdAt),
  updatedAt: DateTime.toEpochMillis(skill.updatedAt),
})

export function compileSkillArtifact(
  input: CompileInput,
  options: Omit<SkillCompilerOptions, "root"> = {},
): CompiledArtifact {
  const limits = compilerLimits(options)
  if (input.experiences.length === 0) throw new SkillCompileError("at least one verified Experience is required")
  input.experiences.forEach(assertExperience)
  const assets = (input.assets ?? []).map((file) => ({ ...file, path: safeRelativePath(`assets/${file.path}`) }))
  const scripts = (input.scripts ?? []).map((file) => ({ ...file, path: safeRelativePath(`scripts/${file.path}`) }))
  const files = [{ path: "SKILL.md", content: input.instructions }, ...assets, ...scripts]
  if (files.length > limits.maxFiles) throw new SkillCompileError("candidate contains too many files")
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0)
  if (files.some((file) => Buffer.byteLength(file.content, "utf8") > limits.maxFileBytes))
    throw new SkillCompileError("candidate file exceeds the size limit")
  if (totalBytes > limits.maxTotalBytes) throw new SkillCompileError("candidate exceeds total size limit")
  const security = scan(files)
  if (!security.passed)
    throw new SkillCompileError(
      `candidate security scan failed: ${security.findings.map((item) => item.rule).join(", ")}`,
    )
  const tests = input.testCases.map(normalizeTest)
  if (tests.length === 0) throw new SkillCompileError("candidate requires deterministic tests")
  if (new Set(tests.map((test) => test.testID)).size !== tests.length)
    throw new SkillCompileError("candidate contains duplicate deterministic tests")
  const experienceIDs = input.experiences.map((experience) => String(experience.id))
  const skill = createCandidate({
    skillID: input.skillID,
    version: input.version,
    purpose: input.purpose,
    triggers: input.triggers,
    allowedTools: input.allowedTools,
    allowedCapabilities: input.allowedCapabilities,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    instructionRefs: [{ path: "SKILL.md", digest: fileDigest(input.instructions) }],
    assetRefs: assets.map((file) => ({ path: file.path, digest: fileDigest(file.content) })),
    scriptRefs: scripts.map((file) => ({
      path: file.path,
      digest: fileDigest(file.content),
    })),
    sourceExperienceIDs: experienceIDs,
    testIDs: tests.map((test) => test.testID),
    evaluationID: input.evaluationID,
    policyVersion: input.policyVersion,
    now: input.now,
  })
  const evaluationRequest = {
    status: "pending" as const,
    candidateDigest: skill.digest,
    ...(skill.evaluationID === undefined ? {} : { evaluationID: String(skill.evaluationID) }),
    testIDs: tests.map((test) => test.testID),
  }
  const approvalRequest = {
    status: "pending" as const,
    candidateDigest: skill.digest,
    requiredActor: "human" as const,
  }
  const manifest = {
    schemaVersion: 1,
    skill: encodeSkill(skill),
    files: files.map((file) => ({
      path: file.path,
      digest: fileDigest(file.content),
      bytes: Buffer.byteLength(file.content, "utf8"),
    })),
    tests,
    security,
    evaluationRequest,
    approvalRequest,
  }
  return { skill, files, tests, scan: security, manifest, evaluationRequest, approvalRequest }
}

export class SkillCompiler {
  readonly root: string
  readonly limits: CompilerLimits

  constructor(options: SkillCompilerOptions) {
    this.root = resolve(options.root)
    this.limits = compilerLimits(options)
    if (!this.root) throw new SkillCompileError("candidate store root is required")
    mkdirSync(this.root, { recursive: true })
  }

  compile(input: CompileInput): CompiledCandidate {
    const artifact = compileSkillArtifact(input, this.limits)
    const { files, manifest, scan: security, skill, tests } = artifact
    const candidatePath = join(this.root, "candidates", String(skill.skillID), skill.version)
    this.persist(candidatePath, manifest, files)
    return {
      skill,
      candidatePath,
      tests,
      scan: security,
      evaluationRequest: artifact.evaluationRequest,
      approvalRequest: artifact.approvalRequest,
    }
  }

  private persist(path: string, manifest: Record<string, unknown>, files: ReadonlyArray<CompilerFile>): void {
    const manifestPath = join(path, "manifest.json")
    if (existsSync(manifestPath)) {
      const existing: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
      const existingSkill =
        typeof existing === "object" && existing !== null ? Reflect.get(existing, "skill") : undefined
      const existingDigest =
        typeof existingSkill === "object" && existingSkill !== null ? Reflect.get(existingSkill, "digest") : undefined
      const expectedDigest =
        typeof manifest.skill === "object" && manifest.skill !== null
          ? Reflect.get(manifest.skill, "digest")
          : undefined
      if (existingDigest !== expectedDigest)
        throw new SkillCompileError("candidate path already contains a different artifact")
      return
    }
    mkdirSync(path, { recursive: true })
    for (const file of files) {
      const target = join(path, file.path)
      mkdirSync(resolve(target, ".."), { recursive: true })
      writeFileSync(target, file.content, { encoding: "utf8", flag: "wx" })
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  }
}
