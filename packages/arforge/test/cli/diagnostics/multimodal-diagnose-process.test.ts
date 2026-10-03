import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge multimodal-diagnose compatibility entry (TS Core owner)", () => {
  cliIt.concurrent(
    "runs bounded local error diagnosis from a real CLI process without writes or model calls",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const text =
          'Traceback (most recent call last):\n  File "src/app.py", line 12, in main\nNameError: token is not defined'
        const result = yield* arforge.spawn([
          "multimodal-diagnose",
          "diagnostic.txt",
          "--workspace",
          home,
          "--text",
          text,
          "--mode",
          "error",
          "--limit",
          "3",
          "--json",
        ])
        arforge.expectExit(result, 0, "multimodal-diagnose JSON")
        expect(result.stderr).toBe("")
        const report = JSON.parse(result.stdout) as {
          schemaVersion: number
          localOnly: boolean
          modelCalls: number
          mode: string
          success: boolean
          path: string
          source: { type: string; success: boolean; path: string }
          signals: Array<{ kind: string; value: string; line?: number }>
          matches: unknown[]
          summary: { textChars: number; signals: number; matches: number }
        }
        expect(report).toMatchObject({
          schemaVersion: 1,
          localOnly: true,
          modelCalls: 0,
          mode: "error",
          success: true,
          path: "diagnostic.txt",
          source: { type: "provided_text", success: true, path: "diagnostic.txt" },
        })
        expect(report.signals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "file_line", value: "src/app.py", line: 12 }),
            expect.objectContaining({ kind: "exception", value: "NameError" }),
          ]),
        )
        expect(report.matches.length).toBeLessThanOrEqual(3)
        expect(report.summary.textChars).toBe(text.length)
        expect(report.summary.signals).toBe(report.signals.length)
        expect(report.summary.matches).toBe(report.matches.length)
        expect(yield* Effect.promise(() => Bun.file(join(home, "diagnostic.txt")).exists())).toBe(false)

        const human = yield* arforge.spawn([
          "multimodal-diagnose",
          "diagnostic.txt",
          "--workspace",
          home,
          "--text",
          text,
          "--mode",
          "error",
          "--limit",
          "1",
        ])
        arforge.expectExit(human, 0, "multimodal-diagnose human")
        expect(human.stdout).toContain("Multimodal diagnosis")
        expect(human.stdout).toContain("模型调用 0")
        expect(human.stdout).toContain("NameError")

        const invalidLimit = yield* arforge.spawn([
          "multimodal-diagnose",
          "diagnostic.txt",
          "--workspace",
          home,
          "--text",
          text,
          "--limit",
          "0",
          "--json",
        ])
        arforge.expectExit(invalidLimit, 1, "multimodal-diagnose invalid limit")
        expect(invalidLimit.stdout).toBe("")
        expect(invalidLimit.stderr).toContain("--limit")

        const escaped = yield* arforge.spawn([
          "multimodal-diagnose",
          "../outside.txt",
          "--workspace",
          home,
          "--text",
          text,
          "--json",
        ])
        arforge.expectExit(escaped, 1, "multimodal-diagnose path boundary")
        expect(escaped.stdout).toBe("")
        expect(escaped.stderr).toContain("Invalid diagnostic path")
        expect(escaped.stderr).toContain("relative_escape")
      }),
    180_000,
  )
})
