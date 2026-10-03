import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge feedback compatibility entry (TS Core/Server owner)", () => {
  cliIt.concurrent(
    "shares redacted feedback and linked learning across CLI processes",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const workspace = home
        const otherWorkspace = path.join(home, "other-workspace")
        yield* Effect.promise(() => mkdir(otherWorkspace, { recursive: true }))
        const at = ["--workspace", workspace]
        const spawn = (args: string[]) =>
          arforge.spawn(args, {
            env: {
              // A file proves that independent CLI processes use one Core
              // store. The default test preload intentionally uses :memory:.
              ARFORGE_DB: path.join(home, "feedback.db"),
              ARFORGE_DB_URL: "",
              ARFORGE_DB_ADMIN_URL: "",
            },
          })

        const initial = yield* spawn(["feedback", ...at, "--json"])
        arforge.expectExit(initial, 0)
        expect(JSON.parse(initial.stdout)).toMatchObject({ total: 0, storedLocally: true })

        const secret = `sk-${"S".repeat(38)}`
        const submitted = yield* spawn([
          "feedback",
          "submit",
          "bug",
          "2",
          "Search",
          "missed",
          "a",
          "symbol",
          "with",
          `api_key=${secret}`,
          ...at,
          "--json",
        ])
        arforge.expectExit(submitted, 0)
        const first = JSON.parse(submitted.stdout) as {
          feedback: { id: string; category: string; rating: number; message: string; learningOutcomeID?: string }
        }
        expect(first.feedback.id).toMatch(/^fdb_\d/)
        expect(first.feedback).toMatchObject({ category: "bug", rating: 2 })
        expect(first.feedback.message).not.toContain(secret)
        expect(first.feedback.message).toContain("[REDACTED_SECRET]")
        expect(first.feedback.learningOutcomeID).toMatch(/^lout_\d/)

        const second = yield* spawn([
          "feedback",
          "submit",
          "--category",
          "feature",
          "--rating",
          "5",
          "--message",
          "Add a compact report",
          ...at,
          "--json",
        ])
        arforge.expectExit(second, 0)
        expect(JSON.parse(second.stdout)).toMatchObject({ feedback: { category: "feature", rating: 5 } })

        const listed = yield* spawn(["feedback", "list", "bug", "--limit", "10", ...at, "--json"])
        arforge.expectExit(listed, 0)
        expect(JSON.parse(listed.stdout)).toMatchObject({ category: "bug", count: 1, total: 1 })

        const summary = yield* spawn(["feedback", "summary", ...at, "--json"])
        arforge.expectExit(summary, 0)
        expect(JSON.parse(summary.stdout)).toMatchObject({ total: 2, averageRating: 3.5 })

        const isolated = yield* spawn(["feedback", "summary", "--workspace", otherWorkspace, "--json"])
        arforge.expectExit(isolated, 0)
        expect(JSON.parse(isolated.stdout)).toMatchObject({ total: 0 })

        const deleted = yield* spawn(["feedback", "delete", "--feedback-id", first.feedback.id, ...at, "--json"])
        arforge.expectExit(deleted, 0)
        expect(JSON.parse(deleted.stdout)).toMatchObject({ feedbackID: first.feedback.id, deleted: true, status: "deleted" })

        const repeated = yield* spawn(["feedback", "delete", first.feedback.id, ...at, "--json"])
        arforge.expectExit(repeated, 0)
        expect(JSON.parse(repeated.stdout)).toMatchObject({ feedbackID: first.feedback.id, deleted: false, status: "not_found" })

        const human = yield* spawn(["feedback", "list", ...at])
        arforge.expectExit(human, 0)
        expect(human.stdout).toContain("反馈列表")
        expect(human.stdout).toContain("feature")
        expect(human.stdout).not.toContain(secret)
      }),
    120_000,
  )

  cliIt.concurrent(
    "keeps the old positional syntax and explicit option syntax mutually clear",
    ({ arforge }) =>
      Effect.gen(function* () {
        const mixed = yield* arforge.spawn([
          "feedback",
          "submit",
          "bug",
          "2",
          "positional message",
          "--category",
          "feature",
        ])
        arforge.expectExit(mixed, 1)
        expect(mixed.stderr).toContain("位置参数")

        const missing = yield* arforge.spawn(["feedback", "submit", "--category", "bug", "--rating", "2"])
        arforge.expectExit(missing, 1)
        expect(missing.stderr).toContain("非空文本")

        const invalidRating = yield* arforge.spawn(["feedback", "submit", "bug", "6", "bad rating"])
        arforge.expectExit(invalidRating, 1)
        expect(invalidRating.stderr).toContain("rating 必须是 1 到 5")

        const invalidLimit = yield* arforge.spawn(["feedback", "list", "--limit", "0"])
        arforge.expectExit(invalidLimit, 1)
        expect(invalidLimit.stderr).toContain("--limit 必须是 1 到 100")

        const invalidDelete = yield* arforge.spawn(["feedback", "delete", "legacy-python-uuid"])
        arforge.expectExit(invalidDelete, 1)
        expect(invalidDelete.stderr).toContain("fdb_")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects control characters and oversized messages before mutation",
    ({ arforge }) =>
      Effect.gen(function* () {
        const control = yield* arforge.spawn(["feedback", "submit", "other", "4", "bad\u0001message"])
        arforge.expectExit(control, 1)
        expect(control.stderr).toContain("控制字符")

        const oversized = yield* arforge.spawn(["feedback", "submit", "other", "4", "x".repeat(2_001)])
        arforge.expectExit(oversized, 1)
        expect(oversized.stderr).toContain("最多 2000")
      }),
    60_000,
  )
})
