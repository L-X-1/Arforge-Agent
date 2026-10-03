import { describe, expect, test } from "bun:test"
import { allowlistedChildEnvironment } from "@arforge-ai/core/secret-environment"

describe("allowlistedChildEnvironment", () => {
  test("does not leak ambient secrets to a third-party child process", () => {
    const environment = allowlistedChildEnvironment(
      {
        PATH: "C:/Windows/System32;C:/Tools",
        SYSTEMROOT: "C:/Windows",
        TEMP: "C:/Temp",
        LANG: "zh_CN.UTF-8",
        ARFORGE_SECRET_MASTER_KEY: "must-not-leak",
        ARFORGE_AUTH_CONTENT: "must-not-leak",
        PROVIDER_API_KEY: "must-not-leak",
        UNRELATED_PARENT_VALUE: "must-not-leak",
      },
      { MCP_API_TOKEN: "explicit-server-token" },
    )

    expect(environment).toEqual({
      PATH: "C:/Windows/System32;C:/Tools",
      SYSTEMROOT: "C:/Windows",
      TEMP: "C:/Temp",
      LANG: "zh_CN.UTF-8",
      MCP_API_TOKEN: "explicit-server-token",
    })
  })

  test("preserves ordinary configured values but never injects control-plane secrets", () => {
    const environment = allowlistedChildEnvironment(
      { Path: "C:/Inherited" },
      {
        PATH: "C:/Configured",
        ARFORGE_SECRET_MASTER_KEY: "explicit-server-value",
        EMPTY_OVERRIDE: undefined,
      },
    )

    expect(environment).toEqual({
      PATH: "C:/Configured",
    })
  })
})
