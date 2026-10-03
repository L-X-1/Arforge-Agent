import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

describe("arforge print compatibility entry (TS run owner)", () => {
  cliIt.concurrent(
    "supports the historical print subcommand with final-only text",
    ({ llm, arforge }) =>
      Effect.gen(function* () {
        yield* llm.text("final answer")
        const result = yield* arforge.spawn(["print", "--model", "test/test-model", "--final-message-only", "hello"])
        arforge.expectExit(result, 0)
        expect(result.stdout).toBe("final answer\n")
        expect(result.stderr).not.toContain("Python")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rewrites --print/-p to the same TypeScript owner",
    ({ llm, arforge }) =>
      Effect.gen(function* () {
        yield* llm.text("legacy spelling answer")
        const result = yield* arforge.spawn(["--print", "-p", "legacy prompt", "--model", "test/test-model"])
        arforge.expectExit(result, 0)
        expect(result.stdout).toBe("legacy spelling answer\n")
      }),
    60_000,
  )

  cliIt.concurrent(
    "accepts multiple stream-json messages in one session and emits assistant records",
    ({ llm, arforge }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().text("first answer"))
        yield* llm.text("second answer")
        const result = yield* arforge.spawn(
          [
            "print",
            "--model",
            "test/test-model",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
          ],
          {
            stdin: '{"role":"user","content":"first"}\n{"role":"user","content":[{"type":"text","text":"second"}]}\n',
          },
        )
        arforge.expectExit(result, 0)
        const records = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(records).toEqual([
          { role: "assistant", content: "first answer" },
          { role: "assistant", content: "second answer" },
        ])
      }),
    90_000,
  )

  cliIt.concurrent(
    "projects one tool call and result into stream-json without a second execution path",
    ({ llm, arforge }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().text("before").tool("bash", {
            command: "printf tool",
          }),
        )
        yield* llm.text("after")
        const result = yield* arforge.spawn(
          [
            "print",
            "--model",
            "test/test-model",
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "tool prompt",
          ],
        )
        arforge.expectExit(result, 0)
        const records = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
        expect(records[0]).toEqual({ role: "assistant", content: "before" })
        expect(records[1]).toMatchObject({
          role: "assistant",
          tool_calls: [
            {
              type: "function",
              function: { name: "bash" },
            },
          ],
        })
        expect(records[2]).toMatchObject({ role: "tool", is_error: false })
        expect(records[3]).toEqual({ role: "assistant", content: "after" })
      }),
    90_000,
  )

  cliIt.concurrent(
    "rejects malformed stream-json before creating a user message",
    ({ arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["print", "--model", "test/test-model", "--input-format", "stream-json"], {
          stdin: '{"role":"assistant","content":"not allowed"}\n',
        })
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("must be a user message object")
      }),
    30_000,
  )
})
