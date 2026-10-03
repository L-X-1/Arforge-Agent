import { describe, expect, it } from "bun:test"
import * as ContextPackage from "@arforge-ai/core/context-package"

const units = [
  {
    id: "system-rules",
    origin: "instruction" as const,
    authority: "runtime-input" as const,
    contextLayer: "authority" as const,
    trust: "trusted" as const,
    text: "Follow project safety rules.",
    mandatory: true,
    priority: 100,
    sourceID: "project:rules",
  },
  {
    id: "objective",
    origin: "request" as const,
    authority: "runtime-input" as const,
    contextLayer: "current_request" as const,
    trust: "trusted" as const,
    text: "Implement Context Package compiler.",
    mandatory: true,
    priority: 100,
    protectedFacts: ["Context Package compiler"],
  },
  {
    id: "memory",
    origin: "memory" as const,
    authority: "governed-memory" as const,
    contextLayer: "recalled_memory" as const,
    trust: "untrusted-memory" as const,
    text: "A recalled preference.",
    mandatory: false,
    priority: 20,
    selectionScore: 0.9,
  },
  {
    id: "history",
    origin: "interaction" as const,
    authority: "runtime-input" as const,
    contextLayer: "recent_history" as const,
    trust: "trusted" as const,
    text: "A long recent turn that may be omitted.",
    mandatory: false,
    priority: 1,
    selectionScore: 0.1,
  },
]

describe("ContextPackage", () => {
  it("compiles mandatory and selected context in source order with a digest-bound manifest", () => {
    const first = ContextPackage.compile({ model: "deepseek-v4-flash", usableInputTokens: 25, units, protectedFacts: ["Context Package compiler"] })
    const second = ContextPackage.compile({ model: "deepseek-v4-flash", usableInputTokens: 25, units, protectedFacts: ["Context Package compiler"] })
    expect(first).toEqual(second)
    expect(first.messages.map((message) => message.unitID)).toEqual(["system-rules", "objective", "memory"])
    expect(first.manifest.find((item) => item.unitID === "history")?.omissionReason).toBe("budget_exceeded")
    expect(first.protectedFactCoverage.complete).toBe(true)
    expect(first.usedInputTokens).toBeLessThanOrEqual(25)
    expect(ContextPackage.verify(first)).toBe(first)
    expect(ContextPackage.serialize(first)).toContain(first.digest)
    expect(() => {
      ;(first.messages[0] as { text: string }).text = "mutated"
    }).toThrow()
  })

  it("fails closed when mandatory context cannot fit", () => {
    expect(() => ContextPackage.compile({ model: "model", usableInputTokens: 1, units })).toThrow("Mandatory context")
  })

  it("detects tampering in messages, omissions, or manifest", () => {
    const value = ContextPackage.compile({ model: "model", usableInputTokens: 100, units })
    expect(() => ContextPackage.verify({ ...value, messages: [{ ...value.messages[0], text: "tampered" }] })).toThrow("digest mismatch")
    expect(() => ContextPackage.verify({ ...value, omissions: [{ unitID: "fake", reason: "budget_exceeded", tokens: 1 }] })).toThrow(
      "digest mismatch",
    )
  })
})
