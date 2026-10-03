import { describe, expect, test } from "bun:test"
import {
  capabilityPermission,
  McpCapabilityRegistry,
  safeCapabilityReference,
  type McpCapabilityInput,
} from "../../src/mcp/capability-registry"

const entry = (overrides: Partial<McpCapabilityInput> = {}): McpCapabilityInput => ({
  id: "demo_search",
  server: "demo",
  kind: "tool",
  generation: 1,
  name: "search",
  permission: "demo_search",
  patterns: ["*"],
  ...overrides,
})

describe("MCP capability registry", () => {
  test("replaces a kind deterministically and keeps other kinds", () => {
    const registry = new McpCapabilityRegistry()
    registry.activate("demo", 1)
    expect(registry.replace("demo", 1, "tool", [entry()])).toBe(true)
    expect(
      registry.replace("demo", 1, "resource", [
        entry({
          id: "demo:file",
          kind: "resource",
          name: "file",
          reference: "file:///tmp/file?token=secret#fragment",
          permission: "read",
          patterns: ["mcp:demo:file:///tmp/file?token=secret"],
        }),
      ]),
    ).toBe(true)

    expect(registry.snapshot()).toHaveLength(2)
    expect(registry.snapshot("tool")[0]?.id).toBe("demo_search")
    expect(registry.snapshot("resource")[0]?.reference).toBe("file:///tmp/file")
    expect(registry.snapshot("resource")[0]?.id).toBe("demo:file:///tmp/file")
    expect(registry.snapshot("resource")[0]?.id).not.toContain("secret")
    expect(registry.snapshot("resource")[0]?.patterns).toEqual(["mcp:demo:file:///tmp/file"])
    expect(() => registry.assertInvariants()).not.toThrow()
  })

  test("rejects stale list responses after a generation swap", () => {
    const registry = new McpCapabilityRegistry()
    registry.replace("demo", 1, "tool", [entry()])
    expect(registry.replace("demo", 2, "tool", [entry({ generation: 2, id: "demo_new" })])).toBe(true)
    expect(registry.replace("demo", 1, "tool", [entry({ id: "demo_stale" })])).toBe(false)
    expect(registry.snapshot().map((item) => item.id)).toEqual(["demo_new"])
    expect(registry.isCurrent("demo_new", 2, "demo", "tool")).toBe(true)
    expect(registry.isCurrent("demo_stale", 1, "demo", "tool")).toBe(false)
  })

  test("keeps sanitized capability IDs unique across servers", () => {
    const registry = new McpCapabilityRegistry()
    registry.replace("first", 1, "tool", [entry({ server: "first", id: "shared" })])
    registry.replace("second", 1, "tool", [entry({ server: "second", id: "shared" })])
    expect(registry.snapshot().map((item) => `${item.server}:${item.id}`)).toEqual(["first:shared"])
    expect(() => registry.assertInvariants()).not.toThrow()
  })

  test("invalidation retains the generation fence and removes stale capabilities", () => {
    const registry = new McpCapabilityRegistry()
    registry.replace("demo", 4, "tool", [entry({ generation: 4 })])
    expect(registry.invalidate("demo", 4)).toBe(true)
    expect(registry.snapshot()).toEqual([])
    expect(registry.replace("demo", 3, "tool", [entry({ generation: 3 })])).toBe(false)
    expect(registry.replace("demo", 5, "tool", [entry({ generation: 5, id: "demo_next" })])).toBe(true)
  })

  test("redacts references and uses the shared permission projection", () => {
    expect(safeCapabilityReference("https://user:secret@example.test/a?token=x#frag")).toBe(
      "https://example.test/a",
    )
    expect(safeCapabilityReference("urn:demo:item?token=x")).toBe("urn:demo:item")
    expect(capabilityPermission("tool", "demo_search", "demo")).toEqual({
      permission: "demo_search",
      patterns: ["*"],
    })
    expect(capabilityPermission("resource", "demo:file", "demo", "file:///tmp/file")).toEqual({
      permission: "read",
      patterns: ["mcp:demo:file:///tmp/file"],
    })
  })
})
