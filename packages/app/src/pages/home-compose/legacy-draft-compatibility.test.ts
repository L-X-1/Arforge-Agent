import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("legacy draft route, real Tabs/persistence and model binding stay isolated", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "--conditions=browser",
      "--rerun-every",
      "--preload",
      "./happydom.ts",
      "./src/pages/home-compose/legacy-draft-compatibility.isolated.ts",
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
  expect(stdout + stderr).toContain("10 pass")
}, 15000)
