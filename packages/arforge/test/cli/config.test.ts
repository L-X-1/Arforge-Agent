import { describe, expect, test } from "bun:test"
import { redactConfig } from "../../src/cli/cmd/debug/config"

describe("CLI config diagnostics", () => {
  test("redacts nested credentials and URL passwords while preserving useful settings", () => {
    const result = redactConfig({
      model: "deepseek/deepseek-chat",
      provider: {
        deepseek: {
          options: { apiKey: "sk-live-secret", baseURL: "https://user:password@example.test/v1" },
          headers: { Authorization: "Bearer token-value" },
        },
      },
      mcp: { local: { command: ["node", "server.js"], env: { TOKEN: "secret-value" } } },
      nested: [{ timeout: 10, value: "https://example.test/path" }],
    })

    expect(result).toMatchObject({
      model: "deepseek/deepseek-chat",
      provider: {
        deepseek: {
          options: { apiKey: "[REDACTED]", baseURL: "https://[REDACTED]@example.test/v1" },
          headers: { Authorization: "[REDACTED]" },
        },
      },
      mcp: { local: { env: { TOKEN: "[REDACTED]" } } },
      nested: [{ timeout: 10, value: "https://example.test/path" }],
    })
    expect(JSON.stringify(result)).not.toContain("sk-live-secret")
    expect(JSON.stringify(result)).not.toContain("password@example")
    expect(JSON.stringify(result)).not.toContain("secret-value")
  })

  test("does not treat ordinary words or falsey values as secrets", () => {
    expect(redactConfig({ tokenBudget: 4096, description: "token budget", enabled: false, count: 0 })).toEqual({
      tokenBudget: 4096,
      description: "token budget",
      enabled: false,
      count: 0,
    })
  })
})
