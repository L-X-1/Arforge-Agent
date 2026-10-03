import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("authenticated artifact route resolves a receipt without exposing a path", async () => {
  const root = mkdtempSync(join(tmpdir(), "arforge-artifact-route-"))
  const databasePath = join(root, "arforge.db")
  const home = join(root, "home")
  const workspace = join(root, "workspace")
  mkdirSync(workspace)

  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "artifact-route-child.ts"), databasePath, home, workspace],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          ARFORGE_DB: databasePath,
          ARFORGE_DISABLE_CHANNEL_DB: "1",
          ARFORGE_HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`artifact route child failed (${exitCode}): ${stderr || stdout}`)
    expect(stdout).toContain("artifact-route-ok")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
