import { Schema } from "effect"
import { Location } from "@arforge-ai/schema/location"
import { Mcp } from "@arforge-ai/schema/mcp"
import type { Arforge } from "@arforge-ai/sdk-next/remote"

type Api = ReturnType<typeof Arforge.make>["mcp"]
const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Location.response(Mcp.ToolDetails)))

export function decodeMcpToolDetails(value: unknown) {
  try {
    return decode(value)
  } catch {
    // Parse diagnostics can contain server-controlled data; do not echo them.
    throw new Error("Invalid MCP tool details response")
  }
}

export function createMcpToolDetailsApi(api: Pick<Api, "toolDetails">) {
  return {
    toolDetails: async (...args: Parameters<Api["toolDetails"]>) =>
      decodeMcpToolDetails(await api.toolDetails(...args)),
  }
}
