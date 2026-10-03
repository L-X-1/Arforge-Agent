import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge learning compatibility entry (TS Core/Server owner)", () => {
  cliIt.concurrent(
    "runs status/record/sync-dogfood/undo through one durable typed contract",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const at = ["--workspace", home]
        const spawn = (args: string[], stdin?: string) =>
          arforge.spawn(args, {
            stdin,
            env: {
              // The preload uses :memory: for isolated unit tests. A file is
              // intentional here: this test proves two CLI processes share
              // the same Core learning store and idempotency fingerprint.
              ARFORGE_DB: path.join(home, "learning.db"),
              ARFORGE_DB_URL: "",
              ARFORGE_DB_ADMIN_URL: "",
            },
          })

        const initial = yield* spawn(["learning", "status", ...at, "--json"])
        arforge.expectExit(initial, 0)
        expect(JSON.parse(initial.stdout)).toMatchObject({ totalTurns: 0, patternCount: 0 })

        const recall = yield* spawn(["learning", "recall", ...at, "--json"])
        arforge.expectExit(recall, 0)
        expect(JSON.parse(recall.stdout)).toMatchObject({
          schema_version: 1,
          execution_mode: "read-only-composition",
          top1_hit_rate: 0,
          pattern_count: 0,
          sample_size: 0,
        })
        const recallHuman = yield* spawn(["learning", "recall", ...at])
        arforge.expectExit(recallHuman, 0)
        expect(recallHuman.stdout).toContain("学习召回质量")
        expect(recallHuman.stdout).toContain("Top-1")
        expect(recallHuman.stdout).toContain("说明：")

        const failed = yield* spawn([
          "learning",
          "record",
          "Diagnose the scheduled prompt state transition",
          "--success=false",
          "--error-type",
          "state_machine",
          "--error-message",
          "transition rejected",
          "--fix-strategy",
          "rebuild the durable transition",
          "--tags",
          "workflow,recovery",
          "--importance",
          "4",
          ...at,
          "--json",
        ])
        arforge.expectExit(failed, 0)
        const failedOutcome = JSON.parse(failed.stdout) as { id: string; success: boolean; tags: string[] }
        expect(failedOutcome.id).toMatch(/^lout_\d/)
        expect(failedOutcome.success).toBe(false)
        expect(failedOutcome.tags).toEqual(["workflow", "recovery"])

        const success = yield* spawn([
          "learning",
          "record",
          "Complete the scheduled prompt state transition",
          "--success=true",
          "--intent",
          "workflow",
          "--token-count",
          "42",
          "--response-time-ms",
          "120",
          ...at,
          "--json",
        ])
        arforge.expectExit(success, 0)
        expect(JSON.parse(success.stdout)).toMatchObject({ success: true, tokenCount: 42, responseTimeMs: 120 })

        const status = yield* spawn(["learning", "status", ...at, "--json"])
        arforge.expectExit(status, 0)
        expect(JSON.parse(status.stdout)).toMatchObject({
          totalTurns: 2,
          successfulTurns: 1,
          failedTurns: 1,
          patternCount: 1,
        })

        const candidate = JSON.stringify([
          {
            task: "Dogfood the scheduled prompt state transition",
            success: false,
            timestamp: "2026-09-01T00:00:00.000Z",
            steps: 3,
            toolCalls: ["workflow", "state"],
            error: "state transition rejected",
          },
        ])
        const imported = yield* spawn(["learning", "sync-dogfood", "--candidates", candidate, ...at, "--json"])
        arforge.expectExit(imported, 0)
        expect(JSON.parse(imported.stdout)).toEqual({ seen: 1, imported: 1, skipped: 0, failedCandidates: 0 })

        const repeated = yield* spawn(["learning", "sync-dogfood", "--stdin", ...at, "--json"], candidate)
        arforge.expectExit(repeated, 0)
        expect(JSON.parse(repeated.stdout)).toEqual({ seen: 1, imported: 0, skipped: 1, failedCandidates: 0 })

        const undone = yield* spawn(["learning", "undo", failedOutcome.id, ...at, "--json"])
        arforge.expectExit(undone, 0)
        expect(JSON.parse(undone.stdout)).toMatchObject({ outcomeID: failedOutcome.id, deleted: true })

        const human = yield* spawn(["learning", "status", ...at])
        arforge.expectExit(human, 0)
        expect(human.stdout).toContain("学习状态")
        expect(human.stdout).toContain("注入影响")
      }),
    120_000,
  )

  cliIt.concurrent(
    "projects the historical dream leaf through the read-only typed owner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const env = {
          ARFORGE_DB: path.join(home, "learning-dream.db"),
          ARFORGE_DB_URL: "",
          ARFORGE_DB_ADMIN_URL: "",
        }
        const result = yield* arforge.spawn(["learning", "dream", "--workspace", home, "--json"], { env })
        arforge.expectExit(result, 0)
        expect(JSON.parse(result.stdout)).toMatchObject({
          executionMode: "read-only-core-projection",
          sideEffects: "none",
          consolidation: { status: "not_run", patternsFound: 0, savedNew: 0, updatedExisting: 0 },
          dream: { totalTurns: 0, totalFailures: 0, totalPatterns: 0, insights: [], suggestions: expect.any(Array) },
        })

        const human = yield* arforge.spawn(["learning", "dream", "--workspace", home])
        arforge.expectExit(human, 0)
        expect(human.stdout).toContain("学习反思（只读）")
        expect(human.stdout).toContain("模式整理：未执行")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects recall writes and leaves the read-only sources untouched",
    ({ arforge }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["learning", "recall", "--success=true"])
        arforge.expectExit(result, 1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("learning recall")
        expect(result.stderr).toContain("只接受 --workspace 和 --json")
      }),
    30_000,
  )

  cliIt.concurrent(
    "rejects missing, ambiguous, malformed, and out-of-range learning input before mutation",
    ({ arforge }) =>
      Effect.gen(function* () {
        const missingSuccess = yield* arforge.spawn(["learning", "record", "a learning outcome"])
        arforge.expectExit(missingSuccess, 1)
        expect(missingSuccess.stderr).toContain("必须显式指定 --success")

        const invalidNumber = yield* arforge.spawn([
          "learning",
          "record",
          "a learning outcome",
          "--success=true",
          "--token-count",
          "-1",
        ])
        arforge.expectExit(invalidNumber, 1)
        expect(invalidNumber.stderr).toContain("--token-count 必须是 0 到 1000000000")

        const ambiguous = yield* arforge.spawn([
          "learning",
          "record",
          "positional input",
          "--user-input",
          "option input",
          "--success=true",
        ])
        arforge.expectExit(ambiguous, 1)
        expect(ambiguous.stderr).toContain("位置参数和 --user-input 中选择一个")

        const malformed = yield* arforge.spawn(["learning", "sync-dogfood", "--candidates", "not-json"])
        arforge.expectExit(malformed, 1)
        expect(malformed.stderr).toContain("不是合法 JSON")
      }),
    60_000,
  )
})
