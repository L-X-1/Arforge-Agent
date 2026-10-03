import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge agent-metrics Python compatibility (TS Core owner)", () => {
  cliIt.concurrent(
    "reports profile-local quality metrics without opening a project instance",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Bun.write(
            join(home, "dogfood.jsonl"),
            `${JSON.stringify({ task: "success", success: true, tool_calls: 4, modified_files: 0 })}\n${JSON.stringify({ task: "failure", success: false, tool_calls: 2, modified_files: 0 })}\n`,
          ),
        )
        const result = yield* arforge.spawn(["agent-metrics", "--json"])
        arforge.expectExit(result, 0, "agent-metrics report")
        const payload = JSON.parse(result.stdout)
        expect(payload.metrics.success_rate).toMatchObject({ value: 0.5, n: 2, source: "dogfood" })
        expect(payload.metrics.avg_tool_calls).toMatchObject({ value: 3, n: 2 })
        expect(payload.sources.dogfood).toEqual({ status: "ok", rows: 2 })
        expect(payload.gates).toEqual({ formal_dogfood: "insufficient_evidence", longitudinal_dogfood: "insufficient_evidence" })
        expect(result.stderr).toBe("")
      }),
    30_000,
  )

  cliIt.concurrent(
    "records, lists and clears history through one bounded command owner",
    ({ arforge }) =>
      Effect.gen(function* () {
        const recorded = yield* arforge.spawn(["agent-metrics", "record", "--json", "--limit", "10"])
        arforge.expectExit(recorded, 0, "agent-metrics record")
        expect(JSON.parse(recorded.stdout)).toMatchObject({ count: 1, items: [{ schema_version: 1 }] })

        const history = yield* arforge.spawn(["agent-metrics", "history", "--json", "--limit", "10"])
        arforge.expectExit(history, 0, "agent-metrics history")
        expect(JSON.parse(history.stdout)).toMatchObject({ count: 1, items: [{ schema_version: 1 }] })

        const cleared = yield* arforge.spawn(["agent-metrics", "--clear", "--json"])
        arforge.expectExit(cleared, 0, "agent-metrics clear")
        expect(JSON.parse(cleared.stdout)).toEqual({ cleared_rows: 1 })

        const invalid = yield* arforge.spawn(["agent-metrics", "history", "--limit", "0", "--json"])
        arforge.expectExit(invalid, 1, "agent-metrics invalid limit")
        expect(invalid.stdout).toBe("")
        expect(invalid.stderr).toContain("--limit")
      }),
    30_000,
  )
})
