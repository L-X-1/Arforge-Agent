import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("arforge mcp capabilities", () => {
  cliIt.live(
    "explains how to make the capability catalog available",
    ({ arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["mcp", "capabilities"], {
          env: { ARFORGE_CONFIG_CONTENT: JSON.stringify({ mcp: {} }) },
        })
        arforge.expectExit(result, 0)
        expect(result.stdout).toContain("No capabilities are currently available")
        expect(result.stdout).toContain("Connect an MCP server first")
      }),
    30_000,
  )
})
