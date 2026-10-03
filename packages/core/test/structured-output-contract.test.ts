import { describe, expect, it } from "bun:test"
import { Prompt, OutputFormat } from "@arforge-ai/schema/prompt"
import { Schema } from "effect"

describe("structured-output durable contract", () => {
  it("decodes a browser-safe JSON Schema format with a bounded retry default", () => {
    const format = Schema.decodeUnknownSync(OutputFormat)({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    })
    expect(format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
      retryCount: 2,
    })
    expect(Object.getPrototypeOf(format)).toBe(Object.prototype)
  })

  it("preserves format through Prompt construction and rejects invalid retry/JSON values", () => {
    const prompt = Schema.decodeUnknownSync(Prompt)({
      text: "return one answer",
      format: {
        type: "json_schema",
        schema: { type: "object", additionalProperties: false },
        retryCount: 1,
      },
    })
    expect(Prompt.fromUserMessage(prompt)).toEqual(prompt)
    expect(() =>
      Schema.decodeUnknownSync(OutputFormat)({
        type: "json_schema",
        schema: { type: "object" },
        retryCount: -1,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(OutputFormat)({
        type: "json_schema",
        schema: { type: "object", invalid: undefined },
      }),
    ).toThrow()
  })
})
