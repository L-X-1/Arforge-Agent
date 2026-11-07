import { describe, expect, test } from "bun:test"
import { createMcpToolDetailsApi, decodeMcpToolDetails } from "./mcp-tool-api"
import { Location } from "@arforge-ai/schema/location"
import { AbsolutePath } from "@arforge-ai/schema/schema"
import { ProjectID } from "@arforge-ai/schema/project-id"

const response = () => ({
  location: { directory: "E:/owned", project: { id: "project-owned", directory: "E:/owned" } },
  data: {
    capability: {
      id: "owned_lookup",
      server: "owned",
      kind: "tool" as const,
      generation: 3,
      name: "lookup",
      permission: "mcp",
      patterns: ["owned"],
    },
    definition: {
      name: "lookup",
      description: "<literal>& text",
      inputSchema: { type: "object", properties: { count: { type: "integer", maximum: 17 } } },
      annotations: { readOnlyHint: true },
    },
  },
})
const expectedResponse = () => ({
  ...response(),
  location: new Location.Info({
    directory: AbsolutePath.make("E:/owned"),
    project: { id: ProjectID.make("project-owned"), directory: AbsolutePath.make("E:/owned") },
  }),
})

describe("MCP tool details JSON boundary", () => {
  test("retains exact source, capability, schema and literal advertised text", () => {
    expect(decodeMcpToolDetails(response())).toEqual(expectedResponse())
  })

  test("rejects malformed output without reflecting server-controlled values", () => {
    const malformed = { ...response(), data: { private: "do-not-echo-private-value" } }
    expect(() => decodeMcpToolDetails(malformed)).toThrow("Invalid MCP tool details response")
    try {
      decodeMcpToolDetails(malformed)
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo-private-value")
    }
  })

  test("keeps request source/options and cancellation signal with the generated owner", async () => {
    const request = {
      location: { directory: "E:/owned" },
      server: "owned",
      capabilityID: "owned_lookup",
      generation: 3,
    }
    const controller = new AbortController()
    const options = { signal: controller.signal }
    let observed: unknown[] = []
    const api = createMcpToolDetailsApi({
      toolDetails: async (...args) => {
        observed = args
        return response()
      },
    })
    expect(await api.toolDetails(request, options)).toEqual(expectedResponse())
    expect(observed).toEqual([request, options])
    expect((observed[1] as typeof options).signal).toBe(controller.signal)
  })

  test("propagates transport failure instead of returning an empty descriptor", async () => {
    const error = new Error("Owned unavailable")
    const api = createMcpToolDetailsApi({
      toolDetails: async () => {
        throw error
      },
    })
    await expect(api.toolDetails({ server: "owned", capabilityID: "owned_lookup", generation: 3 })).rejects.toBe(error)
  })
})
