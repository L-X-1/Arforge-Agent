import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { AppNodeBuilder } from "@arforge-ai/core/effect/app-node-builder"
import { Global } from "@arforge-ai/core/global"
import { Npm } from "@arforge-ai/core/npm"
import { tmpdir } from "./fixture/tmpdir"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@arforge/acme")).toBe("@arforge/acme")
    expect(Npm.sanitize("@arforge/acme@1.0.0")).toBe("@arforge/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/arforge/acme.git"
    const expected = win ? "acme@git+https_//github.com/arforge/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.add", () => {
  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      main: "index.js",
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.entrypoint).toBeDefined()
  })
})

describe("Npm.install", () => {
  test("updates a bundled SDK file target and repairs a missing installed SDK without losing user config", async () => {
    await using tmp = await tmpdir()
    for (const version of ["1.0.0", "1.0.1"]) {
      const sdk = path.join(tmp.path, `sdk-${version}`)
      await fs.mkdir(sdk)
      await writePackage(sdk, { name: "owned-sdk", version, main: "index.js" })
      await Bun.write(path.join(sdk, "index.js"), `export const version = ${JSON.stringify(version)}`)
    }
    const profile = path.join(tmp.path, "profile")
    await fs.mkdir(profile)
    const config = '{"theme":"dark","customPlugin":"preserved"}'
    await Bun.write(path.join(profile, "arforge.json"), config)
    await Npm.install(profile, { add: [{ name: "owned-sdk", version: `file:${path.join(tmp.path, "sdk-1.0.0")}` }] })
    await Npm.install(profile, { add: [{ name: "owned-sdk", version: `file:${path.join(tmp.path, "sdk-1.0.1")}` }] })
    const installed = path.join(profile, "node_modules", "owned-sdk")
    expect((await Bun.file(path.join(installed, "package.json")).json()).version).toBe("1.0.1")
    await fs.rm(installed, { recursive: true, force: true })
    await Npm.install(profile, { add: [{ name: "owned-sdk", version: `file:${path.join(tmp.path, "sdk-1.0.1")}` }] })
    expect((await Bun.file(path.join(installed, "package.json")).json()).version).toBe("1.0.1")
    expect(await Bun.file(path.join(profile, "arforge.json")).text()).toBe(config)
  })
  test("respects omit from project .npmrc", async () => {
    await using tmp = await tmpdir()

    await writePackage(tmp.path, {
      name: "fixture",
      dependencies: {
        "prod-pkg": "file:./prod-pkg",
      },
      devDependencies: {
        "dev-pkg": "file:./dev-pkg",
      },
    })
    await Bun.write(path.join(tmp.path, ".npmrc"), "omit=dev\n")
    await fs.mkdir(path.join(tmp.path, "prod-pkg"))
    await fs.mkdir(path.join(tmp.path, "dev-pkg"))
    await writePackage(path.join(tmp.path, "prod-pkg"), { name: "prod-pkg" })
    await writePackage(path.join(tmp.path, "dev-pkg"), { name: "dev-pkg" })

    await Npm.install(tmp.path)

    await expect(fs.stat(path.join(tmp.path, "node_modules", "prod-pkg"))).resolves.toBeDefined()
    await expect(fs.stat(path.join(tmp.path, "node_modules", "dev-pkg"))).rejects.toThrow()
  })
})
