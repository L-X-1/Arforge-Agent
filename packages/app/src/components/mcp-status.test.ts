import { describe, expect, test } from "bun:test"
import { mcpStatusLabelKey, mcpStatusLabelKeys } from "./mcp-status"

describe("MCP status labels", () => {
  test("maps every user-visible MCP status to a translation key", () => {
    expect(Object.keys(mcpStatusLabelKeys)).toEqual([
      "connected",
      "failed",
      "needs_auth",
      "needs_client_registration",
      "needs_approval",
      "disabled",
    ])
    expect(mcpStatusLabelKey("needs_client_registration")).toBe("mcp.status.needs_client_registration")
    expect(mcpStatusLabelKey("needs_approval")).toBe("mcp.status.needs_approval")
  })

  test("fails closed for pending and unknown protocol states", () => {
    expect(mcpStatusLabelKey("pending")).toBeUndefined()
    expect(mcpStatusLabelKey("future_status")).toBeUndefined()
    expect(mcpStatusLabelKey(undefined)).toBeUndefined()
  })
})
