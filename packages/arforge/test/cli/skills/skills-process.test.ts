import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

describe("arforge skills compatibility alias (TS Core owner)", () => {
  cliIt.concurrent(
    "routes plural Python spelling to the same list and deterministic route owner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const root = join(home, "legacy-skills")
        yield* Effect.promise(() => mkdir(join(root, "writer"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(
            join(root, "writer", "SKILL.md"),
            "---\nid: writer\nname: writer\ndescription: Drafts short technical notes.\n---\n",
          ),
        )
        const env = { ARFORGE_SKILL_PATHS: root }

        const canonical = yield* arforge.spawn(["skill", "list", "--workspace", home, "--json"], { env })
        const legacy = yield* arforge.spawn(["skills", "--workspace", home, "--json"], { env })
        arforge.expectExit(canonical, 0)
        arforge.expectExit(legacy, 0)
        const canonicalData = JSON.parse(canonical.stdout) as { items: Array<{ id: string }>; count: number }
        const legacyData = JSON.parse(legacy.stdout) as { items: Array<{ id: string }>; count: number }
        expect(legacyData).toEqual(canonicalData)
        expect(legacyData.items).toContainEqual(expect.objectContaining({ id: "writer" }))

        const routed = yield* arforge.spawn(
          ["skills", "route", "修复这个崩溃问题并验证", "--workspace", home, "--json"],
          { env },
        )
        arforge.expectExit(routed, 0)
        expect(JSON.parse(routed.stdout)).toMatchObject({
          mode: expect.any(String),
          relationship: expect.stringContaining("OpenSpec"),
          selected: expect.arrayContaining(["superpowers"]),
        })
        expect(routed.stdout).not.toContain("Python")
      }),
    60_000,
  )

  cliIt.concurrent(
    "keeps alias input errors explicit before any state change",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const missingRoute = yield* arforge.spawn(["skills", "route", "--workspace", home, "--json"])
        arforge.expectExit(missingRoute, 1)
        expect(missingRoute.stdout).toBe("")
        expect(missingRoute.stderr).toContain("route 操作需要请求文本")

        const extraList = yield* arforge.spawn(["skills", "list", "unexpected", "--workspace", home])
        arforge.expectExit(extraList, 1)
        expect(extraList.stderr).toContain("list 操作不接受额外位置参数")

        const missingID = yield* arforge.spawn(["skills", "disable", "--workspace", home])
        arforge.expectExit(missingID, 1)
        expect(missingID.stderr).toContain("disable 操作需要 [skill-id]")
      }),
    30_000,
  )
})
