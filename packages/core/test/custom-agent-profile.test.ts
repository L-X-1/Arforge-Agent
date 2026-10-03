import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CustomAgentProfileError,
  customAgentRuntimeAdmission,
  customAgentRuntimeAdmissionEvidence,
  customAgentsEnabled,
  customAgentRuntimeMetadata,
  discoverCustomAgentProfiles,
  loadCustomAgentProfile,
  parseCustomAgentProfile,
  customAgentRuntimeDescriptorDigest,
  assertCustomAgentRuntimeAdmission,
  projectCustomAgentRuntime,
  publicProfile,
} from "../src/custom-agent-profile"

const validPayload = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  name: "release-reviewer",
  description: "Reviews release changes against the established engineering policy.",
  system_prompt:
    "Review the supplied change carefully. Report concrete issues with evidence and do not bypass the active permission policy.",
  tools: ["read_file"],
  capabilities: ["code_review"],
  max_steps: 6,
  max_tokens: 2_048,
  timeout_seconds: 45,
  ...overrides,
})

describe("custom agent profile contract", () => {
  test("parses the frozen Python profile shape without executing it", () => {
    const profile = parseCustomAgentProfile(validPayload(), "profiles/review.json")
    expect(publicProfile(profile)).toEqual({
      name: "release-reviewer",
      role: "CustomAgent.release-reviewer",
      description: "Reviews release changes against the established engineering policy.",
      tools: ["read_file"],
      capabilities: ["code_review"],
      max_steps: 6,
      max_tokens: 2_048,
      timeout_seconds: 45,
      path: join(process.cwd(), "profiles/review.json"),
    })
  })

  test("rejects unknown fields, tools and capabilities", () => {
    expect(() => parseCustomAgentProfile({ ...validPayload(), command: "powershell" })).toThrow(
      CustomAgentProfileError,
    )
    expect(() => parseCustomAgentProfile({ ...validPayload(), tools: ["not_a_registered_tool"] })).toThrow(
      "tools contains unsupported values",
    )
    expect(() => parseCustomAgentProfile({ ...validPayload(), capabilities: ["unknown"] })).toThrow(
      "capabilities contains unsupported values",
    )
  })

  test("projects historical tool spellings onto the canonical runtime catalog", () => {
    const profile = parseCustomAgentProfile(
      validPayload({ tools: ["read_file", "grep", "web_search"], capabilities: ["code_review"] }),
      "profiles/review.json",
    )
    expect(projectCustomAgentRuntime(profile)).toEqual({
      role: "CustomAgent.release-reviewer",
      declared_tools: ["read_file", "grep", "web_search"],
      canonical_tools: ["read", "grep", "websearch"],
      unsupported_tools: [],
      ready: true,
    })
    const descriptorDigest = customAgentRuntimeDescriptorDigest(profile)
    if (!descriptorDigest) throw new Error("expected a ready profile descriptor digest")
    expect(descriptorDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(customAgentRuntimeMetadata(profile)).toEqual({
      schema_version: 1,
      provider: "in-process",
      role: "CustomAgent.release-reviewer",
      profile_path: join(process.cwd(), "profiles/review.json"),
      descriptor_digest: descriptorDigest,
      declared_tools: ["read_file", "grep", "web_search"],
      canonical_tools: ["read", "grep", "websearch"],
      capabilities: ["code_review"],
      max_steps: 6,
      max_tokens: 2_048,
      timeout_seconds: 45,
    })
  })

  test("blocks a profile when a historical tool has no canonical owner", () => {
    const profile = parseCustomAgentProfile(validPayload({ tools: ["time"] }), "profiles/review.json")
    expect(projectCustomAgentRuntime(profile)).toMatchObject({
      unsupported_tools: ["time"],
      canonical_tools: [],
      ready: false,
    })
    expect(customAgentRuntimeMetadata(profile)).toBeUndefined()
  })

  test("does not treat inherited manifest properties as canonical tools", () => {
    const profile = parseCustomAgentProfile(
      validPayload({ tools: ["constructor"] }),
      "profiles/prototype.json",
      new Set(["constructor"]),
    )
    expect(projectCustomAgentRuntime(profile)).toMatchObject({
      canonical_tools: [],
      unsupported_tools: ["constructor"],
      ready: false,
    })
  })

  test("discovers valid profiles, reports duplicates, and keeps invalid files data-only", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-custom-agent-"))
    try {
      const directory = join(workspace, ".arforge", "agents")
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, "one.json"), JSON.stringify(validPayload()), "utf8")
      await writeFile(join(directory, "two.json"), JSON.stringify(validPayload({ description: "A separate valid description." })), "utf8")
      await writeFile(join(directory, "broken.json"), "{not-json", "utf8")

      const result = discoverCustomAgentProfiles(workspace)
      expect(result.profiles.map((profile) => profile.name)).toEqual(["release-reviewer"])
      expect(result.errors).toHaveLength(2)
      expect(result.errors.some((item) => item.error.includes("duplicate profile name"))).toBe(true)
      expect(result.errors.some((item) => item.error.includes("invalid profile JSON"))).toBe(true)
      expect(await readFile(join(directory, "one.json"), "utf8")).toContain("release-reviewer")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("enforces profile path containment and explicit trust plus opt-in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-custom-agent-"))
    try {
      const directory = join(workspace, ".arforge", "agents")
      await mkdir(directory, { recursive: true })
      const profilePath = join(directory, "review.json")
      await writeFile(profilePath, JSON.stringify(validPayload()), "utf8")
      expect(loadCustomAgentProfile(profilePath, workspace).name).toBe("release-reviewer")
      expect(() => loadCustomAgentProfile(join(workspace, "outside.json"), workspace)).toThrow(
        "profile must be an existing .json file",
      )

      const previousOptIn = process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
      delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      delete process.env.ARFORGE_TRUST_WORKSPACE
      expect(customAgentsEnabled(workspace)).toBe(false)
      process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = "1"
      expect(customAgentsEnabled(workspace)).toBe(false)
      process.env.ARFORGE_TRUST_WORKSPACE = "1"
      expect(customAgentsEnabled(workspace)).toBe(true)
      if (previousOptIn === undefined) delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      else process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = previousOptIn
      if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
      else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("returns a payload-free admission receipt with fail-closed status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arforge-custom-agent-admission-"))
    const profile = parseCustomAgentProfile(validPayload(), join(workspace, ".arforge", "agents", "review.json"))
    const unsupported = parseCustomAgentProfile(
      validPayload({ tools: ["time"] }),
      join(workspace, ".arforge", "agents", "unsupported.json"),
    )
    const previousOptIn = process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
    const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
    try {
      delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      delete process.env.ARFORGE_TRUST_WORKSPACE
      expect(customAgentRuntimeAdmission(profile, workspace)).toMatchObject({
        status: "opt_in_required",
        workspace_trusted: false,
        opt_in: false,
        ready: false,
      })

      process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = "1"
      expect(customAgentRuntimeAdmission(profile, workspace)).toMatchObject({
        status: "workspace_untrusted",
        workspace_trusted: false,
        opt_in: true,
        ready: false,
      })

      process.env.ARFORGE_TRUST_WORKSPACE = "1"
      const admitted = customAgentRuntimeAdmission(profile, workspace)
      const admittedDigest = admitted.descriptor_digest
      expect(admitted).toMatchObject({
        status: "admitted",
        workspace_trusted: true,
        opt_in: true,
        ready: true,
      })
      expect(admittedDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(admitted).not.toHaveProperty("system_prompt")
      expect(customAgentRuntimeAdmissionEvidence(admitted)).toMatchObject({
        kind: "custom-agent-admission",
        decision: "admitted",
        valid: true,
        checks: {
          status_consistent: true,
          descriptor_digest_consistent: true,
          tool_projection_consistent: true,
          payload_free: true,
        },
        declared_tool_count: 1,
        canonical_tool_count: 1,
        unsupported_tool_count: 0,
      })
      expect(assertCustomAgentRuntimeAdmission(admitted).valid).toBe(true)

      const unsupportedAdmission = customAgentRuntimeAdmission(unsupported, workspace)
      expect(unsupportedAdmission).toMatchObject({
        status: "unsupported_tools",
        ready: false,
        unsupported_tools: ["time"],
      })
      expect(customAgentRuntimeAdmission(profile, workspace, { collision: true })).toMatchObject({
        status: "collision",
        ready: false,
      })

      const malformed = {
        ...admitted,
        ready: false,
        canonical_tools: [],
        descriptor_digest: "not-a-digest",
        system_prompt: "payload must never enter an admission receipt",
      } as unknown as typeof admitted
      const malformedEvidence = customAgentRuntimeAdmissionEvidence(malformed)
      expect(malformedEvidence).toMatchObject({
        status: "admitted",
        decision: "blocked",
        valid: false,
        checks: {
          status_consistent: false,
          descriptor_digest_consistent: false,
          tool_projection_consistent: false,
          payload_free: false,
        },
      })
      expect(malformedEvidence.violations).toHaveLength(4)
      expect(() => assertCustomAgentRuntimeAdmission(malformed)).toThrow("runtime admission invariant failed")
    } finally {
      if (previousOptIn === undefined) delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      else process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = previousOptIn
      if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
      else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
