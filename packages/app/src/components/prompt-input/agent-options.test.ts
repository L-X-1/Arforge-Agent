import { describe, expect, test } from "bun:test"
import { agentMenuOptions } from "./agent-options"

describe("Agent menu catalog projection", () => {
  test("keeps selectable IDs and only exposes supported public catalog fields", () => {
    const catalog = [
      { name: "build", mode: "primary", native: true, description: "Build safely" },
      {
        name: "review", mode: "all", native: false, description: "Long review description\nSecond paragraph",
        permission: [{ permission: "read", pattern: "src/**", action: "allow" }],
        model: { providerID: "owned", modelID: "model-a" }, variant: "careful",
        prompt: "private system prompt", options: { apiKey: "private option" },
      },
      { name: "hidden", mode: "primary", hidden: true },
      { name: "child-only", mode: "subagent" },
    ]
    const options = agentMenuOptions(["build", "review", "not-loaded", "hidden", "child-only"], catalog, "en")
    expect(options.map(option => option.id)).toEqual(["build", "review", "not-loaded"])
    expect(options[1]?.description).toContain("Long review description\nSecond paragraph")
    expect(options[1]?.description).toContain("Source: Configured")
    expect(options[1]?.description).toContain("Mode: all")
    expect(options[1]?.description).toContain("owned/model-a")
    expect(options[1]?.description).toContain("allow · read · src/**")
    expect(options[1]?.description).toContain("careful")
    expect(JSON.stringify(options)).not.toContain("private system prompt")
    expect(JSON.stringify(options)).not.toContain("private option")
    expect(options[2]).toEqual({ id: "not-loaded", label: "not-loaded" })
  })

  test("does not infer a configuration path, privileges or a new selectable Agent", () => {
    const options = agentMenuOptions(["review"], [
      { name: "review", mode: "primary", permission: [] },
      { name: "other-scope", mode: "primary", native: false },
    ], "zh")
    expect(options).toHaveLength(1)
    expect(options[0]?.description).toContain("服务器目录")
    expect(options[0]?.description).toContain("目录权限规则：0")
    expect(options[0]?.description).not.toContain("arforge.json")
    expect(JSON.stringify(options)).not.toContain("other-scope")
  })
})
