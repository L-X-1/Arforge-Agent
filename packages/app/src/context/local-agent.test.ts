import { describe, expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent, resolveAgentSelection, unavailableAgentReason } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }])?.name).toBe("custom")
  })

  test("never substitutes an explicitly unavailable agent", () => {
    expect(resolveAgent(agents, "owned-r02-review")).toBeUndefined()
    expect(resolveAgent([{ name: "custom" }], "missing")).toBeUndefined()
    expect(resolveAgent([], "missing")).toBeUndefined()
    expect(resolveAgent(agents, "")).toBeUndefined()
    expect(resolveAgent([])).toBeUndefined()
  })
})

describe("explicit Agent selection", () => {
  const build = { name: "build", model: { providerID: "builtin", modelID: "default" } }
  const review = {
    name: "owned-r02-review",
    model: { providerID: "owned", modelID: "review" },
    variant: "high",
    permission: [{ permission: "*", pattern: "*", action: "deny" }],
  }

  test("retains identity through removal, loading empty catalog and re-add without borrowing capabilities", () => {
    const input = Object.freeze({ selected: review.name, fallback: "build" })
    const available = resolveAgentSelection([build, review], input)
    expect(available.current).toBe(review)
    for (const items of [[build], []]) {
      const missing = resolveAgentSelection(items, input)
      expect(missing.current).toBeUndefined()
      expect(missing.selected).toBe(review.name)
      expect(missing.unavailable).toBe(review.name)
    }
    expect(resolveAgentSelection([build, review], input).current).toBe(review)
    expect(input).toEqual({ selected: review.name, fallback: "build" })
    expect(review.variant).toBe("high")
    expect(review.permission[0].action).toBe("deny")
  })

  test("preserves unspecified fallback and separate source selection", () => {
    expect(resolveAgentSelection([review, build], {}).current).toBe(build)
    expect(resolveAgentSelection([review, build], { fallback: review.name }).current).toBe(review)
    expect(resolveAgentSelection([review], { fallback: "build" }).current).toBe(review)
    expect(resolveAgentSelection([build], { fallback: "removed-implicit-default" }).current).toBe(build)
    const other = { selected: "build" }
    expect(resolveAgentSelection([build], { selected: review.name }).current).toBeUndefined()
    expect(resolveAgentSelection([build], other).current).toBe(build)
    expect(other).toEqual({ selected: "build" })
  })

  test("only reports a named unavailable reason after catalog and persisted selection are ready", () => {
    expect(unavailableAgentReason(review.name, false, "en")).toBeUndefined()
    expect(unavailableAgentReason(undefined, true, "en")).toBeUndefined()
    expect(unavailableAgentReason(review.name, true, "en")).toContain(`${review.name}" is unavailable`)
    expect(unavailableAgentReason(review.name, true, "zh-CN")).toContain(review.name)
  })
})
