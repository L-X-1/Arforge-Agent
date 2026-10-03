import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as CustomAgentAdmissionInvariant from "../src/runtime/custom-agent-admission-invariant"
import * as RuntimeInvariants from "../src/runtime/invariants"
import { customAgentRuntimeAdmission, parseCustomAgentProfile } from "../src/custom-agent-profile"

const profile = parseCustomAgentProfile(
  {
    schema_version: 1,
    name: "release-reviewer",
    description: "Reviews release changes.",
    system_prompt: "Review the supplied change carefully and report concrete issues with evidence.",
    tools: ["read_file"],
    capabilities: ["code_review"],
    max_steps: 6,
    max_tokens: 2_048,
    timeout_seconds: 45,
  },
  "profiles/review.json",
)

describe("custom-agent admission runtime invariant", () => {
  test("registers once and reports valid and malformed receipts", async () => {
    const previousOptIn = process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
    const previousTrust = process.env.ARFORGE_TRUST_WORKSPACE
    process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = "1"
    process.env.ARFORGE_TRUST_WORKSPACE = "1"
    try {
      const registry = RuntimeInvariants.createRuntimeInvariantRegistry()
      CustomAgentAdmissionInvariant.registerInvariants(registry)
      CustomAgentAdmissionInvariant.registerInvariants(registry)
      expect(registry.list(CustomAgentAdmissionInvariant.OWNER)).toHaveLength(1)

      const admission = customAgentRuntimeAdmission(profile, process.cwd())
      const valid = await Effect.runPromise(CustomAgentAdmissionInvariant.inspect(registry, admission))
      expect(valid).toMatchObject({ checked: 1, skipped: 0, passed: 1, failed: 0, passedAll: true })

      const malformed = { ...admission, ready: false, canonical_tools: [] }
      const invalid = await Effect.runPromise(CustomAgentAdmissionInvariant.inspect(registry, malformed))
      expect(invalid).toMatchObject({ checked: 1, skipped: 0, passed: 0, failed: 1, passedAll: false })
      expect(invalid.results[0]?.reason).toContain("status and admission flags are inconsistent")
    } finally {
      if (previousOptIn === undefined) delete process.env.ARFORGE_ENABLE_CUSTOM_AGENTS
      else process.env.ARFORGE_ENABLE_CUSTOM_AGENTS = previousOptIn
      if (previousTrust === undefined) delete process.env.ARFORGE_TRUST_WORKSPACE
      else process.env.ARFORGE_TRUST_WORKSPACE = previousTrust
    }
  })
})
