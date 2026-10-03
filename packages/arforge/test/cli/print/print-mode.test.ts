import { describe, expect, it } from "bun:test"
import { PassThrough } from "node:stream"
import {
  PrintModeInputError,
  PrintModeRenderer,
  isPrintRetryableError,
  parsePrintStreamMessages,
  resolvePrintMessages,
} from "../../../src/cli/cmd/print-mode"

function sink() {
  return new PassThrough()
}

function textOf(stream: PassThrough) {
  return stream.read()?.toString("utf8") ?? ""
}

describe("TS print compatibility contract", () => {
  it("parses ordered stream-json user messages and text parts", () => {
    expect(
      parsePrintStreamMessages(
        '{"role":"user","content":"hello"}\n\n{"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}\n',
      ),
    ).toEqual(["hello", "ab"])
    expect(() => parsePrintStreamMessages('{"role":"assistant","content":"no"}')).toThrow(PrintModeInputError)
    expect(() => parsePrintStreamMessages('{"role":"user","content":[{"type":"image","url":"x"}]}')).toThrow(
      /content part 1/,
    )
  })

  it("combines text stdin once and rejects empty or oversized input", () => {
    expect(resolvePrintMessages("text", "hello", "world")).toEqual(["hello\nworld"])
    expect(() => resolvePrintMessages("text", "", "   ")).toThrow(/non-empty/)
    expect(() => resolvePrintMessages("stream-json", "", "{bad" )).toThrow(/invalid JSONL/)
  })

  it("emits final-only text without tool diagnostics", () => {
    const stdout = sink()
    const stderr = sink()
    const renderer = new PrintModeRenderer({ outputFormat: "text", finalMessageOnly: true, stdout, stderr })
    renderer.beginTurn()
    renderer.text("answer")
    renderer.toolCalled("call-1", "read_file", { path: "x", token: "secret-value" })
    renderer.toolCompleted("call-1", "contents", false)
    renderer.finish()
    expect(textOf(stdout)).toBe("answer\n")
    expect(textOf(stderr)).toBe("")
  })

  it("emits stream-json assistant/tool records with redacted bounded arguments", () => {
    const stdout = sink()
    const stderr = sink()
    const renderer = new PrintModeRenderer({ outputFormat: "stream-json", finalMessageOnly: false, stdout, stderr })
    renderer.beginTurn()
    renderer.text("before")
    renderer.toolCalled("call-1", "read_file", { path: "x", token: "secret-value" })
    renderer.toolCompleted("call-1", "contents", false)
    renderer.text("after")
    renderer.finish()

    const records = textOf(stdout)
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line))
    expect(records).toEqual([
      { role: "assistant", content: "before" },
      {
        role: "assistant",
        tool_calls: [
          {
            type: "function",
            id: "call-1",
            function: { name: "read_file", arguments: '{"path":"x","token":"[REDACTED_SECRET]"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "contents", is_error: false },
      { role: "assistant", content: "after" },
    ])
    expect(textOf(stderr)).toBe("")
  })

  it("classifies transient provider failures as retryable exit 75", () => {
    expect(isPrintRetryableError({ code: "RATE_LIMITED", message: "try later" })).toBe(true)
    expect(isPrintRetryableError({ data: { message: "provider returned 503" } })).toBe(true)
    expect(isPrintRetryableError({ code: "INVALID_INPUT", message: "bad request" })).toBe(false)
  })
})
