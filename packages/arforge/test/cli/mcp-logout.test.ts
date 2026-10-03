import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

describe("arforge mcp logout (project-scoped OAuth)", () => {
  cliIt.live(
    "uses the configured display name even when no scoped token exists",
    ({ llm, arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["mcp", "logout", "github"], {
          env: {
            ARFORGE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              mcp: {
                github: {
                  type: "remote",
                  // The fixture server responds immediately, so InstanceBootstrap
                  // cannot hold the project/server lock behind an external URL.
                  url: llm.url,
                },
              },
            }),
          },
        })

        arforge.expectExit(result, 0)
        expect(result.stdout).toContain("Removed OAuth credentials for github")
        expect(result.stdout).not.toContain("legacy OAuth credential")
      }),
    30_000,
  )
})
