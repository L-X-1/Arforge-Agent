import { expect, test } from "bun:test"
import type { ConfigUpdateData, McpAddData, McpLocalConfig } from "../src/v2/gen/types.gen"

test("generated config and MCP add requests share the explicit read dependency field", () => {
  const config = {
    type: "local",
    command: ["fixture"],
    read_only_paths: ["../依赖 目录"],
    timeout: { startup: 12000, request: 1500 },
  } satisfies McpLocalConfig
  const edit = { mcp: { library: config } } satisfies NonNullable<ConfigUpdateData["body"]>
  const add = { name: "library", config } satisfies NonNullable<McpAddData["body"]>
  expect(edit.mcp.library.read_only_paths).toEqual(add.config.read_only_paths)
  expect(edit.mcp.library.timeout).toEqual(add.config.timeout)
})
