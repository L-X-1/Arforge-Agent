import { describe, expect, test } from "bun:test"
import { defaults, generate } from "./variant"

describe("variant plugin", () => {
  test("configures the official DeepSeek V4 thinking API", () => {
    const model = {
      id: "deepseek-v4-flash",
      api: {
        id: "deepseek-v4-flash",
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://api.deepseek.com",
      },
    } as any

    expect(defaults(model)).toEqual({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    })
    expect(generate(model)).toEqual([
      {
        id: "none",
        headers: {},
        body: { thinking: { type: "disabled" } },
      },
      {
        id: "high",
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      },
      {
        id: "max",
        headers: {},
        body: { thinking: { type: "enabled" }, reasoning_effort: "max" },
      },
    ])
  })
})
