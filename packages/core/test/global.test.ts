import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@arforge-ai/core/global"

describe("global paths", () => {
  test("tmp path follows the configured profile or the system default", () => {
    const configuredProfile = process.env.ARFORGE_HOME?.trim()
    const expected = configuredProfile
      ? path.join(path.resolve(configuredProfile), "tmp")
      : path.join(os.tmpdir(), "arforge")
    expect(Global.Path.tmp).toBe(expected)
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })

  test("ARFORGE_HOME is the single profile root for runtime state", async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), "arforge-global-profile-"))
    try {
      const childEnvironment: Record<string, string | undefined> = { ...process.env, ARFORGE_HOME: profile }
      delete childEnvironment.ARFORGE_TEST_HOME
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `const { Global } = await import('./src/global.ts'); console.log(JSON.stringify(Global.Path))`,
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: childEnvironment,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode, stderr).toBe(0)
      const paths = JSON.parse(stdout.trim()) as Record<string, string>
      expect(paths.home).toBe(profile)
      expect(paths.data).toBe(profile)
      expect(paths.cache).toBe(path.join(profile, "cache"))
      expect(paths.config).toBe(path.join(profile, "config"))
      expect(paths.state).toBe(path.join(profile, "state"))
      expect(paths.tmp).toBe(path.join(profile, "tmp"))
    } finally {
      await fs.rm(profile, { recursive: true, force: true })
    }
  })
})
