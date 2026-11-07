import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("legacy layout owners and FileProvider use the real DOM/client boundaries", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--conditions=browser",
      "--rerun-every",
      "--preload",
      "./happydom.ts",
      "./src/pages/layout/legacy-boundaries.isolated.ts",
    ],
    cwd: resolve(import.meta.dir, "../../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
  expect(stdout + stderr).toContain("7 pass")
}, 30000)
