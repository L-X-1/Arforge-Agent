import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("panel collapse focus keeps all identity and source guards with real browser reactivity", async () => {
  // Default app units use Solid's server exports. Keep browser effects and global DOM isolated.
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--conditions=browser",
      "--rerun-every",
      "--preload",
      "./happydom.ts",
      "./src/pages/session/panel-focus-return.isolated.ts",
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
  expect(stdout + stderr).toContain("23 pass")
  expect(stdout + stderr).toContain("28 expect() calls")
}, 15000)
