import { expect, test } from "bun:test"
import { decodeMcpToolDetails } from "./mcp-tool-api"
import { matchesMcpToolDetailsSource } from "./mcp-tool-detail-source"
import { WorkspaceID } from "@arforge-ai/schema/workspace-id"

test("tool detail source rejects a foreign server, workspace, capability or generation", () => {
  const workspaceID = WorkspaceID.create()
  const response = decodeMcpToolDetails({
    location: {
      directory: "E:/owned/workspace",
      workspaceID,
      project: { id: "project-a", directory: "E:/owned/workspace" },
    },
    data: {
      capability: {
        id: "owned_lookup",
        server: "owned",
        kind: "tool",
        generation: 2,
        name: "lookup",
        permission: "mcp",
        patterns: ["owned"],
      },
      definition: { name: "lookup", inputSchema: { type: "object" } },
    },
  })
  const request = {
    location: { directory: "E:/owned/workspace", workspace: workspaceID },
    server: "owned",
    capabilityID: "owned_lookup",
    generation: 2,
  }
  expect(matchesMcpToolDetailsSource(response, request)).toBe(true)
  for (const other of [
    { ...request, server: "other" },
    { ...request, capabilityID: "other_lookup" },
    { ...request, generation: 3 },
    { ...request, location: { ...request.location, directory: "E:/other/workspace" } },
    { ...request, location: { ...request.location, workspace: WorkspaceID.create() } },
  ])
    expect(matchesMcpToolDetailsSource(response, other)).toBe(false)
})
