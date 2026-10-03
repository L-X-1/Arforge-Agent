import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge replay historical alias (TS Core owner)", () => {
  cliIt.concurrent(
    "shares the run-history report without replaying a provider or tool",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const runs = join(home, "runs")
        mkdirSync(runs, { recursive: true })
        yield* Effect.promise(() =>
          Bun.write(
            join(runs, "run-replay-alias.json"),
            JSON.stringify({
              run_id: "run-replay-alias",
              created: "2026-09-01 10:00:00",
              entries: [{ path: "workspace/note.txt", original: "before" }],
            }),
          ),
        )
        yield* Effect.promise(() =>
          Bun.write(
            join(runs, "run-replay-alias.trace.json"),
            JSON.stringify({
              run_id: "run-replay-alias",
              created: "2026-09-01 10:00:00",
              trace: [{ event: "tool", tool: "read_file", success: true }],
              answer: "already completed",
            }),
          ),
        )

        const canonical = yield* arforge.spawn(["run-history", "run-replay-alias", "--json"], {
          timeoutMs: 60_000,
        })
        arforge.expectExit(canonical, 0, "run-history report")
        const alias = yield* arforge.spawn(["replay", "run-replay-alias", "--json"], { timeoutMs: 60_000 })
        arforge.expectExit(alias, 0, "replay alias report")
        expect(alias.stdout).toBe(canonical.stdout)
        expect(alias.stderr).toBe(canonical.stderr)
        expect(JSON.parse(alias.stdout)).toMatchObject({
          found: true,
          run_id: "run-replay-alias",
          report: {
            schema_version: 1,
            trace_events: 1,
            changed_files: ["workspace/note.txt"],
          },
        })

        const missing = yield* arforge.spawn(["replay", "missing-replay", "--json"], { timeoutMs: 60_000 })
        arforge.expectExit(missing, 0, "replay missing report")
        expect(JSON.parse(missing.stdout)).toMatchObject({
          schema_version: 1,
          found: false,
          run_id: "missing-replay",
          report: null,
        })
      }),
    120_000,
  )
})
