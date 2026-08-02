import { describe, expect, test } from "bun:test"
import { reasoningLevel, reasoningProfile, subagentOrchestrationPrompt } from "./reasoning-profile"

describe("reasoning profile", () => {
  test("normalizes provider variant names into one orchestration policy", () => {
    expect(reasoningLevel()).toBe("default")
    expect(reasoningLevel("reasoning-low")).toBe("default")
    expect(reasoningLevel("MED")).toBe("default")
    expect(reasoningLevel("thinking_high")).toBe("high")
    expect(reasoningLevel("xhigh")).toBe("max")
    expect(reasoningLevel("provider-specific")).toBe("default")
  })

  test("maps the three thinking modes to mascot forms without count quotas", () => {
    expect(reasoningProfile().mascotForm).toBe(1)
    expect(reasoningProfile("high").mascotForm).toBe(2)
    expect(reasoningProfile("max").mascotForm).toBe(3)
    expect(reasoningProfile("max")).not.toHaveProperty("maxParallelSubagents")
    expect(reasoningProfile("max")).not.toHaveProperty("preferredSubagents")
  })

  test("makes deeper modes progressively more aggressive", () => {
    const high = subagentOrchestrationPrompt({ variant: "high", background: true, child: false })
    const max = subagentOrchestrationPrompt({ variant: "max", background: true, child: false })
    expect(high).toContain("Proactively decompose")
    expect(max).toContain("Aggressively decompose")
    expect(max).toContain("real task tool")
    expect(max).toContain("rather than a fixed Subagent count")
    expect(max).not.toContain("budget")
  })

  test("keeps child Sessions controlled by the Main Agent", () => {
    const prompt = subagentOrchestrationPrompt({ variant: "max", background: true, child: true })
    expect(prompt).toContain("controlled by the Main Agent")
    expect(prompt).toContain("does not participate")
  })
})
