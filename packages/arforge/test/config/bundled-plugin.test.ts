import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildPluginSDK } from "../../script/plugin-sdk"
import { pluginDependencyVersion } from "../../src/config/dependency"
import { Npm } from "@arforge-ai/core/npm"

test("bundled public SDK bootstraps offline and imports through plain Node outside the checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "arforge-bundled-sdk-"))
  const previous = { ...process.env }
  try {
    const sdk = path.join(root, "resources", "plugin-sdk")
    await buildPluginSDK(sdk, "1.0.0")
    const pkg = JSON.parse(await readFile(path.join(sdk, "package.json"), "utf8"))
    const original = JSON.parse(await readFile(new URL("../../../plugin/package.json", import.meta.url), "utf8"))
    expect(Object.keys(pkg.exports)).toEqual(Object.keys(original.exports))
    expect(pkg.version).toBe("1.0.0")
    expect(
      Object.values(pkg.dependencies).every((value) => typeof value === "string" && !value.includes("workspace:")),
    ).toBe(true)
    const profile = path.join(root, "normal-empty-config")
    await mkdir(profile)
    const npmrc = path.join(root, "empty.npmrc")
    await writeFile(npmrc, "")
    Object.assign(process.env, {
      NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
      NPM_CONFIG_USERCONFIG: npmrc,
      NPM_CONFIG_GLOBALCONFIG: npmrc,
      NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    })
    // Intentionally no package/lock/node_modules or dummy provider seed.
    await Npm.install(profile, {
      add: [
        {
          name: "@arforge-ai/plugin",
          version: pluginDependencyVersion({ bundled: sdk, local: false, version: "1.0.0" }),
        },
      ],
    })
    const script = path.join(profile, "public-exports.mjs")
    await writeFile(
      script,
      `
      import assert from 'node:assert/strict';
      import { tool } from '@arforge-ai/plugin';
      import { tool as direct } from '@arforge-ai/plugin/tool';
      import { createBindingLookup } from '@arforge-ai/plugin/tui';
      import { define } from '@arforge-ai/plugin/v2/effect';
      import '@arforge-ai/plugin/v2/effect/integration';
      import '@arforge-ai/plugin/v2/effect/plugin';
      import { define as promiseDefine } from '@arforge-ai/plugin/v2/promise';
      const item = tool({ description: 'owned fixture', args: { value: tool.schema.string() }, execute: async ({value}) => value });
      assert.equal(await item.execute({value:'offline'}, {}), 'offline');
      assert.equal(typeof direct.schema.object, 'function');
      assert.equal(typeof createBindingLookup, 'function');
      const effect = {id:'owned', effect:()=>{}};
      assert.equal(define(effect), effect);
      assert.equal(typeof promiseDefine, 'function');
      console.log('all-public-exports-offline');
    `,
    )
    const node = Bun.which("node")
    if (!node) throw new Error("Existing Node executable required for SDK compatibility regression")
    const child = Bun.spawn([node, script], {
      cwd: profile,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "/usr/bin",
        HOME: root,
        USERPROFILE: root,
      },
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(stdout.trim()).toBe("all-public-exports-offline")
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
