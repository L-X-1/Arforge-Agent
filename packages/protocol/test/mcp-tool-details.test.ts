import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Mcp } from "@arforge-ai/schema/mcp"
import { ToolDetailsQuery } from "../src/groups/mcp"

describe("MCP cached tool inspection contract", () => {
  test("requires exact source capability and nonnegative integral generation", () => {
    const decode = Schema.decodeUnknownSync(ToolDetailsQuery)
    const query = {
      location: { directory: "E:/owned/workspace" },
      server: "owned",
      capabilityID: "owned_lookup",
      generation: 2,
    }
    expect(decode(query)).toEqual(query)
    for (const invalid of [
      { ...query, server: "" },
      { ...query, capabilityID: "" },
      { ...query, generation: -1 },
      { ...query, generation: 1.5 },
    ]) {
      expect(() => decode(invalid)).toThrow()
    }
    const { generation: _, ...missing } = query
    expect(() => decode(missing)).toThrow()
  })

  test("retains the actual complete JSON definition without admitting transport objects", () => {
    const capability: Mcp.Capability = {
      id: "owned_lookup",
      server: "owned",
      kind: "tool",
      generation: 2,
      name: "lookup",
      permission: "mcp",
      patterns: ["owned"],
    }
    const definition = {
      name: "lookup",
      title: "Owned lookup",
      description: "<literal>& detailed text",
      inputSchema: { type: "object", properties: { count: { type: "integer", maximum: 17 } }, required: ["count"] },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      _meta: { advertised: "kept" },
    }
    const decode = Schema.decodeUnknownSync(Mcp.ToolDetails)
    expect(decode({ capability, definition })).toEqual({ capability, definition })
    expect(() => decode({ capability, definition: { request: () => undefined } })).toThrow()
    expect(() => decode({ capability, definition: { endpoint: undefined } })).toThrow()
  })
})
