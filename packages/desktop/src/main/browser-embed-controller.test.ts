import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("production browser controller preserves geometry freshness and lifecycle guards", async () => {
  // Electron boundary doubles must never leak into the rest of Desktop's units.
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "./test/browser-embed-controller.fixture.ts"],
    cwd: resolve(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const deadline = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 })
  } finally {
    clearTimeout(deadline)
  }
}, 15000)
