import { describe, expect, test } from "bun:test"
import { matchesModelSearch, modelSearchRank } from "./dialog-select-model-search"

describe("matchesModelSearch", () => {
  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("does not match unrelated searches", () => {
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })

  test("requires every word while allowing words across display name, ID and provider", () => {
    const fields = ["GPT-5.5", "deployment/production", "OpenAI"]
    expect(matchesModelSearch("  OPENAI  gpt production ", fields)).toBe(true)
    expect(matchesModelSearch("openai claude", fields)).toBe(false)
    expect(matchesModelSearch("production GPT", fields)).toBe(true)
  })

  test("ranks display-name prefixes before names and other fields", () => {
    expect(modelSearchRank("gpt", "GPT-5.5")).toBe(0)
    expect(modelSearchRank("gpt", "Production GPT-5.5")).toBe(1)
    expect(modelSearchRank("gpt", "Production deployment")).toBe(2)
  })
})
