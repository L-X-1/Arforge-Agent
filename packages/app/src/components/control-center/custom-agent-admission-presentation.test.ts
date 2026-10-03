import { describe, expect, test } from "bun:test"
import { parseCustomAgentAdmission } from "./custom-agent-admission-presentation"

const admitted = {
  schema_version: 1,
  count: 1,
  items: [
    {
      role: "CustomAgent.review",
      status: "admitted",
      decision: "admitted",
      reason: "profile is ready",
      descriptor_digest: "a".repeat(64),
      checks: { status_consistent: true, payload_free: true },
      declared_tool_count: 2,
      canonical_tool_count: 2,
      unsupported_tool_count: 0,
      valid: true,
      violations: [],
      system_prompt: "must never be surfaced",
    },
  ],
  errors: [],
  truncated: false,
}

describe("custom-agent admission presentation", () => {
  test("keeps the bounded, payload-free receipt projection", () => {
    expect(parseCustomAgentAdmission(admitted)).toEqual({
      schema_version: 1,
      count: 1,
      items: [
        {
          role: "CustomAgent.review",
          status: "admitted",
          decision: "admitted",
          reason: "profile is ready",
          descriptor_digest: "a".repeat(64),
          checks: { status_consistent: true, payload_free: true },
          declared_tool_count: 2,
          canonical_tool_count: 2,
          unsupported_tool_count: 0,
          valid: true,
          violations: [],
        },
      ],
      errors: [],
      truncated: false,
    })
  })

  test("fails closed for malformed items while retaining bounded file errors", () => {
    const result = parseCustomAgentAdmission({
      schema_version: 1,
      count: 2,
      items: [{ role: "bad", decision: "admitted" }, admitted.items[0]],
      errors: [{ file: "broken.json", error: "invalid profile" }, { file: "", error: "ignored" }],
      truncated: true,
    })
    expect(result?.items).toHaveLength(1)
    expect(result?.errors).toEqual([{ file: "broken.json", error: "invalid profile" }])
    expect(result?.truncated).toBe(true)
  })
})
