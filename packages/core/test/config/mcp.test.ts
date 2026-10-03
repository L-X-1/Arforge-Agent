import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMCP } from "../../src/config/mcp"
import { ConfigMCPV1 } from "../../src/v1/config/mcp"
import { ConfigV1 } from "../../src/v1/config/config"
import { ConfigMigrateV1 } from "../../src/v1/config/migrate"

test("MCP timeout phases survive the runtime projection and canonical writer migration", () => {
  const timeout = { startup: 6000, request: 250 }
  const canonical = { type: "local" as const, command: ["fixture"], timeout }
  const projection = ConfigMCPV1.fromCanonical(canonical)
  expect(projection).toMatchObject({ timeout })
  const input = Schema.decodeUnknownSync(ConfigV1.Info)({
    experimental: { mcp_timeout: { startup: 8000, request: 500 } },
    mcp: { fixture: projection },
  })
  expect(ConfigMigrateV1.migrate(input).mcp).toMatchObject({
    timeout: { startup: 8000, request: 500 },
    servers: { fixture: canonical },
  })
})

test("legacy numeric server timeouts retain both phases while a global numeric override remains request-only", () => {
  const migrated = ConfigMigrateV1.migrate({
    experimental: { mcp_timeout: 500 },
    mcp: { fixture: { type: "remote", url: "https://fixture.invalid", timeout: 250 } },
  })
  expect(migrated.mcp).toMatchObject({
    timeout: { request: 500 },
    servers: { fixture: { timeout: { startup: 250, request: 250 } } },
  })
})

test("one MCP timeout resolver applies each phase's server, global and built-in precedence", () => {
  expect(ConfigMCP.resolveTimeouts()).toEqual({ startup: 30_000, request: 30_000 })
  expect(ConfigMCP.resolveTimeouts({ request: 250 }, { startup: 6000, request: 500 })).toEqual({
    startup: 6000,
    request: 250,
  })
  expect(ConfigMCP.resolveTimeouts({ startup: 1000 }, { request: 500 })).toEqual({ startup: 1000, request: 500 })
  const source = { startup: 1000, request: 500 }
  const resolved = ConfigMCP.resolveTimeouts(source)
  source.startup = 2000
  expect(resolved).toEqual({ startup: 1000, request: 500 })
  expect(Object.isFrozen(resolved)).toBe(true)
})
