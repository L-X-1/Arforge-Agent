import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

const PATCH = [
  "diff --git a/module.ts b/module.ts",
  "index 1111111..2222222 100644",
  "--- a/module.ts",
  "+++ b/module.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41",
  "+export const answer = 42",
  "",
].join("\n")

describe("arforge quality Python CLI compatibility (TS Core owner)", () => {
  cliIt.concurrent(
    "maps the historical positional patch file to the canonical quality assessment",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(join(home, "module.ts"), "export const answer = 42\n"))
        const patchPath = join(home, "change.diff")
        yield* Effect.promise(() => Bun.write(patchPath, PATCH))

        const legacy = yield* arforge.spawn(["quality", patchPath, "--json"])
        arforge.expectExit(legacy, 0, "legacy quality")
        const legacyData = JSON.parse(legacy.stdout)
        expect(legacyData).toMatchObject({
          workspace: home,
          passed: true,
          score: 100,
          files_checked: 1,
          diff_stats: {
            files: ["module.ts"],
            files_changed: 1,
            additions: 1,
            deletions: 1,
            changed_lines: 2,
            hunks: 1,
          },
        })

        const canonical = yield* arforge.spawn(["quality", "--patch-file", patchPath, "--json"])
        arforge.expectExit(canonical, 0, "canonical quality")
        expect(JSON.parse(canonical.stdout)).toEqual(legacyData)

        const human = yield* arforge.spawn(["quality", patchPath])
        arforge.expectExit(human, 0, "legacy quality human output")
        expect(human.stdout).toContain("Arforge 交付质量：通过")
        expect(human.stdout).toContain("变更：1 个文件，+1/-1，1 个区块")
      }),
    60_000,
  )

  cliIt.concurrent(
    "keeps ordinary source-file quality checks and content-detected patches distinct",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(join(home, "module.ts"), "export const answer = 42\n"))
        const source = yield* arforge.spawn(["quality", "module.ts", "--json"])
        arforge.expectExit(source, 0, "quality source file")
        expect(JSON.parse(source.stdout)).toMatchObject({
          files_checked: 1,
          diff_stats: { files: ["module.ts"], files_changed: 1, changed_lines: 0 },
        })

        const patchPath = join(home, "change")
        yield* Effect.promise(() => Bun.write(patchPath, PATCH))
        const contentDetected = yield* arforge.spawn(["quality", patchPath, "--json"])
        arforge.expectExit(contentDetected, 0, "content-detected quality patch")
        expect(JSON.parse(contentDetected.stdout)).toMatchObject({
          files_checked: 1,
          diff_stats: { files: ["module.ts"], additions: 1, deletions: 1, hunks: 1 },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails a missing legacy patch before producing a quality report",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const result = yield* arforge.spawn(["quality", join(home, "missing.diff"), "--json"])
        arforge.expectExit(result, 2, "missing legacy quality patch")
        expect(result.stdout).toBe("")
        expect(result.stderr).toContain("无法读取补丁")
      }),
    30_000,
  )
})
