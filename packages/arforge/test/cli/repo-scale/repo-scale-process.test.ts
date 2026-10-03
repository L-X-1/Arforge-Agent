import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge repo-scale Python CLI compatibility (TS Core owner)", () => {
  cliIt.concurrent(
    "maps the historical positional path and --query syntax to the canonical bounded scanner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const target = join(home, "legacy-repo")
        yield* Effect.promise(() => mkdir(target, { recursive: true }))
        yield* Effect.promise(() => Bun.write(join(target, "index.ts"), "export const legacyNeedle = true\n"))

        const legacy = yield* arforge.spawn([
          "repo-scale",
          target,
          "--query",
          "legacyNeedle",
          "--max-files",
          "10",
          "--limit",
          "5",
          "--json",
        ])
        arforge.expectExit(legacy, 0, "legacy repo-scale")
        const legacyData = JSON.parse(legacy.stdout)
        expect(legacyData).toMatchObject({
          root: resolve(target),
          budget: { max_files: 10 },
          search: { query: "legacyNeedle", total: 1, searched_files: 1 },
        })
        expect(legacyData.search.items).toContainEqual(
          expect.objectContaining({ path: "index.ts", matched_terms: ["legacyneedle"] }),
        )

        const canonical = yield* arforge.spawn([
          "repo-scale",
          "legacyNeedle",
          "--workspace",
          home,
          "--path",
          "legacy-repo",
          "--max-files",
          "10",
          "--limit",
          "5",
          "--json",
        ])
        arforge.expectExit(canonical, 0, "canonical repo-scale")
        expect(JSON.parse(canonical.stdout)).toMatchObject({
          root: resolve(target),
          search: { query: "legacyNeedle", total: 1 },
        })

        const pathOnly = yield* arforge.spawn([
          "repo-scale",
          target,
          "--max-files",
          "10",
          "--limit",
          "5",
          "--json",
        ])
        arforge.expectExit(pathOnly, 0, "legacy repo-scale path only")
        expect(JSON.parse(pathOnly.stdout)).toMatchObject({
          root: resolve(target),
          search: { query: "", total: 0 },
        })

        const human = yield* arforge.spawn(["repo-scale", target, "--query", "legacyNeedle", "--limit", "5"])
        arforge.expectExit(human, 0, "legacy repo-scale human output")
        expect(human.stdout).toContain("Arforge 仓库规模")
        expect(human.stdout).toContain("legacyNeedle")
      }),
    60_000,
  )

  cliIt.concurrent(
    "rejects ambiguous legacy path and canonical --path combinations before scanning",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const target = join(home, "legacy-repo")
        const result = yield* arforge.spawn([
          "repo-scale",
          target,
          "--query",
          "needle",
          "--path",
          "other",
          "--json",
        ])
        arforge.expectExit(result, 1, "repo-scale ambiguous path")
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("位置扫描路径、--query 与 --path 不能同时使用")
      }),
    30_000,
  )
})
