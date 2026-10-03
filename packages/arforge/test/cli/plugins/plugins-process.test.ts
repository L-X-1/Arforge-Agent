import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { cliIt } from "../../lib/cli-process"

const manifest = {
  name: "legacy-tools",
  version: "1.0.0",
  description: "A small declarative compatibility fixture.",
  tools: [],
}

describe("arforge plugins compatibility alias (TS Core owner)", () => {
  cliIt.concurrent(
    "routes the Python plural spelling and no-action default to the same list owner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const pluginRoot = join(home, ".arforge", "plugins", "legacy-tools")
        yield* Effect.promise(() => mkdir(pluginRoot, { recursive: true }))
        yield* Effect.promise(() => Bun.write(join(pluginRoot, "plugin.json"), JSON.stringify(manifest)))

        const canonical = yield* arforge.spawn(["plugin-manager", "list", "--workspace", home, "--json"])
        const legacy = yield* arforge.spawn(["plugins", "list", "--workspace", home, "--json"])
        const defaulted = yield* arforge.spawn(["plugins", "--workspace", home, "--json"])
        arforge.expectExit(canonical, 0, "canonical plugin list")
        arforge.expectExit(legacy, 0, "legacy plugin list")
        arforge.expectExit(defaulted, 0, "legacy plugin default list")
        expect(JSON.parse(legacy.stdout)).toEqual(JSON.parse(canonical.stdout))
        expect(JSON.parse(defaulted.stdout)).toEqual(JSON.parse(canonical.stdout))
        expect(JSON.parse(legacy.stdout).items).toContainEqual(
          expect.objectContaining({ name: "legacy-tools", managed: true, enabled: true }),
        )
      }),
    60_000,
  )

  cliIt.concurrent(
    "maps the historical root and install/update spellings without bypassing the typed owner",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const pluginRoot = join(home, ".arforge", "plugins")
        yield* Effect.promise(() => mkdir(join(pluginRoot, "legacy-tools"), { recursive: true }))
        yield* Effect.promise(() => Bun.write(join(pluginRoot, "legacy-tools", "plugin.json"), JSON.stringify(manifest)))

        const rooted = yield* arforge.spawn(["plugins", "list", pluginRoot, "--json"])
        const canonical = yield* arforge.spawn(["plugin-manager", "list", "--workspace", home, "--json"])
        arforge.expectExit(rooted, 0, "legacy rooted plugin list")
        arforge.expectExit(canonical, 0, "canonical rooted plugin list")
        expect(JSON.parse(rooted.stdout)).toEqual(JSON.parse(canonical.stdout))

        const installMissingTarget = yield* arforge.spawn(["plugins", "install", "--json"])
        arforge.expectExit(installMissingTarget, 1, "legacy install missing source")
        expect(installMissingTarget.stdout).toBe("")
        expect(installMissingTarget.stderr).toContain("install 操作需要 [target]")

        const unsupportedRoot = yield* arforge.spawn(["plugins", "list", join(home, "arbitrary-root"), "--json"])
        arforge.expectExit(unsupportedRoot, 2, "legacy arbitrary plugin root")
        expect(unsupportedRoot.stdout).toBe("")
        expect(unsupportedRoot.stderr).toContain("只支持 <workspace>/.arforge/plugins")
      }),
    60_000,
  )

  cliIt.concurrent(
    "keeps legacy action arguments fail-closed before any mutation or approval request",
    ({ arforge, home }) =>
      Effect.gen(function* () {
        const duplicateName = yield* arforge.spawn([
          "plugins",
          "install",
          "source.zip",
          "legacy-tools",
          "--name",
          "other-tools",
          "--json",
        ])
        arforge.expectExit(duplicateName, 2, "legacy duplicate install name")
        expect(duplicateName.stdout).toBe("")
        expect(duplicateName.stderr).toContain("不能同时使用位置名称和 --name")

        const rootedWithWorkspace = yield* arforge.spawn([
          "plugins",
          "enable",
          "legacy-tools",
          join(home, ".arforge", "plugins"),
          "--workspace",
          home,
        ])
        arforge.expectExit(rootedWithWorkspace, 2, "legacy root plus workspace")
        expect(rootedWithWorkspace.stdout).toBe("")
        expect(rootedWithWorkspace.stderr).toContain("不能同时使用")
      }),
    30_000,
  )
})
